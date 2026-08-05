import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ask, parseMention, renderAnswer, type Answer } from './ask.ts';

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

function reply(kind: string, body: string, stop_reason = 'end_turn') {
  return {
    stop_reason,
    content: [{ type: 'text', text: JSON.stringify({ kind, body }) }],
  };
}

const INPUT = { question: 'what is an HMAC?', diff: '@@ -1 +1 @@', asker: 'alice' };

// --- mention parsing -------------------------------------------------------

test('a mention at the start of a line carries the question', () => {
  assert.equal(parseMention('@lgtm what is a CRDT?', 'lgtm[bot]'), 'what is a CRDT?');
  assert.equal(parseMention('@lgtm[bot] what is a CRDT?', 'lgtm[bot]'), 'what is a CRDT?');
});

test('a mention on a later line still counts', () => {
  assert.equal(
    parseMention('Looks good to me.\n\n@lgtm why use SELECT FOR UPDATE?', 'lgtm[bot]'),
    'why use SELECT FOR UPDATE?',
  );
});

test('a passing reference in prose does not summon a reply', () => {
  assert.equal(parseMention('you could ask @lgtm about it', 'lgtm[bot]'), null);
  assert.equal(parseMention('cc @lgtm', 'lgtm[bot]'), null);
});

test('a bare mention with no question says nothing', () => {
  assert.equal(parseMention('@lgtm', 'lgtm[bot]'), null);
  assert.equal(parseMention('@lgtm   \n', 'lgtm[bot]'), null);
});

test('a different bot is not us', () => {
  assert.equal(parseMention('@dependabot rebase', 'lgtm[bot]'), null);
});

test('a handle with regex characters is matched literally', () => {
  assert.equal(parseMention('@lgtm.dev hello', 'lgtm.dev'), 'hello');
  assert.equal(parseMention('@lgtmXdev hello', 'lgtm.dev'), null);
});

// --- the decline boundary --------------------------------------------------

test('a background question is answered', async () => {
  const { client } = stub(reply('background', 'An HMAC is a keyed hash...'));
  const result = await ask(client, INPUT);
  assert.equal(result.kind, 'answered');
});

test('a summarise-the-PR question is declined', async () => {
  const { client } = stub(
    reply('reading_for_you', 'The change is in `src/billing/charge.ts` — worth a look.'),
  );
  const result = await ask(client, { ...INPUT, question: 'what does this PR do?' });
  assert.equal(result.kind, 'declined');
});

test('an unrecognised classification falls to declined, not answered', async () => {
  // The failure that matters is answering something we should have declined,
  // so anything other than an explicit `background` must not be answered.
  for (const kind of ['summary', '', 'BACKGROUND', 'unknown']) {
    const { client } = stub(reply(kind, 'body text'));
    const result = await ask(client, INPUT);
    assert.equal(result.kind, 'declined', `kind=${JSON.stringify(kind)}`);
  }
});

test('the prompt teaches the boundary and forbids summarising', async () => {
  const { client, calls } = stub(reply('background', 'x'));
  await ask(client, INPUT);
  const text = JSON.stringify(calls[0]);
  assert.match(text, /reading_for_you/);
  assert.match(text, /what does this PR do/);
  assert.match(text, /ambiguous/,  'ambiguity must resolve toward declining');
});

test('the request declares web search so docs questions can be sourced', async () => {
  const { client, calls } = stub(reply('background', 'x'));
  await ask(client, INPUT);
  const params = calls[0] as { tools: { type: string }[] };
  assert.deepEqual(
    params.tools.map((t) => t.type),
    ['web_search_20260209'],
  );
});

// --- failure paths ---------------------------------------------------------

test('a paused turn is resumed', async () => {
  const { client, calls } = stub(
    { stop_reason: 'pause_turn', content: [{ type: 'text', text: '' }] },
    reply('background', 'answer'),
  );
  assert.equal((await ask(client, INPUT)).kind, 'answered');
  assert.equal(calls.length, 2);
});

test('refusal, truncation, bad JSON, and errors are all unavailable', async () => {
  const cases: unknown[] = [
    { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] },
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"kind":"back' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"kind":"background"}' }] },
    { stop_reason: 'end_turn', content: [] },
    new Error('529 overloaded'),
  ];
  for (const c of cases) {
    const { client } = stub(c);
    assert.equal((await ask(client, INPUT)).kind, 'unavailable', JSON.stringify(c));
  }
});

test('an unavailable answer renders as nothing — we post no reply', () => {
  const a: Answer = { kind: 'unavailable', reason: 'overloaded' };
  assert.equal(renderAnswer('alice', a), null);
});

// --- rendering -------------------------------------------------------------

test('an answer addresses the asker', () => {
  const body = renderAnswer('alice', { kind: 'answered', text: 'A keyed hash.' });
  assert.match(body!, /^@alice /);
  assert.doesNotMatch(body!, /don't summarise/);
});

test('a decline explains why without scolding', () => {
  const body = renderAnswer('alice', {
    kind: 'declined',
    text: 'Have a look at `src/billing/charge.ts`.',
  })!;
  assert.match(body, /@alice/);
  assert.match(body, /reading it is the part/i);
  assert.doesNotMatch(body, /cannot|refuse|not allowed|won't help/i);
});
