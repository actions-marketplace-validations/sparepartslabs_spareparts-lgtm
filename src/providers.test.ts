import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_VENDOR, VENDORS, ProviderError, available, plain, resolve, strictify } from './providers.ts';

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
