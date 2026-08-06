/**
 * One structured call, from any of three vendors.
 *
 * Everything LGTM asks a model to do has the same shape: here is a prompt, here
 * is a JSON Schema, return an object matching it. That is the entire interface,
 * deliberately — no streaming, no conversation.
 *
 * Two of the things LGTM does — the reading aids and answering `@lgtm` — need
 * the model to search the web first. That is `{ search: true }` on the call
 * below, and every vendor implements it with its own server-side tool. It is an
 * option on the same interface rather than a second one because the caller wants
 * the same thing either way: a prompt in, JSON out.
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

export interface ProviderOptions {
  /**
   * Let the model search the web before answering, using the vendor's own
   * server-side tool. Terms derived from the input reach a search provider and
   * links come back from third parties, so this is the caller's decision to
   * make rather than a default.
   */
  search?: boolean;
  /**
   * The SDK client, for tests. Left unset, each adapter imports its own vendor
   * SDK lazily, which is what keeps an unused vendor's package unloaded.
   */
  client?: unknown;
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
export function resolve(spec?: string | null, options: ProviderOptions = {}): Provider {
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
      return new AnthropicProvider(model, key, options);
    case 'openai':
      return new OpenAIProvider(model, key, options);
    default:
      return new GeminiProvider(model, key, options);
  }
}

/**
 * Told to return JSON without a schema to enforce it.
 *
 * Only Gemini needs this: it refuses a response schema and a search tool in the
 * same call, so the schema has to be described rather than declared. Every
 * caller already treats unparseable output as "no answer", so the worst case is
 * the same one a refusal produces.
 */
function describeSchema(prompt: string, schema: Record<string, unknown>): string {
  return [
    prompt,
    '',
    'Reply with JSON matching this schema, and nothing else. No prose, no code fence.',
    JSON.stringify(schema),
  ].join('\n');
}

// --- anthropic -------------------------------------------------------------

const MAX_CONTINUATIONS = 2;
/** Searching takes more round trips before the turn finishes. */
const MAX_SEARCH_CONTINUATIONS = 4;
const MAX_SEARCHES = 6;

interface AnthropicLike {
  messages: { create(params: unknown): Promise<Anthropic.Message> };
}

export class AnthropicProvider implements Provider {
  label: string;
  constructor(
    private model: string,
    private apiKey: string,
    private options: ProviderOptions = {},
  ) {
    this.label = `anthropic:${model}`;
  }

  async complete(prompt: string, schema: Record<string, unknown>): Promise<string> {
    // Typed structurally rather than as the SDK class, so a test can pass a
    // fake and the search paths below stay checkable offline.
    const client: AnthropicLike =
      (this.options.client as AnthropicLike | undefined) ??
      new (await import('@anthropic-ai/sdk')).default({ apiKey: this.apiKey });
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];

    // The 2026-02-09 variant filters results before they reach the context
    // window. It runs code execution internally, so declaring the code
    // execution tool alongside it would give the model two execution
    // environments and confuse it.
    const tools = this.options.search
      ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES }]
      : undefined;
    const limit = this.options.search ? MAX_SEARCH_CONTINUATIONS : MAX_CONTINUATIONS;

    for (let attempt = 0; attempt <= limit; attempt++) {
      let response: Anthropic.Message;
      try {
        response = (await client.messages.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          output_config: { effort: 'high', format: { type: 'json_schema', schema } },
          ...(tools ? { tools } : {}),
          messages,
        })) as Anthropic.Message;
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

interface OpenAILike {
  responses: { create(params: unknown): Promise<OpenAIResponse> };
}

interface OpenAIResponse {
  output?: unknown[];
  output_text?: string;
  status?: string;
  incomplete_details?: { reason?: string };
}

export class OpenAIProvider implements Provider {
  label: string;
  constructor(
    private model: string,
    private apiKey: string,
    private options: ProviderOptions = {},
  ) {
    this.label = `openai:${model}`;
  }

  async complete(prompt: string, schema: Record<string, unknown>): Promise<string> {
    let client = this.options.client as OpenAILike | undefined;
    if (!client) {
      let OpenAI;
      try {
        ({ default: OpenAI } = await import('openai'));
      } catch {
        throw new ProviderError(
          "openai is not installed — add it to the action's dependencies.",
        );
      }
      client = new OpenAI({ apiKey: this.apiKey }) as unknown as OpenAILike;
    }

    let response: OpenAIResponse;
    try {
      response = await client.responses.create({
        model: this.model,
        input: prompt,
        max_output_tokens: MAX_TOKENS,
        reasoning: { effort: 'high' },
        ...(this.options.search ? { tools: [{ type: 'web_search' }] } : {}),
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

interface GeminiLike {
  models: { generateContent(params: unknown): Promise<GeminiResponse> };
}

interface GeminiResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: unknown }[];
  text?: string;
}

export class GeminiProvider implements Provider {
  label: string;
  constructor(
    private model: string,
    private apiKey: string,
    private options: ProviderOptions = {},
  ) {
    this.label = `gemini:${model}`;
  }

  async complete(prompt: string, schema: Record<string, unknown>): Promise<string> {
    let client = this.options.client as GeminiLike | undefined;
    if (!client) {
      let GoogleGenAI;
      try {
        ({ GoogleGenAI } = await import('@google/genai'));
      } catch {
        throw new ProviderError(
          "@google/genai is not installed — add it to the action's dependencies.",
        );
      }
      client = new GoogleGenAI({ apiKey: this.apiKey }) as unknown as GeminiLike;
    }

    // Search grounding and a response schema are mutually exclusive here, so a
    // searching call describes the schema in the prompt instead of declaring
    // it. Sending both is a 400, not a silently ignored field.
    const searching = this.options.search === true;

    let response: GeminiResponse;
    try {
      response = await client.models.generateContent({
        model: this.model,
        contents: searching ? describeSchema(prompt, schema) : prompt,
        config: {
          maxOutputTokens: MAX_TOKENS,
          ...(searching
            ? { tools: [{ googleSearch: {} }] }
            : {
                responseMimeType: 'application/json',
                responseJsonSchema: plain(schema),
              }),
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
    // Only the searching path can fence its output: the other one is decoded
    // against a schema, so there is nothing to unwrap.
    return searching ? unfence(text) : text;
  }
}

/**
 * Strip a ```json fence, if the model added one.
 *
 * Asked for JSON in a prompt rather than through a schema, a model will
 * sometimes wrap it. Text that is not fenced comes back untouched.
 */
export function unfence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return match ? match[1] : text;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
