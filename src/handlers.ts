/**
 * What LGTM does, independent of how it was invoked.
 *
 * `action.ts` is the only entry point: it turns a workflow run into the
 * Probot-Context shape these handlers expect and dispatches. There used to be
 * a second entry point — a hosted GitHub App — and it was deleted rather than
 * maintained, because as an Action each repository supplies its own model key
 * and there is no server to run.
 *
 * `probot` survives as a *library* here, not a framework: `ProbotOctokit` for
 * an Octokit that carries the config plugin, and `Context` for the webhook
 * payload types that give every handler below its type safety. Nothing starts
 * a Probot server any more.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Context } from 'probot';

import { ask, hasWriteAccess, parseMention, renderAnswer } from './ask.ts';
import {
  explainConcepts,
  renderConcepts,
  MAX_CONCEPTS,
} from './concepts.ts';
import { DEFAULTS, parseConfig, type Config } from './config.ts';
import { generateFromDiff, type GenerateResult } from './generator.ts';
import { ProviderError, resolve, type Provider } from './providers.ts';
import { screen } from './questions.ts';
import { collect, renderReading } from './reading.ts';
import {
  looksLikeQuiz,
  onCommentEdited,
  openSeal,
  renderConfirmed,
  renderFlagged,
  renderQuiz,
  revisitNote,
  parseAnswers,
  type GeneratedQuiz,
} from './quiz.ts';

const CHECK_NAME = 'LGTM — review confirmed';

/**
 * Above this, skip the concept lookup rather than truncating the diff. A
 * truncated diff produces concepts drawn from an arbitrary prefix, which is
 * worse than no concepts at all — the grounding rule silently stops holding.
 */
const MAX_DIFF_CHARS = 400_000;

/** How long before the same person may be answered again on the same PR. */
const ANSWER_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * In-memory, so it resets on restart. That is the wrong direction for a limit
 * — a crash loop would let the cooldown be bypassed indefinitely — and is
 * acceptable only until FR-002's worker gives this somewhere durable to live.
 *
 * Entries are evicted by `sweep` rather than expiring on their own, because a
 * Map holds every key it is ever given: a long-lived process answering across
 * many pull requests would otherwise accumulate one entry per asker per PR and
 * never release a single one.
 */
const recentAnswers = new Map<string, number>();

/**
 * Drop entries whose cooldown has already elapsed.
 *
 * This cannot change who gets an answer. An entry older than the cooldown
 * already fails the freshness check below, so removing it produces the same
 * decision it would have produced by being read — the sweep is about memory,
 * not about policy. Keep that true: an eviction rule that outlived the
 * cooldown would start silently granting answers the limit meant to withhold.
 */
function sweep(now: number): void {
  for (const [key, at] of recentAnswers) {
    if (now - at >= ANSWER_COOLDOWN_MS) recentAnswers.delete(key);
  }
}

function sealKey(): string {
  const key = process.env.LGTM_SEAL_KEY;
  if (!key) throw new Error('LGTM_SEAL_KEY is not set');
  return key;
}

/**
 * The shared helpers below only ever touch `octokit`, `repo()`, and `log`, and
 * the union of two concrete event contexts is more type than TS will represent
 * at those property accesses. The un-parameterised `Context` covers all events
 * and is what the helpers actually need.
 */
type AnyContext = Context;

/**
 * Config from the base branch (spec FR-028), never the head. `context.config`
 * reads the default branch, which is the right ref for everything except a PR
 * that targets a non-default base — noted as a gap rather than papered over.
 */
async function loadConfig(
  context: AnyContext,
): Promise<{ config: Config; problems: string[] }> {
  try {
    const { owner, repo } = context.repo();
    // Cast: the config plugin's return type is generic over the shape it reads,
    // and unioning it across two event contexts exceeds what TS will represent.
    // `parseConfig` validates the value anyway, so nothing is lost.
    const octokit = context.octokit as unknown as {
      config: { get(args: unknown): Promise<{ config: unknown }> };
    };
    const raw = await octokit.config.get({
      owner,
      repo,
      path: '.github/lgtm.yml',
    });
    return parseConfig(raw.config);
  } catch (err) {
    context.log.warn({ err }, 'could not read config — using defaults');
    return { config: DEFAULTS, problems: ['Could not read `.github/lgtm.yml`.'] };
  }
}

/**
 * Regenerating from the file list is deterministic, so the grader can rebuild
 * the question text it needs for a revisit note without having stored it. The
 * real generator is not deterministic, which is why the seal carries the
 * hashes rather than relying on this — this is only for re-rendering prose.
 */
async function quizFor(
  context: AnyContext,
  prNumber: number,
  config: Config,
): Promise<GeneratedQuiz | null> {
  const result = await buildQuiz(context, prNumber, config);
  return result.kind === 'ok' ? result.quiz : null;
}

/**
 * The generation path: pre-filter cheaply on the file list, then generate and
 * verify from the diff.
 *
 * The file-list pass runs first because it decides the cases where asking is
 * wrong regardless of what a model would say — a 4,000-file dependency bump, a
 * PR of nothing but lockfiles — and settling those without a model call keeps
 * the common skip fast and free.
 */
async function buildQuiz(
  context: AnyContext,
  prNumber: number,
  config: Config,
): Promise<GenerateResult> {
  const files = await context.octokit.paginate(
    context.octokit.rest.pulls.listFiles,
    { ...context.repo(), pull_number: prNumber, per_page: 100 },
  );

  const prefilter = screen(files, config);
  if (prefilter.kind === 'skip') return prefilter;

  // Resolved before the diff is fetched: a repo that named a vendor it has no
  // key for should be told that, not charged for a diff download first.
  //
  // Every failure here is a skip, which is neutral, which does not hold a
  // merge (spec FR-025) — an unconfigured or misconfigured install must never
  // freeze a repo, and that includes naming a provider that isn't set up.
  let proposer: Provider;
  let verifier: Provider;
  try {
    proposer = resolve(config.provider);
    verifier = config.verifier ? resolve(config.verifier) : proposer;
  } catch (err) {
    return {
      kind: 'skip',
      reason:
        err instanceof ProviderError
          ? err.message
          : 'Question generation is not configured.',
    };
  }

  const { data: diff } = await context.octokit.rest.pulls.get({
    ...context.repo(),
    pull_number: prNumber,
    mediaType: { format: 'diff' },
  });

  return generateFromDiff(proposer, String(diff), config, verifier);
}

/**
 * How the check blocks, and how it deliberately doesn't.
 *
 * GitHub gives a required check three useful outcomes, and each carries a
 * different promise here:
 *
 *   `in_progress` — blocks merge while it lasts. This is the *only* thing that
 *     blocks, and it means exactly one thing: a person owes an answer.
 *   `neutral`     — satisfies a required check. Every LGTM-side problem lands
 *     here, so being broken can never freeze a repo (spec FR-025).
 *   `success`     — answered, or waived.
 *
 * `failure` is never used. It is the only conclusion that would put a red X
 * next to a reviewer's name for not having answered yet, and the whole tool is
 * built on that not happening.
 */
type Outcome = 'success' | 'neutral' | 'waiting';

/**
 * The web-explainer section, or nothing.
 *
 * Every failure path returns null: no API key configured, the model declined,
 * search didn't finish, the response didn't parse. The quiz is posted either
 * way — a reviewer must never be blocked, or even delayed, because an optional
 * reading aid was unavailable (spec FR-025, FR-035).
 */
async function conceptsFor(
  context: AnyContext,
  prNumber: number,
  files: { filename: string }[],
): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  try {
    // The diff, not the file list — concepts live in the hunks. `.diff` is a
    // media-type override, so the response body is text rather than JSON.
    const { data: diff } = await context.octokit.rest.pulls.get({
      ...context.repo(),
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });

    const text = String(diff);
    if (text.length > MAX_DIFF_CHARS) return null;

    const result = await explainConcepts(new Anthropic(), {
      diff: text,
      context: languagesIn(files),
      max: MAX_CONCEPTS,
    });

    if (result.kind === 'unavailable') {
      context.log.info({ reason: result.reason }, 'no web concepts');
      return null;
    }
    return renderConcepts(result.concepts);
  } catch (err) {
    context.log.warn({ err }, 'concept lookup failed');
    return null;
  }
}

/**
 * A reviewer mentioned @lgtm. Answer background; decline to read the PR for
 * them (see `ask.ts` for why that distinction is the whole feature).
 */
async function handleMention(
  context: Context<'issue_comment.created'>,
): Promise<void> {
  const { comment, issue, sender } = context.payload;

  // Never answer ourselves: our own replies contain the handle, and a bot
  // answering its own comment is an infinite loop with a billing account.
  if (comment.user?.type === 'Bot') return;

  const botLogin = process.env.LGTM_BOT_LOGIN ?? 'lgtm';
  const question = parseMention(comment.body, botLogin);
  if (!question) return;

  const { config } = await loadConfig(context);
  if (!config.answerQuestions) return;
  if (!process.env.ANTHROPIC_API_KEY) return;

  // Write access only, read straight off the event — no extra API call, and no
  // dependence on whether the asker happens to be on the reviewer list yet.
  //
  // Silently: a bot that publicly tells someone they may not ask is the
  // policing tone this tool is built to avoid, and it would fire on every
  // drive-by. The reason goes to the log, where a maintainer sees it.
  if (!hasWriteAccess(comment.author_association)) {
    context.log.info(
      { sender: sender.login, association: comment.author_association },
      'mention from someone without write access',
    );
    return;
  }

  // One answer per person per PR per hour. The write-access gate bounds who can
  // ask, not how often — a maintainer in a loop with the bot is still a model
  // call per comment. Keyed on the asker rather than the PR so two reviewers
  // working the same PR never throttle each other.
  // One clock reading for the whole decision. Calling Date.now() again below
  // would let the sweep and the freshness check disagree: an entry could be
  // spared by the sweep and then judged expired a microsecond later, or the
  // reverse. Reading once makes the two consistent by construction rather
  // than by luck.
  const now = Date.now();
  sweep(now);

  const bucket = `${context.repo().owner}/${context.repo().repo}#${issue.number}:${sender.login}`;
  const last = recentAnswers.get(bucket);
  if (last !== undefined && now - last < ANSWER_COOLDOWN_MS) {
    context.log.info({ bucket }, 'mention within cooldown');
    return;
  }
  recentAnswers.set(bucket, now);

  // Acknowledge before the model call — a question that takes 20 seconds to
  // answer reads as a bot that ignored you.
  //
  // Never fatal. This is a cosmetic emoji, and it once took down the whole
  // answer path: reactions on a PR comment need `pull-requests: write`, the
  // 403 escaped, and the question went unanswered because the acknowledgement
  // failed. Decoration must not be able to break the thing it decorates.
  try {
    await context.octokit.rest.reactions.createForIssueComment({
      ...context.repo(),
      comment_id: comment.id,
      content: 'eyes',
    });
  } catch (err) {
    context.log.warn({ err }, 'could not acknowledge — answering anyway');
  }

  try {
    const { data: diff } = await context.octokit.rest.pulls.get({
      ...context.repo(),
      pull_number: issue.number,
      mediaType: { format: 'diff' },
    });

    const answer = await ask(new Anthropic(), {
      question,
      diff: String(diff).slice(0, MAX_DIFF_CHARS),
      asker: sender.login,
    });

    const body = renderAnswer(sender.login, answer);
    if (!body) {
      context.log.info(
        { reason: answer.kind === 'unavailable' ? answer.reason : answer.kind },
        'no answer posted',
      );
      return;
    }

    await context.octokit.rest.issues.createComment({
      ...context.repo(),
      issue_number: issue.number,
      body,
    });
    context.log.info({ asker: sender.login, kind: answer.kind }, 'answered');
  } catch (err) {
    context.log.warn({ err }, 'question handling failed');
  }
}

/** So the model doesn't explain the stack the repo is obviously written in. */
function languagesIn(files: { filename: string }[]): string {
  const exts = new Set(
    files
      .map((f) => f.filename.slice(f.filename.lastIndexOf('.') + 1))
      .filter((e) => e && e.length <= 5),
  );
  return [...exts].sort().join(', ') || 'unknown';
}

async function setCheck(
  context: AnyContext,
  head: string,
  outcome: Outcome,
  title: string,
  summary: string,
) {
  await context.octokit.rest.checks.create({
    ...context.repo(),
    name: CHECK_NAME,
    head_sha: head,
    status: outcome === 'waiting' ? 'in_progress' : 'completed',
    ...(outcome === 'waiting' ? {} : { conclusion: outcome }),
    output: { title, summary },
  });
}

/**
 * What to report while the reviewer still owes an answer.
 *
 * With enforcement off this is `neutral` — the quiz is posted and the check is
 * informational, so a repo trying LGTM out is never blocked by it (User Story
 * 1). With enforcement on it stays `in_progress`, which is what holds the merge
 * button. Nothing else in the app distinguishes the two modes.
 */
function pendingOutcome(config: Config): Outcome {
  return config.enforce ? 'waiting' : 'neutral';
}

const WAIVE_RE = /^\s*\/lgtm\s+waive\b/im;


/**
 * The handlers. `action.ts` assembles a context and calls one of these.
 *
 * They are kept separate from the entry point so the logic can be exercised
 * without a workflow, and so a second entry point stays possible without
 * touching anything below.
 */
export async function onReviewSubmitted(
  context: Context<'pull_request_review.submitted'>,
): Promise<void> {
    const { review, pull_request: pr } = context.payload;

    if (review.state !== 'approved') return;
    if (!review.user || !pr.user) return;
    if (review.user.type === 'Bot') return;
    if (review.user.login === pr.user.login) return; // They wrote it.

    const { config, problems } = await loadConfig(context);
    const reviewer = review.user.login;

    if (config.exemptReviewers.includes(reviewer)) return;

    const head = pr.head.sha;

    const files = await context.octokit.paginate(
      context.octokit.rest.pulls.listFiles,
      { ...context.repo(), pull_number: pr.number, per_page: 100 },
    );

    // A config problem is reported but never fatal: defaults already applied.
    const footnote = problems.length
      ? `\n\nConfig notes: ${problems.join(' ')}`
      : '';

    const result = await buildQuiz(context, pr.number, config);
    if (result.kind === 'skip') {
      // Neutral, never failure: LGTM having nothing to ask must not gate a
      // merge (spec FR-025).
      await setCheck(
        context,
        head,
        'neutral',
        'No quiz for this one',
        result.reason + footnote,
      );
      return;
    }

    const reading = config.surfaceReading
      ? [
          renderReading(
            collect({
              files,
              prBody: pr.body,
              repo: { owner: context.repo().owner, repo: context.repo().repo, ref: head },
            }),
          ),
          config.webConcepts
            ? await conceptsFor(context, pr.number, files)
            : null,
        ]
          .filter(Boolean)
          .join('\n\n') || null
      : null;

    const body = renderQuiz(
      sealKey(),
      result.quiz,
      { pr: pr.number, head, reviewer },
      { reading },
    );

    const comment = await context.octokit.rest.issues.createComment({
      ...context.repo(),
      issue_number: pr.number,
      body,
    });

    // The probe. `author_association` on the edit event tells us what standing
    // the ticker had, which is exactly what decides whether checkboxes are a
    // viable input for outside contributors.
    context.log.info(
      { comment: comment.data.id, reviewer, head, difficulty: config.difficulty },
      'posted quiz',
    );

    await setCheck(
      context,
      head,
      pendingOutcome(config),
      'Waiting on the reviewer',
      `Asked @${reviewer} ${result.quiz.questions.length} question(s) at ` +
        `${config.difficulty} difficulty.\n\n` +
        (config.enforce
          ? 'Merging is held until this is answered. Anyone who can merge can ' +
            'release it by commenting `/lgtm waive`.'
          : 'Enforcement is off, so this check is informational — it will not ' +
            'hold the merge.') +
        footnote,
    );
}

export async function onQuizCommentEdited(
  context: Context<'issue_comment.edited'>,
): Promise<void> {
    const { comment, sender, issue } = context.payload;

    if (!looksLikeQuiz(comment.body)) return;

    // Log every edit of one of our comments before deciding anything, because
    // the absence of these lines is itself the finding: if an outside
    // contributor cannot tick, no event arrives at all.
    context.log.info(
      {
        sender: sender.login,
        author_association: context.payload.comment.author_association,
        comment: comment.id,
      },
      'edit on a quiz comment',
    );

    const action = onCommentEdited(sealKey(), {
      body: comment.body,
      sender: sender.login,
      commentAuthorIsApp: comment.user?.type === 'Bot',
    });

    if (action.kind === 'ignore' || action.kind === 'wait') {
      context.log.info({ action }, 'no state change');
      return;
    }

    const claims = openSeal(sealKey(), comment.body);
    if (!claims && action.kind !== 'reissue') return;

    if (action.kind === 'reissue') {
      const parsed = parseAnswers(sealKey(), comment.body);
      context.log.warn({ parsed: parsed.kind }, 'seal did not verify — reissuing');
      const { config } = await loadConfig(context);
      const quiz = await quizFor(context, issue.number, config);
      if (!quiz) return;
      // Nothing in the tampered body can be trusted, including the head it
      // claims, so both the head and the reviewer are re-read from GitHub
      // rather than from the comment.
      const { data: pr } = await context.octokit.rest.pulls.get({
        ...context.repo(),
        pull_number: issue.number,
      });
      await context.octokit.rest.issues.updateComment({
        ...context.repo(),
        comment_id: comment.id,
        body: renderQuiz(sealKey(), quiz, {
          pr: issue.number,
          head: pr.head.sha,
          reviewer: sender.login,
        }),
      });
      return;
    }

    if (!claims) return;

    if (action.kind === 'confirm' || action.kind === 'flagged') {
      await context.octokit.rest.issues.updateComment({
        ...context.repo(),
        comment_id: comment.id,
        body:
          action.kind === 'confirm'
            ? renderConfirmed(claims.reviewer)
            : renderFlagged(claims.reviewer),
      });
      await setCheck(
        context,
        claims.head,
        'success',
        action.kind === 'confirm' ? 'Confirmed' : 'Confirmed (question flagged)',
        `@${claims.reviewer} confirmed this review.`,
      );
      return;
    }

    if (action.kind === 'revisit') {
      const { config } = await loadConfig(context);
      const quiz = await quizFor(context, issue.number, config);
      if (!quiz) return;
      const parsed = parseAnswers(sealKey(), comment.body);
      await context.octokit.rest.issues.updateComment({
        ...context.repo(),
        comment_id: comment.id,
        body: renderQuiz(
          sealKey(),
          quiz,
          { pr: claims.pr, head: claims.head, reviewer: claims.reviewer },
          {
            selections: parsed.kind === 'ok' ? parsed.selections : undefined,
            note: revisitNote(quiz, action.wrong),
          },
        ),
      });
    }
}

  /**
   * `/lgtm waive` — the exit. With enforcement on, a reviewer who cannot answer
   * (a bad question, an emergency, a diff LGTM misjudged) must never be able to
   * strand a PR, so anyone who could have merged it anyway can release it.
   */

export async function onCommentCreated(
  context: Context<'issue_comment.created'>,
): Promise<void> {
    const { comment, issue, sender } = context.payload;

    if (!issue.pull_request) return;

    // A mention is not a waiver; check the waiver command first so
    // "@lgtm /lgtm waive" can't be routed to the question path.
    if (!WAIVE_RE.test(comment.body)) {
      await handleMention(context);
      return;
    }

    if (!hasWriteAccess(comment.author_association)) {
      await context.octokit.rest.issues.createComment({
        ...context.repo(),
        issue_number: issue.number,
        body:
          `@${sender.login} only someone who can merge this PR can waive the ` +
          `review check — asking a maintainer is the way through.`,
      });
      return;
    }

    const { data: pr } = await context.octokit.rest.pulls.get({
      ...context.repo(),
      pull_number: issue.number,
    });

    // Waivers are recorded in the thread, which is the audit trail (spec
    // FR-026). Nothing is written on LGTM's side.
    await setCheck(
      context,
      pr.head.sha,
      'success',
      'Waived',
      `Waived by @${sender.login}.`,
    );

    await context.octokit.rest.reactions.createForIssueComment({
      ...context.repo(),
      comment_id: comment.id,
      content: '+1',
    });

    context.log.info(
      { waivedBy: sender.login, pr: issue.number, head: pr.head.sha },
      'waived',
    );
}

  /**
   * A confirmation is bound to the commit it was answered against (FR-027), so
   * a new head starts with no check at all. With enforcement on that is exactly
   * right: no check means the required check is missing, which blocks until the
   * next approval produces one.
   */

export async function onHeadMoved(
  context: Context<'pull_request.synchronize'>,
): Promise<void> {
    // A confirmation is bound to the commit it was answered against (FR-027).
    // The new head simply has no check yet; nothing to undo.
    context.log.info({ head: context.payload.pull_request.head.sha }, 'head moved');
}

