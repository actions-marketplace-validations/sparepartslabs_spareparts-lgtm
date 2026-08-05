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
 * SECURITY: the `workflow_run` half is privileged and handles data derived from
 * a fork. It must never check out or execute anything from that fork. Here the
 * only fork-derived input is the event payload and the diff, both treated
 * strictly as data — the diff is sent to a model, never run. Do not add a
 * checkout step to the privileged workflow.
 */

import { readFile } from 'node:fs/promises';

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
async function resolveEvent(): Promise<{ name: string; payload: unknown }> {
  const relayed = process.env.LGTM_RELAYED_EVENT;
  if (relayed) {
    const raw = JSON.parse(await readFile(relayed, 'utf8')) as {
      event_name?: string;
      payload?: unknown;
    };
    if (!raw.event_name || raw.payload === undefined) {
      throw new Error('Relayed event artifact is malformed.');
    }
    return { name: raw.event_name, payload: raw.payload };
  }

  const path = required('GITHUB_EVENT_PATH');
  return {
    name: required('GITHUB_EVENT_NAME'),
    payload: JSON.parse(await readFile(path, 'utf8')),
  };
}

export async function main(): Promise<void> {
  const { name, payload } = await resolveEvent();
  const [owner, repo] = required('GITHUB_REPOSITORY').split('/');

  const context: ActionContext = {
    // ProbotOctokit rather than a bare Octokit so the handlers keep the
    // `.config` plugin they use to read `.github/lgtm.yml`.
    octokit: new ProbotOctokit({ auth: { token: required('GITHUB_TOKEN') } }),
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

// A thrown error must fail the job loudly. The check run is created before any
// model work starts, so a crash here leaves a visible neutral check rather than
// a silent nothing — but the job should still go red so the log gets read.
await main().catch((err) => {
  console.error('[error] lgtm failed', err);
  process.exitCode = 1;
});
