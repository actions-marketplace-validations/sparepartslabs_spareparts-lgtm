/**
 * One structured call, from any of three vendors.
 *
 * Everything LGTM asks a model to do has the same shape: here is a prompt, here
 * is a JSON Schema, return an object matching it. That is the entire interface,
 * deliberately — no streaming, no tools, no conversation.
 *
 * The three vendors express it differently:
 *
 *     Anthropic   output_config={"format": {"type": "json_schema", ...}}
 *     OpenAI      text={"format": {"type": "json_schema", "strict": true, ...}}
 *     Gemini      config.responseJsonSchema + responseMimeType
 *
 * so each adapter handles its own spelling, and its own failure modes that are
 * not exceptions: Anthropic's `pause_turn`, OpenAI's `refusal` content part,
 * Gemini's non-STOP finish reason. Read the text without checking and a refusal
 * becomes "returned nothing".
 *
 * Why more than one at all: the generator proposes a question with one call and
 * asks a second to refute it. Two calls to the same model is a weaker check
 * than it looks — a model agrees with itself. Proposing with one vendor and
 * refuting with another is the strongest version of that check available, and
 * it is the reason this file exists rather than a `model` config key.
 *
 * Ported from `spareparts.providers` in `sparepartslabs/spareparts-cli`.
 */

// Type-only, so the SDK is not loaded unless the vendor is actually chosen.
// The value imports below are dynamic for the same reason.
import type Anthropic from '@anthropic-ai/sdk';

export class ProviderError extends Error {}

export interface Provider {
  /** e.g. `anthropic:claude-opus-5`. Printed, and used to tell the two apart. */
  label: string;
  complete(prompt: string, schema: Record<string, unknown>): Promise<string>;
}

export interface Vendor {
  name: string;
  /**
   * The model used when nobody names one.
   *
   * Each was picked by listing the vendor's models against a live key, not
   * from memory — `gpt-5` and `gemini-2.5-pro` both still exist but are a year
   * behind, which is exactly the failure a remembered default produces: it
   * works, so nobody notices it is wrong.
   *
   * Gemini's is the tracking alias because the vendor publishes no plain
   * `gemini-3.x-pro`, only `-image` variants, so a pinned pro model would mean
   * pinning to 2.5 indefinitely. The other two pin, because a default that
   * moves underneath a quiz changes what the quiz asks.
   */
  defaultModel: string;
  /** Checked before the call, so a missing key is a sentence not a stack trace. */
  envKeys: string[];
}

export const VENDORS: Vendor[] = [
  {
    name: 'anthropic',
    defaultModel: 'claude-opus-5',
    envKeys: ['ANTHROPIC_API_KEY'],
  },
  { name: 'openai', defaultModel: 'gpt-5.5', envKeys: ['OPENAI_API_KEY'] },
  {
    name: 'gemini',
    defaultModel: 'gemini-pro-latest',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
];

export const DEFAULT_VENDOR = 'anthropic';

const MAX_TOKENS = 16000;

function keyFor(vendor: Vendor): string | undefined {
  for (const key of vendor.envKeys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

/** Vendors whose key is set. Used to explain what the repo could pick. */
export function available(): string[] {
  return VENDORS.filter((v) => keyFor(v)).map((v) => v.name);
}

/**
 * Turn `"openai"` or `"openai:gpt-5.5"` into something callable.
 *
 * Never throws for a *missing* configuration — an absent spec means the default
 * vendor. It throws for a wrong one, because a repo that asked for a vendor it
 * cannot reach should be told, not quietly given a different model.
 */
export function resolve(spec?: string | null): Provider {
  const [rawName, specModel] = (spec || DEFAULT_VENDOR).split(':');
  const name = rawName.trim().toLowerCase();

  const vendor = VENDORS.find((v) => v.name === name);
  if (!vendor) {
    const known = VENDORS.map((v) => v.name).join(', ');
    throw new ProviderError(`Unknown provider '${name}'. Known providers: ${known}.`);
  }

  const key = keyFor(vendor);
  if (!key) {
    const keys = vendor.envKeys.join(' or ');
    const others = available().filter((n) => n !== name);
    const hint = others.length ? ` This repo has a key for: ${others.join(', ')}.` : '';
    throw new ProviderError(`${vendor.name} needs ${keys} set as a secret.${hint}`);
  }

  const model = specModel?.trim() || vendor.defaultModel;
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(model, key);
    case 'openai':
      return new OpenAIProvider(model, key);
    default:
      return new GeminiProvider(model, key);
  }
}

// --- anthropic -------------------------------------------------------------

const MAX_CONTINUATIONS = 2;

class AnthropicProvider implements Provider {
  label: string;
  constructor(
    private model: string,
    private apiKey: string,
  ) {
    this.label = `anthropic:${model}`;
  }

  async complete(prompt: string, schema: Record<string, unknown>): Promise<string> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];

    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          output_config: { effort: 'high', format: { type: 'json_schema', schema } },
          messages,
        });
      } catch (err) {
        throw new ProviderError(`${this.label}: ${describe(err)}`);
      }

      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category ?? 'unspecified';
        throw new ProviderError(`${this.label} declined (${category}).`);
      }
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      if (response.stop_reason === 'max_tokens') {
        throw new ProviderError(`${this.label}: response was truncated.`);
      }

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!text.trim()) throw new ProviderError(`${this.label} returned nothing.`);
      return text;
    }

    throw new ProviderError(`${this.label}: the turn never finished.`);
  }
}

// --- openai ----------------------------------------------------------------

/**
 * Every object requires all its properties and forbids extras, recursively.
 *
 * `strict: true` is why we use this shape rather than asking for JSON in the
 * prompt — the schema is enforced by the decoder rather than hoped for. It also
 * constrains what the schema may say, and a schema that quietly fails strict
 * validation surfaces as an unhelpful 400.
 */
export function strictify(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictify);
  if (typeof schema !== 'object' || schema === null) return schema;

  const out: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    const properties = out.properties as Record<string, unknown>;
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([k, v]) => [k, strictify(v)]),
    );
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  if (out.items !== undefined) out.items = strictify(out.items);
  return out;
}

class OpenAIProvider implements Provider {
  label: string;
  constructor(
    private model: string,
    private apiKey: string,
  ) {
    this.label = `openai:${model}`;
  }

  async complete(prompt: string, schema: Record<string, unknown>): Promise<string> {
    let OpenAI;
    try {
      ({ default: OpenAI } = await import('openai'));
    } catch {
      throw new ProviderError(
        "openai is not installed — add it to the action's dependencies.",
      );
    }

    const client = new OpenAI({ apiKey: this.apiKey });
    let response;
    try {
      response = await client.responses.create({
        model: this.model,
        input: prompt,
        max_output_tokens: MAX_TOKENS,
        reasoning: { effort: 'high' },
        text: {
          format: {
            type: 'json_schema',
            name: 'result',
            strict: true,
            schema: strictify(schema) as Record<string, unknown>,
          },
        },
      });
    } catch (err) {
      throw new ProviderError(`${this.label}: ${describe(err)}`);
    }

    // A refusal arrives as a content part, not an exception. Reading
    // output_text without looking would turn it into "returned nothing".
    for (const item of response.output ?? []) {
      for (const part of (item as { content?: { type?: string; refusal?: string }[] })
        .content ?? []) {
        if (part.type === 'refusal') {
          throw new ProviderError(
            `${this.label} declined (${part.refusal || 'unspecified'}).`,
          );
        }
      }
    }

    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason ?? 'unspecified';
      throw new ProviderError(`${this.label}: response was incomplete (${reason}).`);
    }

    const text = response.output_text ?? '';
    if (!text.trim()) throw new ProviderError(`${this.label} returned nothing.`);
    return text;
  }
}

// --- gemini ----------------------------------------------------------------

/**
 * The schema without keywords Gemini does not model.
 *
 * `additionalProperties` carries no meaning here — the decoder is already
 * constrained to the schema — and passing a keyword a vendor does not model is
 * a 400 rather than an ignored field.
 */
export function plain(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(plain);
  if (typeof schema !== 'object' || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([k]) => k !== 'additionalProperties')
      .map(([k, v]) => [k, plain(v)]),
  );
}

class GeminiProvider implements Provider {
  label: string;
  constructor(
    private model: string,
    private apiKey: string,
  ) {
    this.label = `gemini:${model}`;
  }

  async complete(prompt: string, schema: Record<string, unknown>): Promise<string> {
    let GoogleGenAI;
    try {
      ({ GoogleGenAI } = await import('@google/genai'));
    } catch {
      throw new ProviderError(
        "@google/genai is not installed — add it to the action's dependencies.",
      );
    }

    const client = new GoogleGenAI({ apiKey: this.apiKey });
    let response;
    try {
      response = await client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: plain(schema),
          maxOutputTokens: MAX_TOKENS,
        },
      });
    } catch (err) {
      throw new ProviderError(`${this.label}: ${describe(err)}`);
    }

    const blocked = response.promptFeedback?.blockReason;
    if (blocked) {
      throw new ProviderError(`${this.label} blocked the prompt (${blocked}).`);
    }

    const finish = response.candidates?.[0]?.finishReason;
    // `undefined` happens on some shapes; only an explicit non-STOP is a fault.
    if (finish !== undefined && String(finish) !== 'STOP') {
      throw new ProviderError(`${this.label} stopped early (${finish}).`);
    }

    const text = response.text ?? '';
    if (!text.trim()) throw new ProviderError(`${this.label} returned nothing.`);
    return text;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
