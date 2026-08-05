/**
 * The cheap pre-filter, run on the file list before any model call.
 *
 * Its job is to settle the cases where quizzing is wrong no matter what a model
 * would produce: a 4,000-file dependency bump, a PR of nothing but lockfiles, a
 * change confined to paths the repo exempted. Deciding those from the file list
 * keeps the common skip fast, free, and deterministic.
 *
 * It deliberately does NOT decide whether a diff is *interesting*. That needs
 * the hunks, and it belongs to `generator.ts` — which is allowed to conclude
 * that a quizzable-looking PR has nothing worth asking about.
 */

import { matchesAny, type Config } from './config.ts';
import type { GenerateResult } from './generator.ts';

export interface PrFile {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
}

/** Files nobody reads line by line; quizzing them teaches the wrong lesson. */
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

export const MAX_FILES = 60;

export function screen(files: PrFile[], config: Config): GenerateResult {
  if (files.length === 0) {
    return { kind: 'skip', reason: 'The diff is empty.' };
  }
  if (files.length > MAX_FILES) {
    return {
      kind: 'skip',
      reason: `This PR touches ${files.length} files — too large to quiz meaningfully.`,
    };
  }

  const quizzable = files.filter(
    (f) =>
      !matchesAny(f.filename, GENERATED) &&
      !matchesAny(f.filename, config.exemptPaths),
  );

  if (quizzable.length === 0) {
    return {
      kind: 'skip',
      reason: 'Everything in this PR is generated or exempt — nothing to ask about.',
    };
  }

  const changed = quizzable.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (changed === 0) {
    return {
      kind: 'skip',
      reason: 'This PR changes no lines in reviewable files.',
    };
  }

  // `ok` here means "worth sending to the generator", not "quiz produced" —
  // the caller replaces this quiz with the generated one.
  return { kind: 'ok', quiz: { questions: [], correct: [] } };
}
