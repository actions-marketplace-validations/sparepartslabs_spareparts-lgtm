import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, matchesAny, parseConfig } from './config.ts';
import { generate, type PrFile } from './questions.ts';
import { collect, linksIn, renderReading } from './reading.ts';

// --- config ----------------------------------------------------------------

test('an absent config is the documented defaults', () => {
  const { config, problems } = parseConfig(null);
  assert.deepEqual(config, DEFAULTS);
  assert.deepEqual(problems, []);
  assert.equal(config.enforce, false, 'enforcement must be off by default');
});

test('a valid config is taken as written', () => {
  const { config, problems } = parseConfig({
    questions: 4,
    difficulty: 'hard',
    surfaceReading: false,
    enforce: true,
  });
  assert.deepEqual(problems, []);
  assert.equal(config.questions, 4);
  assert.equal(config.difficulty, 'hard');
  assert.equal(config.surfaceReading, false);
  assert.equal(config.enforce, true);
});

test('a bad field falls back and is reported, never thrown', () => {
  const { config, problems } = parseConfig({
    questions: 'lots',
    difficulty: 'brutal',
    enforce: 'yes',
  });
  assert.equal(config.questions, DEFAULTS.questions);
  assert.equal(config.difficulty, DEFAULTS.difficulty);
  assert.equal(config.enforce, false);
  assert.equal(problems.length, 3);
});

test('a typo cannot silently turn enforcement on', () => {
  // The dangerous direction: a malformed value must never be read as `true`.
  const { config } = parseConfig({ enforce: 'true' });
  assert.equal(config.enforce, false);
});

test('an out-of-range question count is clamped, not rejected', () => {
  assert.equal(parseConfig({ questions: 10 }).config.questions, 5);
  assert.equal(parseConfig({ questions: 0 }).config.questions, 1);
  assert.equal(parseConfig({ questions: 10 }).problems.length, 1);
});

test('a config that is not a mapping falls back whole', () => {
  assert.deepEqual(parseConfig(['questions', 2]).config, DEFAULTS);
  assert.equal(parseConfig('nope').problems.length, 1);
});

test('path globs match across directories', () => {
  assert.ok(matchesAny('web/package-lock.json', ['**/package-lock.json']));
  assert.ok(matchesAny('src/dist/bundle.js', ['**/dist/**']));
  assert.ok(!matchesAny('src/quiz.ts', ['**/dist/**']));
});

// --- generation ------------------------------------------------------------

const FILES: PrFile[] = [
  { filename: 'src/billing/charge.ts', additions: 40, deletions: 2, status: 'modified' },
  { filename: 'src/billing/refund.ts', additions: 5, deletions: 30, status: 'modified' },
  { filename: 'src/billing/charge.test.ts', additions: 20, deletions: 0, status: 'added' },
  { filename: 'docs/billing.md', additions: 8, deletions: 1, status: 'modified' },
  { filename: 'package-lock.json', additions: 900, deletions: 400, status: 'modified' },
];

test('the question count follows the config', () => {
  for (const n of [1, 2, 3]) {
    const result = generate(FILES, { ...DEFAULTS, questions: n });
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.equal(result.quiz.questions.length, n);
  }
});

test('raising the count deepens the quiz rather than reshuffling it', () => {
  const two = generate(FILES, { ...DEFAULTS, questions: 2 });
  const three = generate(FILES, { ...DEFAULTS, questions: 3 });
  assert.equal(two.kind, 'ok');
  assert.equal(three.kind, 'ok');
  if (two.kind !== 'ok' || three.kind !== 'ok') return;
  assert.deepEqual(
    three.quiz.questions.slice(0, 2).map((q) => q.id),
    two.quiz.questions.map((q) => q.id),
  );
});

test('lockfiles are never quizzed about', () => {
  const result = generate(FILES, DEFAULTS);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  const everyOption = result.quiz.questions.flatMap((q) => q.options);
  assert.ok(!everyOption.includes('package-lock.json'));
});

test('a PR of only generated files is skipped, not quizzed', () => {
  const result = generate(
    [{ filename: 'package-lock.json', additions: 900, deletions: 4, status: 'modified' }],
    DEFAULTS,
  );
  assert.equal(result.kind, 'skip');
});

test('exempt paths are honoured', () => {
  const result = generate(FILES, { ...DEFAULTS, exemptPaths: ['docs/**'] });
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.ok(!result.quiz.questions.flatMap((q) => q.options).includes('docs/billing.md'));
});

test('hard picks nearer distractors than easy', () => {
  const hard = generate(FILES, { ...DEFAULTS, difficulty: 'hard', questions: 1 });
  const easy = generate(FILES, { ...DEFAULTS, difficulty: 'easy', questions: 1 });
  assert.equal(hard.kind, 'ok');
  assert.equal(easy.kind, 'ok');
  if (hard.kind !== 'ok' || easy.kind !== 'ok') return;

  const sameDir = (opts: string[]) =>
    opts.filter((o) => o.startsWith('src/billing/')).length;

  assert.ok(
    sameDir(hard.quiz.questions[0].options) > sameDir(easy.quiz.questions[0].options),
    'hard distractors should sit closer to the answer',
  );
});

test('difficulty never changes which option is correct', () => {
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    const result = generate(FILES, { ...DEFAULTS, difficulty, questions: 1 });
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    const q = result.quiz.questions[0];
    assert.equal(q.options[result.quiz.correct[0]], 'src/billing/charge.ts');
  }
});

test('generation is deterministic for an unchanged diff', () => {
  const a = generate(FILES, DEFAULTS);
  const b = generate(FILES, DEFAULTS);
  assert.deepEqual(a, b);
});

// --- reading ---------------------------------------------------------------

const REPO = { owner: 'sparepartslabs', repo: 'lgtm', ref: 'abc123' };

test('changed docs and described links are surfaced', () => {
  const items = collect({
    files: FILES,
    prBody: 'Implements [the billing spec](https://example.com/spec) — see https://example.com/rfc',
    repo: REPO,
  });
  const hrefs = items.map((i) => i.href);
  assert.ok(hrefs.some((h) => h.endsWith('docs/billing.md')));
  assert.ok(hrefs.includes('https://example.com/spec'));
  assert.ok(hrefs.includes('https://example.com/rfc'));
});

test('a markdown link keeps the author label rather than the bare URL', () => {
  const links = linksIn('see [the design doc](https://example.com/doc)');
  assert.deepEqual(links, [{ href: 'https://example.com/doc', title: 'the design doc' }]);
});

test('a link written both ways is surfaced once', () => {
  const links = linksIn('[spec](https://example.com/spec) and https://example.com/spec');
  assert.equal(links.length, 1);
});

test('changelogs are not reading material', () => {
  const items = collect({
    files: [{ filename: 'CHANGELOG.md', status: 'modified' }],
    prBody: null,
    repo: REPO,
  });
  assert.deepEqual(items, []);
});

test('neighbouring docs are only surfaced from touched directories', () => {
  const items = collect({
    files: [{ filename: 'src/billing/charge.ts', status: 'modified' }],
    prBody: null,
    neighbours: ['src/billing/README.md', 'src/auth/README.md'],
    repo: REPO,
  });
  const hrefs = items.map((i) => i.href);
  assert.ok(hrefs.some((h) => h.endsWith('src/billing/README.md')));
  assert.ok(!hrefs.some((h) => h.endsWith('src/auth/README.md')));
});

test('the reading list is capped', () => {
  const body = Array.from({ length: 12 }, (_, i) => `https://example.com/${i}`).join(' ');
  assert.ok(collect({ files: [], prBody: body, repo: REPO }).length <= 5);
});

test('nothing to read renders nothing at all', () => {
  assert.equal(renderReading([]), null);
});
