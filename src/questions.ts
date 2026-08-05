/**
 * A placeholder generator, for testing the loop without a model in it.
 *
 * These questions are deterministic and answerable from the file list alone.
 * They are NOT the real thing — the real generator reads hunks and asks about
 * behaviour (spec FR-011..FR-016). The point here is that the live test is
 * about GitHub's permission behaviour on comment checkboxes, and a model in the
 * path would only add a way for that test to fail for unrelated reasons.
 *
 * Difficulty is honoured in the one dimension a file-stats generator has:
 * how close the distractors sit to the answer. The real generator will honour
 * it in the questions themselves; this at least keeps the setting wired end to
 * end so the config path is exercised.
 */

import { matchesAny, type Config, type Difficulty } from './config.ts';
import type { GeneratedQuiz, Question } from './quiz.ts';

export interface PrFile {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
}

/** Files nobody reads line by line, and quizzing them teaches the wrong lesson. */
const GENERATED = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Cargo.lock',
  '**/go.sum',
  '**/Package.resolved',
  '**/*.pbxproj',
  '**/*.snap',
  '**/dist/**',
  '**/build/**',
  '**/vendor/**',
  '**/*.generated.*',
];

function dirOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

/**
 * Distractor choice is the whole difficulty knob here.
 *
 * `hard` picks the nearest neighbours — same directory first, then same
 * extension — because those are the files someone skimming would confuse with
 * the answer. `easy` picks the furthest, which someone who read the PR title
 * can already rule out. Deterministic at every level, so a rerun on an
 * unchanged diff produces the same quiz (spec: reuse rather than regenerate).
 */
function rankDistractors(
  pool: string[],
  answer: string,
  difficulty: Difficulty,
): string[] {
  const answerDir = dirOf(answer);
  const answerExt = answer.slice(answer.lastIndexOf('.'));

  const nearness = (f: string): number =>
    (dirOf(f) === answerDir ? 0 : 2) + (f.endsWith(answerExt) ? 0 : 1);

  const others = pool.filter((f) => f !== answer);
  const sorted = [...others].sort(
    (a, b) => nearness(a) - nearness(b) || a.localeCompare(b),
  );

  if (difficulty === 'hard') return sorted;
  if (difficulty === 'easy') return sorted.reverse();
  // medium: neither the nearest nor the furthest.
  return [...sorted.slice(1), sorted[0]].filter(Boolean);
}

function build(
  id: string,
  prompt: string,
  answer: string,
  pool: string[],
  difficulty: Difficulty,
): { question: Question; correct: number } | null {
  const others = rankDistractors(pool, answer, difficulty).slice(0, 2);
  if (others.length < 2) return null; // Not enough files to make it non-trivial.
  const options = [answer, ...others].sort();
  return {
    question: {
      id,
      prompt,
      options,
      file: answer,
      hunk: 'file summary',
    },
    correct: options.indexOf(answer),
  };
}

export type GenerationResult =
  | { kind: 'ok'; quiz: GeneratedQuiz }
  | { kind: 'skip'; reason: string };

export const MAX_FILES = 60;

export function generate(files: PrFile[], config: Config): GenerationResult {
  const quizzable = files.filter(
    (f) =>
      !matchesAny(f.filename, GENERATED) &&
      !matchesAny(f.filename, config.exemptPaths),
  );

  if (files.length === 0) return { kind: 'skip', reason: 'The diff is empty.' };
  if (files.length > MAX_FILES) {
    return {
      kind: 'skip',
      reason: `This PR touches ${files.length} files — too large to quiz meaningfully.`,
    };
  }
  if (quizzable.length === 0) {
    return {
      kind: 'skip',
      reason: 'Everything in this PR is generated or exempt — nothing to ask about.',
    };
  }
  if (quizzable.length < 3) {
    return {
      kind: 'skip',
      reason: 'This PR is too small for the placeholder generator to ask about.',
    };
  }

  const pool = quizzable.map((f) => f.filename);
  const byAdditions = [...quizzable].sort((a, b) => b.additions - a.additions)[0];
  const byDeletions = [...quizzable].sort((a, b) => b.deletions - a.deletions)[0];
  const byChurn = [...quizzable].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  )[0];
  const added = quizzable.find((f) => f.status === 'added');

  // Candidates in priority order. Only as many as `config.questions` are used,
  // so raising the setting deepens the quiz rather than reshuffling it.
  const candidates: Array<{ id: string; prompt: string; answer: string } | null> = [
    {
      id: 'q-most-added',
      prompt: 'Which file gained the most lines in this PR?',
      answer: byAdditions.filename,
    },
    byDeletions.deletions > 0 && byDeletions.filename !== byAdditions.filename
      ? {
          id: 'q-most-removed',
          prompt: 'Which file lost the most lines in this PR?',
          answer: byDeletions.filename,
        }
      : null,
    added && added.filename !== byAdditions.filename
      ? {
          id: 'q-added-file',
          prompt: 'Which of these files is new in this PR?',
          answer: added.filename,
        }
      : null,
    byChurn.filename !== byAdditions.filename
      ? {
          id: 'q-most-churn',
          prompt: 'Which file changed the most overall in this PR?',
          answer: byChurn.filename,
        }
      : null,
  ];

  const built = candidates
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .map((c) => build(c.id, c.prompt, c.answer, pool, config.difficulty))
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .slice(0, config.questions);

  if (built.length === 0) {
    return { kind: 'skip', reason: 'Could not ground a question in this diff.' };
  }

  return {
    kind: 'ok',
    quiz: {
      questions: built.map((b) => b.question),
      correct: built.map((b) => b.correct),
    },
  };
}
