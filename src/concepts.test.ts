import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CONCEPTS,
  explainConcepts,
  renderConcepts,
  type Concept,
} from './concepts.ts';
import type { Provider } from './providers.ts';

/**
 * A stub provider. Every test here runs offline, and since the vendor wire
 * formats moved into `providers.ts`, what is left to pin is what this file does
 * with the text it gets back — which is the same work whoever produced it.
 */
function stub(...responses: (string | Error)[]) {
  const calls: { prompt: string; schema: unknown }[] = [];
  let i = 0;
  const client: Provider = {
    label: 'stub:model',
    complete: async (prompt: string, schema: Record<string, unknown>) => {
      calls.push({ prompt, schema });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { calls, client };
}

function reply(concepts: unknown) {
  return JSON.stringify({ concepts });
}

const INPUT = { diff: '@@ -1 +1 @@\n+hmac(key, body)', context: 'ts', max: MAX_CONCEPTS };

const GOOD: Concept = {
  term: 'HMAC',
  why: 'This PR authenticates webhook bodies with one.',
  title: 'RFC 2104',
  url: 'https://www.rfc-editor.org/rfc/rfc2104',
};

test('a well-formed answer comes through', async () => {
  const { client } = stub(reply([GOOD]));
  const result = await explainConcepts(client, INPUT);
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.kind === 'ok' && result.concepts, [GOOD]);
});

test('the diff and the schema both reach the provider', async () => {
  const { client, calls } = stub(reply([]));
  await explainConcepts(client, INPUT);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /hmac\(key, body\)/, 'the diff is what it reasons about');
  assert.ok(calls[0].schema, 'the answer must be schema-constrained');
});

test('zero concepts is a valid answer, not a failure', async () => {
  const { client } = stub(reply([]));
  const result = await explainConcepts(client, INPUT);
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.kind === 'ok' && result.concepts, []);
  assert.equal(renderConcepts([]), null, 'and it renders as nothing at all');
});

test('a fabricated or non-http URL is dropped, not published', async () => {
  const bad = [
    { ...GOOD, url: '/docs/hmac' },
    { ...GOOD, url: 'javascript:alert(1)' },
    { ...GOOD, url: 'not a url' },
    { ...GOOD, url: '' },
  ];
  const { client } = stub(reply(bad));
  const result = await explainConcepts(client, INPUT);
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.kind === 'ok' && result.concepts, []);
});

test('an entry missing a field is dropped without losing the good ones', async () => {
  const { client } = stub(reply([{ term: 'HMAC' }, GOOD, { ...GOOD, why: '  ' }]));
  const result = await explainConcepts(client, INPUT);
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.kind === 'ok' && result.concepts, [GOOD]);
});

test('the cap holds even if the model ignores it', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ ...GOOD, term: `t${i}` }));
  const { client } = stub(reply(many));
  const result = await explainConcepts(client, INPUT);
  assert.equal(result.kind === 'ok' && result.concepts.length, MAX_CONCEPTS);
});

test('unparseable and empty responses are unavailable', async () => {
  for (const text of ['Sure! Here are some concepts...', '', '   ']) {
    const { client } = stub(text);
    assert.equal((await explainConcepts(client, INPUT)).kind, 'unavailable');
  }
});

test('a JSON object without a concepts array is unavailable', async () => {
  const { client } = stub('{"summary":"this PR adds signing"}');
  assert.equal((await explainConcepts(client, INPUT)).kind, 'unavailable');
});

test('a provider failure never escapes', async () => {
  const { client } = stub(new Error('529 overloaded'));
  const result = await explainConcepts(client, INPUT);
  assert.equal(result.kind, 'unavailable');
  assert.match(result.kind === 'unavailable' ? result.reason : '', /overloaded/);
});

test('the rendered section names the term and links out', () => {
  const rendered = renderConcepts([GOOD]);
  assert.match(rendered!, /\*\*HMAC\*\*/);
  assert.match(rendered!, /\(https:\/\/www\.rfc-editor\.org\/rfc\/rfc2104\)/);
  assert.match(rendered!, /Might be worth a look/);
});
