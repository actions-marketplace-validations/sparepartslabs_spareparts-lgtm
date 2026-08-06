import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from './config.ts';
import { changedLines, isGrounded, parseDiff, renderForPrompt } from './diff.ts';
import { generateFromDiff, wellFormed } from './generator.ts';
import type { Provider } from './providers.ts';

const DIFF = `diff --git a/src/billing/charge.ts b/src/billing/charge.ts
index 1111111..2222222 100644
--- a/src/billing/charge.ts
+++ b/src/billing/charge.ts
@@ -41,6 +41,11 @@ export async function chargeCard(order: Order) {
   const card = await cards.for(order.customerId);
+  if (order.refundedAt) {
+    return { status: 'skipped' as const };
+  }
   return gateway.charge(card, order.total);
 }
diff --git a/migrations/0042_backfill.sql b/migrations/0042_backfill.sql
new file mode 100644
--- /dev/null
+++ b/migrations/0042_backfill.sql
@@ -0,0 +1,3 @@
+UPDATE orders
+   SET refunded_at = now()
+ WHERE status = 'refunded';
`;

// --- diff parsing ----------------------------------------------------------

test('files and hunks are parsed out of a unified diff', () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(
    files.map((f) => f.path),
    ['src/billing/charge.ts', 'migrations/0042_backfill.sql'],
  );
  assert.equal(files[0].hunks.length, 1);
  assert.match(files[0].hunks[0].header, /^@@ -41,6 \+41,11 @@/);
});

test('the +++ header is not mistaken for content', () => {
  const files = parseDiff(DIFF);
  const body = files[0].hunks[0].lines.join('\n');
  assert.doesNotMatch(body, /^\+\+\+/m);
  assert.match(body, /\+  if \(order\.refundedAt\)/);
});

test('changed lines count additions and removals only', () => {
  const files = parseDiff(DIFF);
  assert.equal(changedLines(files[1]), 3);
});

test('a citation is grounded only against a real file and hunk', () => {
  const files = parseDiff(DIFF);
  assert.ok(isGrounded(files, 'src/billing/charge.ts', '@@ -41,6 +41,11 @@'));
  // A hunk that exists, but in the other file.
  assert.ok(!isGrounded(files, 'migrations/0042_backfill.sql', '@@ -41,6 +41,11 @@'));
  // A file the PR never touched.
  assert.ok(!isGrounded(files, 'src/nope.ts', '@@ -41,6 +41,11 @@'));
  // A hunk header the model invented.
  assert.ok(!isGrounded(files, 'src/billing/charge.ts', '@@ -99,1 +99,1 @@'));
  assert.ok(!isGrounded(files, 'src/billing/charge.ts', 'the charge function'));
});

test('a trailing section heading does not break grounding', () => {
  // GitHub appends the enclosing symbol; models often drop or reword it.
  const files = parseDiff(DIFF);
  assert.ok(
    isGrounded(files, 'src/billing/charge.ts', '@@ -41,6 +41,11 @@ something else'),
  );
});

test('files that do not fit the budget are dropped whole, not truncated', () => {
  const files = parseDiff(DIFF);
  const { text, included } = renderForPrompt(files, 200);
  assert.ok(included.length < files.length);
  // Whatever survived is complete: every included file's hunk header is present.
  for (const f of included) {
    for (const h of f.hunks) assert.ok(text.includes(h.header));
  }
});

test('the largest change is preferred when the budget is tight', () => {
  const files = parseDiff(DIFF);
  const { included } = renderForPrompt(files, 400);
  assert.equal(included[0].path, 'src/billing/charge.ts');
});

// --- option shape ----------------------------------------------------------

const OK = {
  prompt: 'What does the new early return guard against?',
  options: ['Charging a refunded order', 'Charging an expired card', 'Double charging'],
  correct: 0,
  file: 'src/billing/charge.ts',
  hunk: '@@ -41,6 +41,11 @@',
  rationale: 'The guard checks order.refundedAt.',
};

test('a conspicuously longer correct option is rejected', () => {
  assert.ok(!wellFormed({ ...OK, options: [
    'Charging a card for an order that has already been refunded, which would double-bill',
    'Expiry',
    'Fraud',
  ] }));
});

test('duplicate options are rejected', () => {
  assert.ok(!wellFormed({ ...OK, options: ['Same', 'same', 'Other'] }));
});

test('too few options, or an out-of-range answer, are rejected', () => {
  assert.ok(!wellFormed({ ...OK, options: ['A', 'B'] }));
  assert.ok(!wellFormed({ ...OK, correct: 3 }));
  assert.ok(!wellFormed({ ...OK, correct: -1 }));
});

test('a balanced option set passes', () => {
  assert.ok(wellFormed(OK));
});

// --- the pipeline ----------------------------------------------------------

/**
 * A stub Provider. The vendor-specific shapes it used to imitate — message
 * envelopes, stop reasons, refusal blocks — now belong to `providers.ts`, and
 * testing them here would be testing the wrong file.
 */
function stub(handler: (prompt: string, n: number) => unknown) {
  const prompts: string[] = [];
  let n = 0;
  return {
    prompts,
    client: {
      label: 'stub:model',
      complete: async (prompt: string) => {
        prompts.push(prompt);
        const r = handler(prompt, n++);
        if (r instanceof Error) throw r;
        return r as string;
      },
    } satisfies Provider,
  };
}

function json(value: unknown) {
  return JSON.stringify(value);
}

/** Proposer prompts carry the diff; verifier prompts carry the claimed answer. */
function isVerify(prompt: string) {
  return prompt.includes('claimed answer');
}

test('a proposed question that verifies is asked', async () => {
  const { client } = stub((p) =>
    isVerify(p) ? json({ sound: true, problem: '' }) : json({ questions: [OK] }),
  );
  const result = await generateFromDiff(client, DIFF, DEFAULTS);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.equal(result.quiz.questions.length, 1);
  assert.equal(result.quiz.questions[0].file, 'src/billing/charge.ts');
  assert.equal(result.quiz.correct[0], 0);
});

test('a question the verifier refutes is dropped', async () => {
  const { client } = stub((p) =>
    isVerify(p)
      ? json({ sound: false, problem: 'the stated answer is wrong' })
      : json({ questions: [OK] }),
  );
  const result = await generateFromDiff(client, DIFF, DEFAULTS);
  assert.equal(result.kind, 'skip');
  assert.match(result.kind === 'skip' ? result.reason : '', /survived verification/);
});

test('an unclear verdict is a rejection, never an approval', async () => {
  // The dangerous direction: a verifier that fails to answer must not be read
  // as agreeing.
  for (const verdict of [{}, { sound: 'yes' }, { sound: 1 }, { sound: null }]) {
    const { client } = stub((p) =>
      isVerify(p) ? json(verdict) : json({ questions: [OK] }),
    );
    const result = await generateFromDiff(client, DIFF, DEFAULTS);
    assert.equal(result.kind, 'skip', JSON.stringify(verdict));
  }
});

test('a verifier that errors drops its question rather than passing it', async () => {
  const { client } = stub((p) =>
    isVerify(p) ? new Error('529 overloaded') : json({ questions: [OK] }),
  );
  assert.equal((await generateFromDiff(client, DIFF, DEFAULTS)).kind, 'skip');
});

test('an ungrounded citation is dropped before costing a verification call', async () => {
  const { client, prompts } = stub((p) =>
    isVerify(p) ? json({ sound: true, problem: '' }) : json({
      questions: [{ ...OK, file: 'src/imaginary.ts' }],
    }),
  );
  const result = await generateFromDiff(client, DIFF, DEFAULTS);
  assert.equal(result.kind, 'skip');
  assert.match(result.kind === 'skip' ? result.reason : '', /ground/);
  assert.equal(prompts.filter(isVerify).length, 0, 'no verification call spent');
});

test('each surviving question is verified independently', async () => {
  const two = [OK, { ...OK, prompt: 'Which file can affect existing rows?' }];
  const { client, prompts } = stub((p) =>
    isVerify(p) ? json({ sound: true, problem: '' }) : json({ questions: two }),
  );
  await generateFromDiff(client, DIFF, DEFAULTS);
  assert.equal(prompts.filter(isVerify).length, 2);
});

test('the verifier is not shown the proposer conversation', async () => {
  const { client, prompts } = stub((p) =>
    isVerify(p) ? json({ sound: true, problem: '' }) : json({ questions: [OK] }),
  );
  await generateFromDiff(client, DIFF, DEFAULTS);
  const verify = prompts.find(isVerify)!;
  assert.match(verify, /Assume it is flawed/);
  assert.doesNotMatch(verify, /You are writing a short comprehension check/);
});

test('the configured question count caps what is asked', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ ...OK, prompt: `Q${i}?` }));
  const { client } = stub((p) =>
    isVerify(p) ? json({ sound: true, problem: '' }) : json({ questions: many }),
  );
  const result = await generateFromDiff(client, DIFF, { ...DEFAULTS, questions: 2 });
  assert.equal(result.kind === 'ok' && result.quiz.questions.length, 2);
});

test('difficulty reaches the proposer', async () => {
  const { client, prompts } = stub((p) =>
    isVerify(p) ? json({ sound: true, problem: '' }) : json({ questions: [OK] }),
  );
  await generateFromDiff(client, DIFF, { ...DEFAULTS, difficulty: 'hard' });
  assert.match(prompts[0], /plausible misreading/);
});

test('the proposer is told not to ask statistics questions', async () => {
  const { client, prompts } = stub((p) =>
    isVerify(p) ? json({ sound: true, problem: '' }) : json({ questions: [OK] }),
  );
  await generateFromDiff(client, DIFF, DEFAULTS);
  assert.match(prompts[0], /most lines added/);
  assert.match(prompts[0], /trivia/);
});

test('an empty diff never reaches a model', async () => {
  const { client, prompts } = stub(() => json({ questions: [OK] }));
  const result = await generateFromDiff(client, 'not a diff', DEFAULTS);
  assert.equal(result.kind, 'skip');
  assert.equal(prompts.length, 0);
});

test('a generator failure is a skip with a reason, never a throw', async () => {
  const cases: unknown[] = [
    new Error('529 overloaded'),
    { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] },
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"quest' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"questions":"no"}' }] },
  ];
  for (const c of cases) {
    const { client } = stub(() => c);
    const result = await generateFromDiff(client, DIFF, DEFAULTS);
    assert.equal(result.kind, 'skip', JSON.stringify(c));
    assert.ok(
      result.kind === 'skip' && result.reason.length > 0,
      'the check run needs something to show',
    );
  }
});

test('a malformed candidate is dropped without killing the batch', async () => {
  const { client } = stub((p) =>
    isVerify(p)
      ? json({ sound: true, problem: '' })
      : json({ questions: [{ prompt: 'no options' }, OK] }),
  );
  const result = await generateFromDiff(client, DIFF, DEFAULTS);
  assert.equal(result.kind === 'ok' && result.quiz.questions.length, 1);
});
