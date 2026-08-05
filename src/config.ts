/**
 * `.github/lgtm.yml`, read from the PR's base branch so a PR cannot exempt
 * itself (spec FR-028).
 *
 * Validation is total and never throws: a malformed field falls back to its
 * default and is reported. A typo must not silently disable enforcement, and
 * must not block every merge either (User Story 4, scenario 2) — so the caller
 * takes the defaults, runs, and says what it ignored.
 */

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Config {
  /** How many questions to ask. Clamped to 1..5. */
  questions: number;
  /**
   * How hard the questions should be.
   *
   * `easy` — one clearly-right answer against obviously-unrelated distractors;
   *   confirms the reviewer knows what the PR is broadly about.
   * `medium` — distractors are true statements about the diff that don't answer
   *   the question asked. The default.
   * `hard` — distractors are the plausible misreading: the behaviour before the
   *   change, the branch not taken, the adjacent call site. Answerable only by
   *   someone who read the hunk rather than skimmed the filenames.
   */
  difficulty: Difficulty;
  /**
   * Surface the docs, specs, and posts a reviewer should read to understand
   * this PR, listed above the questions.
   *
   * On by default because it changes what the tool is: with it off, LGTM only
   * tests. With it on, it first hands the reviewer what they'd need to answer
   * well. That is the difference between a checkpoint and a help.
   */
  surfaceReading: boolean;
  /**
   * Also surface web explainers for concepts the diff assumes knowledge of.
   *
   * Only meaningful when `surfaceReading` is on. Separate from it because of
   * where the diff travels: the model issues web searches, so diff-derived
   * query terms reach a search provider and the links come back from third
   * parties. Note this is *not* the same as "the diff reaches a model" — the
   * real quiz generator does that too, for every quiz, whatever this is set to.
   */
  webConcepts: boolean;
  /**
   * Let reviewers ask questions by mentioning @lgtm on a PR.
   *
   * Independent of `surfaceReading`: this is a reviewer pulling context when
   * they want it, not LGTM pushing it. Questions about the PR itself are
   * declined regardless of this setting — see `ask.ts`.
   */
  answerQuestions: boolean;
  /** The LGTM check is reported either way; this decides if it can gate merge. */
  enforce: boolean;
  /** Globs never worth quizzing, in addition to the built-in generated-file set. */
  exemptPaths: string[];
  /** Logins never quizzed. Bots are always exempt regardless. */
  exemptReviewers: string[];
}

export const DEFAULTS: Config = {
  questions: 2,
  difficulty: 'medium',
  surfaceReading: true,
  webConcepts: true,
  answerQuestions: true,
  enforce: false,
  exemptPaths: [],
  exemptReviewers: [],
};

export interface LoadedConfig {
  config: Config;
  /** Human-readable notes about anything ignored. Empty means a clean parse. */
  problems: string[];
}

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 5;

function readStringArray(
  raw: unknown,
  field: string,
  problems: string[],
  fallback: string[],
): string[] {
  if (raw === undefined || raw === null) return fallback;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    problems.push(`\`${field}\` must be a list of strings — ignored.`);
    return fallback;
  }
  return raw as string[];
}

export function parseConfig(raw: unknown): LoadedConfig {
  const problems: string[] = [];
  if (raw === null || raw === undefined) return { config: DEFAULTS, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      config: DEFAULTS,
      problems: ['`.github/lgtm.yml` is not a mapping — using defaults.'],
    };
  }

  const o = raw as Record<string, unknown>;

  let questions = DEFAULTS.questions;
  if (o.questions !== undefined) {
    const n = typeof o.questions === 'number' ? o.questions : NaN;
    if (!Number.isInteger(n)) {
      problems.push('`questions` must be a whole number — using the default.');
    } else if (n < MIN_QUESTIONS || n > MAX_QUESTIONS) {
      // Clamped rather than rejected: someone who asked for 10 wants "lots",
      // and the ceiling exists because a reviewer who reads carefully still
      // shouldn't owe five minutes of quiz per approval.
      questions = Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, n));
      problems.push(
        `\`questions\` must be between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} — using ${questions}.`,
      );
    } else {
      questions = n;
    }
  }

  let difficulty = DEFAULTS.difficulty;
  if (o.difficulty !== undefined) {
    if (
      typeof o.difficulty === 'string' &&
      DIFFICULTIES.includes(o.difficulty as Difficulty)
    ) {
      difficulty = o.difficulty as Difficulty;
    } else {
      problems.push(
        `\`difficulty\` must be one of ${DIFFICULTIES.join(', ')} — using ${difficulty}.`,
      );
    }
  }

  const bool = (key: keyof Config, fallback: boolean): boolean => {
    const v = o[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') {
      problems.push(`\`${key}\` must be true or false — using ${fallback}.`);
      return fallback;
    }
    return v;
  };

  return {
    config: {
      questions,
      difficulty,
      surfaceReading: bool('surfaceReading', DEFAULTS.surfaceReading),
      webConcepts: bool('webConcepts', DEFAULTS.webConcepts),
      answerQuestions: bool('answerQuestions', DEFAULTS.answerQuestions),
      enforce: bool('enforce', DEFAULTS.enforce),
      exemptPaths: readStringArray(
        o.exemptPaths,
        'exemptPaths',
        problems,
        DEFAULTS.exemptPaths,
      ),
      exemptReviewers: readStringArray(
        o.exemptReviewers,
        'exemptReviewers',
        problems,
        DEFAULTS.exemptReviewers,
      ),
    },
    problems,
  };
}

/**
 * Enough glob for path exemptions, without a dependency.
 *
 * `**` crosses directories, `*` does not. The case that matters most is
 * `**‍/package-lock.json`, which must match the file at the repo root as well
 * as in a workspace — so `**‍/` is zero-or-more directories, not one-or-more.
 * Getting that wrong silently quizzes people about lockfiles.
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      const doubled = glob[i + 1] === '*';
      if (doubled) {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/` — zero or more directories.
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
      continue;
    }
    re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}
