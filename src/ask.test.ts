import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ask,
  hasWriteAccess,
  parseMention,
  renderAnswer,
  type Answer,
} from './ask.ts';
import type { Provider } from './providers.ts';

/** A stub provider: the vendor wire formats are `providers.test.ts`'s job. */
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

function reply(kind: string, body: string) {
  return JSON.stringify({ kind, body });
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
  const text = calls[0].prompt;
  assert.match(text, /reading_for_you/);
  assert.match(text, /what does this PR do/);
  assert.match(text, /ambiguous/,  'ambiguity must resolve toward declining');
});

// --- failure paths ---------------------------------------------------------

test('bad JSON, a missing body, nothing at all, and errors are unavailable', async () => {
  const cases: (string | Error)[] = [
    'not json',
    '{"kind":"background"}',
    '',
    new Error('529 overloaded'),
  ];
  for (const c of cases) {
    const { client } = stub(c);
    assert.equal((await ask(client, INPUT)).kind, 'unavailable', String(c));
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

// --- the write-access gate -------------------------------------------------

test('owners, org members, and collaborators may ask', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.ok(hasWriteAccess(a), a);
  }
});

test('everyone without write access is refused', () => {
  for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE']) {
    assert.ok(!hasWriteAccess(a), a);
  }
});

test('an unrecognised association is refused, not assumed', () => {
  // GitHub can add values; a name this predicate does not know must never be
  // read as permission.
  for (const a of ['', 'owner', 'Owner', 'ADMIN', 'TRIAGE', 'WRITE', 'undefined']) {
    assert.ok(!hasWriteAccess(a), JSON.stringify(a));
  }
});
