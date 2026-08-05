import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CONCEPTS,
  MODEL,
  explainConcepts,
  renderConcepts,
  type Concept,
} from './concepts.ts';

/**
 * A stub standing in for the SDK client. Every test here runs offline: the
 * behaviour worth pinning is what we do with the model's answer, not the
 * model's answer itself.
 */
function stub(...responses: unknown[]) {
  const calls: unknown[] = [];
  let i = 0;
  return {
    calls,
    client: {
      messages: {
        create: async (params: unknown) => {
          calls.push(params);
          const r = responses[Math.min(i, responses.length - 1)];
          i++;
          if (r instanceof Error) throw r;
          return r;
        },
      },
    } as never,
  };
}

function reply(concepts: unknown, stop_reason = 'end_turn') {
  return {
    stop_reason,
    content: [{ type: 'text', text: JSON.stringify({ concepts }) }],
  };
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

test('the request declares web search and not code execution', async () => {
  const { client, calls } = stub(reply([]));
  await explainConcepts(client, INPUT);
  const params = calls[0] as {
    model: string;
    tools: { type: string }[];
    output_config: unknown;
  };
  assert.equal(params.model, MODEL);
  assert.deepEqual(
    params.tools.map((t) => t.type),
    ['web_search_20260209'],
    'the 2026-02-09 variant filters internally — a second execution environment confuses the model',
  );
  assert.ok(params.output_config, 'the answer must be schema-constrained');
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

test('a refusal is unavailable, never an exception', async () => {
  const { client } = stub({
    stop_reason: 'refusal',
    stop_details: { category: 'cyber' },
    content: [],
  });
  const result = await explainConcepts(client, INPUT);
  assert.equal(result.kind, 'unavailable');
  assert.match(result.kind === 'unavailable' ? result.reason : '', /cyber/);
});

test('a paused server-tool turn is resumed, not abandoned', async () => {
  const { client, calls } = stub(
    { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'searching' }] },
    reply([GOOD]),
  );
  const result = await explainConcepts(client, INPUT);
  assert.equal(result.kind, 'ok');
  assert.equal(calls.length, 2);
  // The resume appends the partial assistant turn and adds no user message —
  // the server resumes on its own.
  const second = calls[1] as { messages: { role: string }[] };
  assert.deepEqual(
    second.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
});

test('an endlessly paused turn gives up rather than looping', async () => {
  const { client, calls } = stub({ stop_reason: 'pause_turn', content: [] });
  const result = await explainConcepts(client, INPUT);
  assert.equal(result.kind, 'unavailable');
  assert.ok(calls.length <= 6, `bounded, got ${calls.length} calls`);
});

test('truncation is unavailable — a half-written answer is not an answer', async () => {
  const { client } = stub({
    stop_reason: 'max_tokens',
    content: [{ type: 'text', text: '{"concepts":[{"term":"HM' }],
  });
  assert.equal((await explainConcepts(client, INPUT)).kind, 'unavailable');
});

test('unparseable and empty responses are unavailable', async () => {
  for (const content of [
    [{ type: 'text', text: 'Sure! Here are some concepts...' }],
    [{ type: 'text', text: '' }],
    [],
  ]) {
    const { client } = stub({ stop_reason: 'end_turn', content });
    assert.equal((await explainConcepts(client, INPUT)).kind, 'unavailable');
  }
});

test('a JSON object without a concepts array is unavailable', async () => {
  const { client } = stub({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"summary":"this PR adds signing"}' }],
  });
  assert.equal((await explainConcepts(client, INPUT)).kind, 'unavailable');
});

test('a thrown API error never escapes', async () => {
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
