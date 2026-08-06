import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AnthropicProvider,
  DEFAULT_VENDOR,
  GeminiProvider,
  OpenAIProvider,
  ProviderError,
  VENDORS,
  available,
  plain,
  resolve,
  strictify,
  unfence,
} from './providers.ts';

const ALL_KEYS = VENDORS.flatMap((v) => v.envKeys);

/** Run `fn` with only `set` present among the vendor keys. */
function withKeys(set: string[], fn: () => void): void {
  const saved = new Map(ALL_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const key of ALL_KEYS) delete process.env[key];
    for (const key of set) process.env[key] = 'test-key';
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('an unknown provider lists the known ones', () => {
  withKeys(['ANTHROPIC_API_KEY'], () => {
    assert.throws(() => resolve('claude'), (err: Error) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.message, /Unknown provider/);
      for (const vendor of VENDORS) assert.ok(err.message.includes(vendor.name));
      return true;
    });
  });
});

test('a missing key names the variable and says it is a secret', () => {
  withKeys([], () => {
    assert.throws(() => resolve('openai'), /OPENAI_API_KEY.*secret/s);
  });
});

test('a missing key points at the ones the repo does have', () => {
  withKeys(['ANTHROPIC_API_KEY'], () => {
    assert.throws(() => resolve('gemini'), /has a key for: anthropic/);
  });
});

test('gemini accepts either google variable', () => {
  withKeys(['GOOGLE_API_KEY'], () => assert.ok(available().includes('gemini')));
  withKeys(['GEMINI_API_KEY'], () => assert.ok(available().includes('gemini')));
});

test('available reports only what is set', () => {
  withKeys(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], () => {
    assert.deepEqual(available().sort(), ['anthropic', 'openai']);
  });
});

test('an absent spec means the default vendor', () => {
  withKeys(ALL_KEYS, () => {
    assert.ok(resolve(undefined).label.startsWith(`${DEFAULT_VENDOR}:`));
    assert.ok(resolve(null).label.startsWith(`${DEFAULT_VENDOR}:`));
  });
});

test('the vendor:model form is honoured', () => {
  withKeys(['ANTHROPIC_API_KEY'], () => {
    assert.equal(resolve('anthropic:claude-sonnet-5').label, 'anthropic:claude-sonnet-5');
  });
});

test('each vendor has a default model', () => {
  withKeys(ALL_KEYS, () => {
    for (const vendor of VENDORS) {
      assert.equal(resolve(vendor.name).label, `${vendor.name}:${vendor.defaultModel}`);
    }
  });
});

// --- schema transforms -----------------------------------------------------

const NESTED = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { prompt: { type: 'string' }, correct: { type: 'integer' } },
        required: ['prompt', 'correct'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

type Schema = Record<string, any>;

test('strictify requires every property at every depth', () => {
  const out = strictify(NESTED) as Schema;
  assert.deepEqual(out.required, ['questions']);
  const item = out.properties.questions.items as Schema;
  assert.deepEqual([...item.required].sort(), ['correct', 'prompt']);
  assert.equal(item.additionalProperties, false);
});

test('strictify adds required where it was missing', () => {
  const out = strictify({
    type: 'object',
    properties: { a: { type: 'string' } },
  }) as Record<string, unknown>;
  assert.deepEqual(out.required, ['a']);
  assert.equal(out.additionalProperties, false);
});

test('strictify leaves the original alone', () => {
  const before = JSON.stringify(NESTED);
  strictify(NESTED);
  assert.equal(JSON.stringify(NESTED), before);
});

test('plain strips additionalProperties at every depth', () => {
  const out = plain(NESTED) as Schema;
  assert.ok(!('additionalProperties' in out));
  const item = out.properties.questions.items as Schema;
  assert.ok(!('additionalProperties' in item));
  // Everything else survives.
  assert.deepEqual(out.required, ['questions']);
  assert.deepEqual(item.properties.prompt, { type: 'string' });
});

test('plain leaves the original alone', () => {
  const before = JSON.stringify(NESTED);
  plain(NESTED);
  assert.equal(JSON.stringify(NESTED), before);
});

// --- searching, per vendor -------------------------------------------------
//
// These are the wire formats the three vendors want for a server-side search,
// and the failure modes each expresses as a 200 rather than a throw. They used
// to be tested through `concepts.ts`, which is why that file took an Anthropic
// client; now that any vendor can search, they belong to the layer that knows
// what a vendor looks like. Every case injects a client, so none of it needs a
// network or a key.

const SCHEMA = { type: 'object' as const, properties: { ok: { type: 'string' } } };

function anthropicClient(...responses: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  return {
    calls,
    client: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          const r = responses[Math.min(i, responses.length - 1)];
          i++;
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  };
}

const said = (text: string, stop_reason = 'end_turn') => ({
  stop_reason,
  content: [{ type: 'text', text }],
});

test('anthropic declares web search only when asked to search', async () => {
  const withSearch = anthropicClient(said('{"ok":"yes"}'));
  await new AnthropicProvider('m', 'k', {
    search: true,
    client: withSearch.client,
  }).complete('p', SCHEMA);
  assert.deepEqual(
    (withSearch.calls[0].tools as { type: string }[]).map((t) => t.type),
    ['web_search_20260209'],
    'the 2026-02-09 variant filters internally — a second execution environment confuses the model',
  );

  const plainCall = anthropicClient(said('{"ok":"yes"}'));
  await new AnthropicProvider('m', 'k', { client: plainCall.client }).complete('p', SCHEMA);
  assert.equal(plainCall.calls[0].tools, undefined, 'no tool when nobody asked for one');
});

test('anthropic resumes a paused server-tool turn rather than abandoning it', async () => {
  const { client, calls } = anthropicClient(
    said('searching', 'pause_turn'),
    said('{"ok":"yes"}'),
  );
  const text = await new AnthropicProvider('m', 'k', { search: true, client }).complete(
    'p',
    SCHEMA,
  );
  assert.equal(text, '{"ok":"yes"}');
  assert.equal(calls.length, 2);
  // The resume appends the partial assistant turn and adds no user message: the
  // server picks up on its own.
  assert.deepEqual(
    (calls[1].messages as { role: string }[]).map((m) => m.role),
    ['user', 'assistant'],
  );
});

test('an endlessly paused turn gives up rather than looping', async () => {
  const { client, calls } = anthropicClient(said('', 'pause_turn'));
  await assert.rejects(
    () => new AnthropicProvider('m', 'k', { search: true, client }).complete('p', SCHEMA),
    ProviderError,
  );
  assert.ok(calls.length <= 6, `bounded, got ${calls.length} calls`);
});

test('anthropic refusal and truncation are errors, not empty answers', async () => {
  const refusal = anthropicClient({
    stop_reason: 'refusal',
    stop_details: { category: 'cyber' },
    content: [],
  });
  await assert.rejects(
    () => new AnthropicProvider('m', 'k', { client: refusal.client }).complete('p', SCHEMA),
    /cyber/,
  );

  const truncated = anthropicClient(said('{"ok":"ye', 'max_tokens'));
  await assert.rejects(
    () => new AnthropicProvider('m', 'k', { client: truncated.client }).complete('p', SCHEMA),
    /truncated/,
  );
});

test('openai declares web search only when asked to search', async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    responses: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params);
        return { output_text: '{"ok":"yes"}', status: 'completed' };
      },
    },
  };
  await new OpenAIProvider('m', 'k', { search: true, client }).complete('p', SCHEMA);
  assert.deepEqual(
    (calls[0].tools as { type: string }[]).map((t) => t.type),
    ['web_search'],
  );
  assert.ok(calls[0].text, 'and the schema still constrains the answer');

  await new OpenAIProvider('m', 'k', { client }).complete('p', SCHEMA);
  assert.equal(calls[1].tools, undefined);
});

test('gemini swaps its response schema for search grounding', async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    models: {
      generateContent: async (params: Record<string, unknown>) => {
        calls.push(params);
        return { text: '{"ok":"yes"}' };
      },
    },
  };

  await new GeminiProvider('m', 'k', { search: true, client }).complete('p', SCHEMA);
  const searching = calls[0].config as Record<string, unknown>;
  assert.deepEqual(searching.tools, [{ googleSearch: {} }]);
  assert.equal(
    searching.responseJsonSchema,
    undefined,
    'sending both is a 400, not an ignored field',
  );
  assert.match(
    String(calls[0].contents),
    /Reply with JSON matching this schema/,
    'so the schema has to be described instead',
  );

  await new GeminiProvider('m', 'k', { client }).complete('p', SCHEMA);
  const plainCall = calls[1].config as Record<string, unknown>;
  assert.ok(plainCall.responseJsonSchema, 'and without search it goes back to declaring it');
  assert.equal(plainCall.tools, undefined);
});

test('a fenced answer is unwrapped, an unfenced one is untouched', () => {
  assert.equal(unfence('```json\n{"ok":"yes"}\n```'), '{"ok":"yes"}');
  assert.equal(unfence('```\n{"ok":"yes"}\n```'), '{"ok":"yes"}');
  assert.equal(unfence('{"ok":"yes"}'), '{"ok":"yes"}');
  assert.equal(unfence('no json here'), 'no json here');
});
