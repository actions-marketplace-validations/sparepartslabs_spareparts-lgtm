import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DIFFICULTIES, type Difficulty } from './config.ts';
import * as prompts from './prompts.ts';

/**
 * The drift guard.
 *
 * `prompts/lgtm-questions.v1.json` is byte-identical in
 * sparepartslabs/spareparts-cli, which pins the same hash. If this test fails
 * you edited the prompts — which is fine, and the fix is two steps, not one:
 *
 *   1. update PROMPTS_SHA256 in src/prompts.ts
 *   2. copy the file to the other repo and update its pinned hash too
 *
 * Doing only the first is how the two tools end up asking differently-worded
 * questions about the same diff, which is what this arrangement exists to
 * prevent.
 */
test('the shared prompts file matches its pinned hash', () => {
  assert.equal(
    prompts.fileSha256(),
    prompts.PROMPTS_SHA256,
    'The shared prompts file changed. Update PROMPTS_SHA256 *and* copy the file ' +
      'to sparepartslabs/spareparts-cli. See PROMPTS.md.',
  );
});

test('no repo-specific vocabulary leaks into the shared file', () => {
  // The Action addresses a reviewer on a pull request; the CLI addresses
  // someone about to merge a branch they just read. Wording true of only one
  // of those is how the file stops being shareable.
  const data = prompts.load();
  const text = [...data.propose, ...data.verify].join(' ').toLowerCase();
  for (const word of ['pull request', ' pr ', 'reviewer', 'approved']) {
    assert.ok(!text.includes(word), `'${word}' is repo-specific — see PROMPTS.md`);
  }
});

test('every difficulty the config allows has guidance', () => {
  const guidance = prompts.load().difficultyGuidance;
  for (const difficulty of DIFFICULTIES as Difficulty[]) {
    assert.ok(guidance[difficulty], `no guidance for '${difficulty}'`);
  }
  assert.equal(Object.keys(guidance).length, DIFFICULTIES.length);
});

test('propose substitutes every placeholder', () => {
  const out = prompts.propose('DIFF-HERE', 'hard', 4);
  assert.ok(!out.includes('{{'), 'a placeholder was left unsubstituted');
  assert.ok(out.includes('DIFF-HERE'));
  assert.ok(out.includes('up to 4 multiple-choice'));
  assert.match(out, /plausible misreading/); // the hard guidance, not medium
});

test('propose picks the right difficulty', () => {
  assert.match(prompts.propose('d', 'easy', 2), /rule them out immediately/);
  assert.match(prompts.propose('d', 'medium', 2), /true statements about this change/);
});

test('verify substitutes every placeholder and marks the claimed answer', () => {
  const out = prompts.verify({
    question: 'What does it do?',
    options: ['first', 'second', 'third'],
    correct: 1,
    cited: 'src/a.ts @@ -1,2 +1,3 @@',
    rationale: 'because of line 4',
    diff: 'DIFF-HERE',
  });
  assert.ok(!out.includes('{{'), 'a placeholder was left unsubstituted');
  assert.ok(out.includes('What does it do?'));
  assert.ok(out.includes('  * second'));
  assert.ok(out.includes('    first'));
  assert.ok(out.includes('src/a.ts @@ -1,2 +1,3 @@'));
  assert.ok(out.includes('because of line 4'));
  assert.ok(out.includes('DIFF-HERE'));
});

test('the verifier is never told which vendor proposed', () => {
  // The verifier's independence is the point of the stage. It sees the question
  // and the diff, and nothing about who wrote it.
  const out = prompts
    .verify({
      question: 'q',
      options: ['a', 'b', 'c'],
      correct: 0,
      cited: 'f h',
      rationale: 'r',
      diff: 'd',
    })
    .toLowerCase();
  for (const vendor of ['anthropic', 'claude', 'openai', 'gpt', 'gemini', 'google']) {
    assert.ok(!out.includes(vendor), `'${vendor}' leaked into the verify prompt`);
  }
});
