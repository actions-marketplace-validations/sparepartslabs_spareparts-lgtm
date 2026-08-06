/**
 * The shared prompts, loaded from `prompts/lgtm-questions.v1.json`.
 *
 * That file is byte-identical in this repo and in
 * `sparepartslabs/spareparts-cli`, and both load it at runtime. The reason is
 * narrow and specific: the Action and the CLI write questions about the same
 * diffs, and two tools disagreeing about the same diff is worse than either
 * being imperfect. Wording that lives in two source files drifts — it already
 * had, in three places, before this file existed.
 *
 * The prompts are data, so the file is data. Nothing in it knows what a pull
 * request is. See PROMPTS.md.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Difficulty } from './config.ts';

export const FILENAME = 'lgtm-questions.v1.json';

/**
 * SHA-256 of the prompts file, pinned so an edit cannot pass unnoticed. A test
 * asserts this matches. When it fails, the edit was deliberate — update the
 * constant here AND copy the file to the other repo, which pins the same
 * value. See PROMPTS.md.
 */
export const PROMPTS_SHA256 =
  '2ecbb0aff807f1034985c7b784708ce3cdb6d7dbff14e035c69e8078b6501410';

/**
 * Resolved from this module rather than from `process.cwd()`: the Action runs
 * from wherever the workflow put it, and a relative path would find the file
 * only by luck.
 */
export const PROMPTS_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  'prompts',
  FILENAME,
);

export class PromptsError extends Error {}

interface Prompts {
  difficultyGuidance: Record<Difficulty, string>;
  propose: string[];
  verify: string[];
}

let cached: Prompts | null = null;

export function load(): Prompts {
  if (cached) return cached;

  let raw: string;
  try {
    raw = readFileSync(PROMPTS_PATH, 'utf8');
  } catch (err) {
    throw new PromptsError(`Could not read ${PROMPTS_PATH}: ${err}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PromptsError(`${PROMPTS_PATH} is not valid JSON: ${err}`);
  }

  const data = parsed as Partial<Prompts>;
  for (const key of ['propose', 'verify', 'difficultyGuidance'] as const) {
    if (!data[key]) throw new PromptsError(`${PROMPTS_PATH} has no \`${key}\`.`);
  }

  cached = data as Prompts;
  return cached;
}

export function fileSha256(): string {
  return createHash('sha256').update(readFileSync(PROMPTS_PATH)).digest('hex');
}

function render(lines: string[], values: Record<string, string>): string {
  let text = lines.join('\n');
  for (const [name, value] of Object.entries(values)) {
    text = text.split(`{{${name}}}`).join(value);
  }
  return text;
}

export function propose(diff: string, difficulty: Difficulty, want: number): string {
  const data = load();
  const guidance = data.difficultyGuidance[difficulty];
  if (!guidance) {
    // `config` has already clamped this to a known value; reaching here means
    // the shared file and the config disagree about the vocabulary, which is a
    // drift bug and must not be papered over with a default.
    throw new PromptsError(`No guidance for difficulty '${difficulty}'.`);
  }
  return render(data.propose, {
    want: String(want),
    difficultyGuidance: guidance,
    diff,
  });
}

export function verify(args: {
  question: string;
  options: string[];
  correct: number;
  cited: string;
  rationale: string;
  diff: string;
}): string {
  const marked = args.options
    .map((option, i) => `  ${i === args.correct ? '*' : ' '} ${option}`)
    .join('\n');

  return render(load().verify, {
    question: args.question,
    options: marked,
    cited: args.cited,
    rationale: args.rationale,
    diff: args.diff,
  });
}
