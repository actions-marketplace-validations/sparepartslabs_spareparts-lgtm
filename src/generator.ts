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

import Anthropic from '@anthropic-ai/sdk';

import { MODEL } from './concepts.ts';
import type { Config } from './config.ts';
import { isGrounded, parseDiff, renderForPrompt, type FileDiff } from './diff.ts';
import type { GeneratedQuiz, Question } from './quiz.ts';

/** How much diff the proposer sees. Beyond this the PR is not quizzed at all. */
export const DIFF_BUDGET = 120_000;

/** Over-generate, then let verification cull. */
const OVERSHOOT = 2;

const MAX_CONTINUATIONS = 2;

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

const DIFFICULTY_GUIDANCE: Record<Config['difficulty'], string> = {
  easy:
    'Distractors should be clearly unrelated to what this hunk does — a ' +
    'reviewer who read the change should rule them out immediately.',
  medium:
    'Distractors should be true statements about this PR that do not answer ' +
    'the question asked. Skimming the diff is not enough to rule them out.',
  hard:
    'Distractors should be the plausible misreading: the behaviour BEFORE ' +
    'the change, the branch not taken, an adjacent call site, or an effect ' +
    'that looks right but happens one layer away. Only someone who read this ' +
    'hunk closely can rule them out.',
};

function proposePrompt(diff: string, config: Config, want: number): string {
  return [
    'You are writing a short comprehension check for a code reviewer who has',
    'just approved this pull request. The goal is to distinguish someone who',
    'read the change from someone who skimmed the file list.',
    '',
    `Write up to ${want} multiple-choice questions. Fewer is fine. Zero is fine`,
    'if nothing in this diff is worth asking about.',
    '',
    'What to ask about, in priority order:',
    '1. Behaviour changes — what the code now does that it did not before.',
    '2. Error and edge paths — what a new guard prevents, what a changed',
    '   catch block now swallows or rethrows.',
    '3. Risk — a migration that touches existing rows, a changed default, a',
    '   security-relevant edit, a widened permission.',
    '',
    'Hard rules:',
    '- The question MUST be answerable from the diff shown, and nothing else.',
    '  If answering needs knowledge of code not in this diff, do not ask it.',
    '- Never ask about statistics: which file has the most lines added, how',
    '  many files changed, the order of files. That is trivia — someone who',
    '  read the change carefully would not know it, and someone who read',
    '  nothing could look it up in seconds.',
    '- Never ask about naming, formatting, or style.',
    '- Exactly one option may be correct. The others must be clearly wrong to',
    '  someone who read the hunk, and not obviously wrong to someone who did',
    '  not.',
    '- Give 3 options. Keep them the same rough length and shape — a longest',
    '  or most-detailed option that is always the answer gives the game away.',
    '- `file` must be a path shown below. `hunk` must be the exact `@@ ... @@`',
    '  header of the hunk you drew the question from, copied verbatim.',
    '- `rationale` explains why the correct option is correct, citing the',
    '  specific lines. It is not shown to the reviewer.',
    '',
    DIFFICULTY_GUIDANCE[config.difficulty],
    '',
    'The diff:',
    '',
    diff,
  ].join('\n');
}

function verifyPrompt(c: Candidate, diff: string): string {
  return [
    'You are checking a comprehension question written by someone else for a',
    'code reviewer. Your job is to find a reason it should NOT be used. Assume',
    'it is flawed and look for the flaw. Only conclude it is sound if you',
    'genuinely cannot find one.',
    '',
    'Mark it unsound if ANY of these is true:',
    '- The stated correct answer is not actually correct according to the diff.',
    '- Another option is also defensibly correct.',
    '- The question cannot be answered from the diff alone.',
    '- It asks about statistics, counts, file ordering, naming, or formatting',
    '  rather than about what the change does.',
    '- A reviewer who read this change carefully could still get it wrong —',
    '  because it turns on an obscure detail, or is ambiguously worded.',
    '- Someone who did NOT read the diff could pick the right option anyway:',
    '  the correct option is the longest or most detailed, the distractors are',
    '  nonsense, or the answer is inferable from the question wording.',
    '- The cited hunk does not contain what the question claims.',
    '',
    'Be decisive. A wrong question fails a reviewer who did their job, which',
    'is far worse than asking one fewer question. When in doubt, unsound.',
    '',
    `Question: ${c.prompt}`,
    ...c.options.map((o, i) => `  ${i === c.correct ? '*' : ' '} ${o}`),
    '(* marks the claimed answer)',
    `Cited: ${c.file} ${c.hunk}`,
    `Author's rationale: ${c.rationale}`,
    '',
    'The diff:',
    '',
    diff,
  ].join('\n');
}

export type GenerateResult =
  | { kind: 'ok'; quiz: GeneratedQuiz }
  | { kind: 'skip'; reason: string };

/**
 * Generate a verified quiz from a unified diff.
 *
 * Never throws. Every failure is a `skip` with a reason the check run can show,
 * because a generation problem must conclude neutral rather than block a merge
 * (spec FR-016, FR-025).
 */
export async function generateFromDiff(
  client: Anthropic,
  diff: string,
  config: Config,
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
    candidates = await propose(client, text, config);
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
    grounded.map((c) => verify(client, c, text)),
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
  client: Anthropic,
  diff: string,
  config: Config,
): Promise<Candidate[]> {
  const want = Math.min(config.questions * OVERSHOOT, 8);
  const response = await complete(
    client,
    proposePrompt(diff, config, want),
    PROPOSE_SCHEMA,
    'high',
  );

  const raw = JSON.parse(response) as { questions?: unknown };
  if (!Array.isArray(raw.questions)) {
    throw new Error('Generator returned no questions.');
  }
  return raw.questions.filter(isCandidate);
}

async function verify(
  client: Anthropic,
  c: Candidate,
  diff: string,
): Promise<{ sound: boolean; problem: string }> {
  try {
    const response = await complete(
      client,
      verifyPrompt(c, diff),
      VERIFY_SCHEMA,
      'high',
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

/** One structured call, with the server-tool pause loop handled. */
async function complete(
  client: Anthropic,
  prompt: string,
  schema: Record<string, unknown>,
  effort: 'medium' | 'high',
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort, format: { type: 'json_schema', schema } },
      messages,
    });

    if (response.stop_reason === 'refusal') {
      throw new Error(
        `Declined (${response.stop_details?.category ?? 'unspecified'}).`,
      );
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('Generation was truncated.');
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) throw new Error('Generator returned nothing.');
    return text;
  }

  throw new Error('Generation did not finish.');
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
