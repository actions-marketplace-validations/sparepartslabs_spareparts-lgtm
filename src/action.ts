/**
 * GitHub Action entry point.
 *
 * The same handlers as the App (`app.ts`), driven by a workflow run instead of
 * a webhook. What changes is only how the event and the credentials arrive.
 *
 * WHY AN ACTION AT ALL: as an App, every quiz on every installation is billed
 * to whoever runs the server. As an Action, each repository supplies its own
 * `ANTHROPIC_API_KEY`, so adoption costs the adopter and the diff never leaves
 * their infrastructure. It also deletes FR-002's worker requirement outright —
 * a workflow has no ten-second budget, so generation runs inline.
 *
 * WHY TWO WORKFLOWS: measured, not assumed. On a pull request from a fork,
 * a `pull_request_review` workflow gets NO secrets and a read-only token, so it
 * cannot generate a quiz or post a check. A `workflow_run` workflow chained off
 * it does get both. `issue_comment` gets them directly and needs no relay.
 *
 *   event                  | fork PR: secrets + write token
 *   -----------------------|-------------------------------
 *   pull_request_review    | no   → must relay via workflow_run
 *   issue_comment          | yes  → runs directly
 *
 * SECURITY: the `workflow_run` half is privileged and handles fork-derived data.
 * Two rules, both learned the hard way:
 *
 *   1. It never checks out or executes anything from the fork. The diff is sent
 *      to a model, never run. Do not add a checkout step for a fork ref.
 *   2. It does not trust the relayed artifact. `pull_request_review` workflows
 *      run from the PR's HEAD branch — measured, not assumed — so on a fork PR
 *      the fork supplies the collector that writes that artifact. A forged one
 *      could name a reviewer who never approved. `resolveEvent` therefore takes
 *      only a PR number from it and re-reads everything else from the API.
 *
 * A consequence of that same head-branch rule: a fork can delete the collector
 * and no quiz is generated for its PR. That fails in the safe direction — with
 * `enforce: true` the required check simply never appears, so the PR is blocked
 * rather than waved through.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { ProbotOctokit } from 'probot';

import {
  onCommentCreated,
  onHeadMoved,
  onQuizCommentEdited,
  onReviewSubmitted,
} from './app.ts';

/**
 * The slice of Probot's `Context` the handlers actually use. Assembling it by
 * hand is what lets one set of handlers serve both entry points.
 */
/** The two octokit methods `resolveEvent` needs, so it can be tested. */
export interface OctokitLike {
  rest: {
    pulls: {
      get(args: unknown): Promise<{ data: { head: { sha: string } } }>;
      listReviews: unknown;
    };
  };
  paginate(
    route: unknown,
    args: unknown,
  ): Promise<{ state: string; commit_id?: string }[]>;
}

interface ActionContext {
  octokit: unknown;
  payload: unknown;
  repo(): { owner: string; repo: string };
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/** Structured-ish logging that reads sensibly in the Actions log viewer. */
function line(level: string) {
  return (...args: unknown[]) => {
    const [first, second] = args;
    const message = typeof first === 'string' ? first : second ?? '';
    const detail = typeof first === 'string' ? second : first;
    const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`;
    console.log(`[${level}] ${String(message)}${suffix}`);
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The event this run should act on.
 *
 * Direct runs read the payload GitHub wrote to disk. A `workflow_run` run is
 * about the *previous* workflow, so its own payload is useless — the real event
 * is in the artifact the collector uploaded, and `LGTM_RELAYED_EVENT` points at
 * where the workflow unpacked it.
 */
export async function resolveEvent(
  octokit: OctokitLike,
  owner: string,
  repo: string,
): Promise<{ name: string; payload: unknown } | null> {
  const relayed = process.env.LGTM_RELAYED_EVENT;
  if (!relayed) {
    const path = required('GITHUB_EVENT_PATH');
    return {
      name: required('GITHUB_EVENT_NAME'),
      payload: JSON.parse(await readFile(path, 'utf8')),
    };
  }

  // THE ARTIFACT IS UNTRUSTED.
  //
  // `pull_request_review` workflows run from the PR's HEAD branch — measured,
  // not assumed — so on a fork PR the *fork* supplies the collector that wrote
  // this file. Its contents are attacker-controlled: a forged payload could
  // name a reviewer who never approved, or point at an unrelated PR.
  //
  // So the artifact contributes exactly one thing — a PR number, which is a
  // hint, not evidence — and everything acted upon is re-read from the API
  // with our own token. If the API does not show a real approval on that PR,
  // there is nothing to do.
  const raw = JSON.parse(await readFile(relayed, 'utf8')) as {
    payload?: { pull_request?: { number?: unknown } };
  };
  const claimed = raw.payload?.pull_request?.number;
  if (typeof claimed !== 'number' || !Number.isInteger(claimed) || claimed < 1) {
    console.log('[warn] relayed artifact names no usable pull request');
    return null;
  }

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: claimed,
  });
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: claimed,
    per_page: 100,
  });

  // The most recent approval that is still current for this head. Reviews are
  // returned oldest-first, so the last match wins.
  const approval = reviews
    .filter((r) => r.state === 'APPROVED' && r.commit_id === pr.head.sha)
    .pop();

  if (!approval) {
    console.log(`[info] no current approval on #${claimed} — nothing to confirm`);
    return null;
  }

  // Rebuilt from API data only. Nothing from the artifact survives except the
  // number we used to look it up.
  //
  // `state` is lowercased because the two sources disagree: the REST API says
  // "APPROVED", webhook payloads say "approved", and the handlers are written
  // against the webhook shape. Reconstructing from the API therefore has to
  // translate, not just copy — a mismatch here fails the handler's very first
  // guard and returns silently, which is exactly how it was found.
  return {
    name: 'pull_request_review',
    payload: {
      action: 'submitted',
      review: { ...approval, state: String(approval.state).toLowerCase() },
      pull_request: pr,
    },
  };
}

export async function main(): Promise<void> {
  const [owner, repo] = required('GITHUB_REPOSITORY').split('/');
  // ProbotOctokit rather than a bare Octokit so the handlers keep the
  // `.config` plugin they use to read `.github/lgtm.yml`.
  const octokit = new ProbotOctokit({ auth: { token: required('GITHUB_TOKEN') } });

  const event = await resolveEvent(octokit as unknown as OctokitLike, owner, repo);
  if (!event) return;
  const { name, payload } = event;

  const context: ActionContext = {
    octokit,
    payload,
    repo: () => ({ owner, repo }),
    log: { info: line('info'), warn: line('warn'), error: line('error') },
  };

  const action = (payload as { action?: string }).action;
  const dispatch = `${name}.${action ?? ''}`;

  // Cast at the boundary: the handlers are typed against Probot's Context, and
  // what we assembled is that shape minus the parts they never touch.
  const ctx = context as never;

  switch (dispatch) {
    case 'pull_request_review.submitted':
      return onReviewSubmitted(ctx);
    case 'issue_comment.edited':
      return onQuizCommentEdited(ctx);
    case 'issue_comment.created':
      return onCommentCreated(ctx);
    case 'pull_request.synchronize':
      return onHeadMoved(ctx);
    default:
      console.log(`[info] nothing to do for ${dispatch}`);
  }
}

// Run only when executed directly, never on import. Without this guard the
// tests trip it just by importing `resolveEvent`, which is also the signal that
// a module doing work at import time is the wrong shape regardless of tests.
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  // A thrown error must fail the job loudly. The check run is created before
  // any model work starts, so a crash leaves a visible neutral check rather
  // than a silent nothing — but the job should still go red so the log is read.
  await main().catch((err) => {
    console.error('[error] lgtm failed', err);
    process.exitCode = 1;
  });
}
