/**
 * The real question generator.
 *
 * Three stages, and the middle one is the point:
 *
 *   1. Propose — one call reads the hunks and writes candidate questions about
 *      what the change *does*: what a new guard prevents, which edit can affect
 *      existing rows, what the error path now returns.
 *   2. Verify — each candidate goes to an independent call that has never seen
 *      the proposer's reasoning and is told to refute it. A candidate survives
 *      only if that call agrees the stated answer is right, the question is
 *      answerable from the diff alone, and the distractors are plausible.
 *   3. Ground — the citation is checked against the parsed diff in code, and
 *      the option set is checked for the tells that make a question free.
 *
 * Stage 2 exists because a question whose stated answer is wrong is worse than
 * no question: it fails a reviewer who read correctly, which is the one failure
 * this tool cannot recover from (spec FR-013). One model checking its own work
 * is not that check — it agrees with itself.
 *
 * Everything is conservative in the same direction. A candidate that cannot be
 * confirmed is dropped, and a quiz with no surviving questions is not posted at
 * all. Asking nothing is a fine outcome; asking something wrong is not.
 */

import type { Config } from './config.ts';
import { isGrounded, parseDiff, renderForPrompt, type FileDiff } from './diff.ts';
import * as prompts from './prompts.ts';
import type { Provider } from './providers.ts';
import type { GeneratedQuiz, Question } from './quiz.ts';

/** How much diff the proposer sees. Beyond this the PR is not quizzed at all. */
export const DIFF_BUDGET = 120_000;

/** Over-generate, then let verification cull. */
const OVERSHOOT = 2;

interface Candidate {
  prompt: string;
  options: string[];
  correct: number;
  file: string;
  hunk: string;
  /** Why this is the answer, in the proposer's words. Fed to the verifier. */
  rationale: string;
}

const PROPOSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    questions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          prompt: { type: 'string' as const },
          options: { type: 'array' as const, items: { type: 'string' as const } },
          correct: { type: 'integer' as const },
          file: { type: 'string' as const },
          hunk: { type: 'string' as const },
          rationale: { type: 'string' as const },
        },
        required: ['prompt', 'options', 'correct', 'file', 'hunk', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

const VERIFY_SCHEMA = {
  type: 'object' as const,
  properties: {
    /** True only if every check below passes. Default to false when unsure. */
    sound: { type: 'boolean' as const },
    /** Which check failed, for the logs. Empty when sound. */
    problem: { type: 'string' as const },
  },
  required: ['sound', 'problem'],
  additionalProperties: false,
};

export type GenerateResult =
  | { kind: 'ok'; quiz: GeneratedQuiz }
  | { kind: 'skip'; reason: string };

/**
 * Generate a verified quiz from a unified diff.
 *
 * `verifier` defaults to `proposer`, which is the weaker arrangement and the
 * one to move off when a repo has a second key: a model asked to refute its own
 * question is being asked to disagree with itself, and it mostly doesn't.
 * Setting `verifier:` in `.github/lgtm.yml` to a different vendor is the whole
 * reason the provider seam exists.
 *
 * Never throws. Every failure is a `skip` with a reason the check run can show,
 * because a generation problem must conclude neutral rather than block a merge
 * (spec FR-016, FR-025).
 */
export async function generateFromDiff(
  proposer: Provider,
  diff: string,
  config: Config,
  verifier: Provider = proposer,
): Promise<GenerateResult> {
  const files = parseDiff(diff);
  if (files.length === 0) {
    return { kind: 'skip', reason: 'No reviewable changes in this diff.' };
  }

  const { text, included } = renderForPrompt(files, DIFF_BUDGET);
  if (included.length === 0) {
    return {
      kind: 'skip',
      reason: 'Every file in this PR is too large to quiz meaningfully.',
    };
  }

  let candidates: Candidate[];
  try {
    candidates = await propose(proposer, text, config);
  } catch (err) {
    return {
      kind: 'skip',
      reason: err instanceof Error ? err.message : 'Could not generate questions.',
    };
  }

  // Ground before verifying: a citation that names nothing real is free to
  // reject, and there is no point spending a verification call on it.
  const grounded = candidates.filter(
    (c) => isGrounded(included, c.file, c.hunk) && wellFormed(c),
  );
  if (grounded.length === 0) {
    return { kind: 'skip', reason: 'Could not ground a question in this diff.' };
  }

  // Verified concurrently — each is independent, and the reviewer is waiting.
  const verdicts = await Promise.all(
    grounded.map((c) => verify(verifier, c, text)),
  );
  const survivors = grounded.filter((_, i) => verdicts[i].sound);

  if (survivors.length === 0) {
    return {
      kind: 'skip',
      reason: 'No question survived verification, so none was asked.',
    };
  }

  const kept = survivors.slice(0, config.questions);
  return {
    kind: 'ok',
    quiz: {
      questions: kept.map((c, i): Question => ({
        id: `q${i + 1}`,
        prompt: c.prompt,
        options: c.options,
        file: c.file,
        hunk: c.hunk,
      })),
      correct: kept.map((c) => c.correct),
    },
  };
}

async function propose(
  proposer: Provider,
  diff: string,
  config: Config,
): Promise<Candidate[]> {
  const want = Math.min(config.questions * OVERSHOOT, 8);
  const response = await proposer.complete(
    prompts.propose(diff, config.difficulty, want),
    PROPOSE_SCHEMA,
  );

  const raw = JSON.parse(response) as { questions?: unknown };
  if (!Array.isArray(raw.questions)) {
    throw new Error('Generator returned no questions.');
  }
  return raw.questions.filter(isCandidate);
}

async function verify(
  verifier: Provider,
  c: Candidate,
  diff: string,
): Promise<{ sound: boolean; problem: string }> {
  try {
    const response = await verifier.complete(
      prompts.verify({
        question: c.prompt,
        options: c.options,
        correct: c.correct,
        cited: `${c.file} ${c.hunk}`,
        rationale: c.rationale,
        diff,
      }),
      VERIFY_SCHEMA,
    );
    const raw = JSON.parse(response) as { sound?: unknown; problem?: unknown };
    return {
      // Anything but an explicit `true` is a rejection. A verifier that fails
      // to answer must not be read as approval.
      sound: raw.sound === true,
      problem: typeof raw.problem === 'string' ? raw.problem : '',
    };
  } catch (err) {
    return {
      sound: false,
      problem: err instanceof Error ? err.message : 'verification failed',
    };
  }
}

function isCandidate(value: unknown): value is Candidate {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    ['prompt', 'file', 'hunk', 'rationale'].every(
      (f) => typeof c[f] === 'string' && (c[f] as string).trim(),
    ) &&
    Array.isArray(c.options) &&
    c.options.every((o) => typeof o === 'string' && o.trim()) &&
    typeof c.correct === 'number' &&
    Number.isInteger(c.correct)
  );
}

/**
 * The structural tells that make a question free, checked in code because they
 * are mechanical and a verifier's judgement shouldn't be spent on them.
 *
 * The length check is the one that matters: a correct option noticeably longer
 * than its distractors is the oldest giveaway in multiple choice, and a model
 * writing a careful correct answer beside two throwaway wrong ones produces it
 * without meaning to.
 */
export function wellFormed(c: Candidate): boolean {
  if (c.options.length < 3) return false;
  if (c.correct < 0 || c.correct >= c.options.length) return false;

  const normal = c.options.map((o) => o.trim().toLowerCase());
  if (new Set(normal).size !== normal.length) return false;

  const lengths = c.options.map((o) => o.trim().length);
  const answer = lengths[c.correct];
  const others = lengths.filter((_, i) => i !== c.correct);
  const longest = Math.max(...others);
  // Half again as long as every distractor is a tell, not a coincidence.
  if (answer > longest * 1.5) return false;

  return true;
}
