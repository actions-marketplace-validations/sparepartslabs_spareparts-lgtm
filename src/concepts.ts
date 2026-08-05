/**
 * Concept explainers, sourced from the web.
 *
 * The second half of `surfaceReading`. `reading.ts` surfaces what the *repo*
 * already says — docs the PR changed, links in its description. This surfaces
 * what the repo cannot: an explainer for a technique, protocol, or library the
 * diff assumes you already know.
 *
 * The distinction that keeps this useful rather than noisy: a concept qualifies
 * only if the diff would be hard to *evaluate* without it. "What is a HMAC" on a
 * PR that adds request signing, yes. "What is TypeScript" on a TypeScript repo,
 * no. The model is told this explicitly, and a link that isn't a real explainer
 * of a named concept is dropped rather than shipped.
 *
 * See the egress note on `explainConcepts` — it is narrower than it first looks,
 * and gets narrower still once the real quiz generator lands.
 */

import Anthropic from '@anthropic-ai/sdk';

/** A model — and a network call — is in this path, so everything fails soft. */
export interface Concept {
  /** The thing the reviewer may not know, named as the diff names it. */
  term: string;
  /** One sentence on why this PR needs it. Not a definition — a reason to read. */
  why: string;
  title: string;
  url: string;
}

export interface ExplainInput {
  /** Unified diff. Sent to the Anthropic API; see the privacy note below. */
  diff: string;
  /** Repo languages/frameworks, so the model doesn't explain the obvious. */
  context: string;
  /** Hard ceiling on concepts. Three is already a lot to hand someone. */
  max: number;
}

export const MODEL = 'claude-opus-5';
export const MAX_CONCEPTS = 3;

/** Bounds the server-tool loop: each `pause_turn` costs one. */
const MAX_CONTINUATIONS = 4;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    concepts: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          term: { type: 'string' as const },
          why: { type: 'string' as const },
          title: { type: 'string' as const },
          url: { type: 'string' as const },
        },
        required: ['term', 'why', 'title', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['concepts'],
  additionalProperties: false,
};

function prompt(input: ExplainInput): string {
  return [
    'You are helping a code reviewer understand a pull request they are about',
    'to approve. Find at most ' + input.max + ' concepts in this diff that a',
    'competent engineer on this team might not already know, and search the web',
    'for one high-quality explainer of each.',
    '',
    'A concept qualifies only if the diff is hard to EVALUATE without it — a',
    'protocol, algorithm, security property, or library-specific behaviour the',
    'change depends on. It does not qualify if it is general knowledge for this',
    'stack, or if the diff is self-explanatory. Returning zero concepts is a',
    'good answer for most PRs; do not pad the list.',
    '',
    'Rules:',
    '- Every concept MUST appear in the diff. Do not infer concepts from the',
    '  filenames or the general subject area.',
    '- Prefer primary sources: official docs, specifications, the library\'s own',
    '  documentation. Avoid content farms and SEO listicles.',
    '- Only return a URL you actually found via search and confirmed is about',
    '  that concept. Never construct a URL you did not see in results.',
    '- Do NOT summarise the pull request, describe what it does, or evaluate it.',
    '  The reviewer must read the diff themselves; a summary defeats the point.',
    '',
    'Repo context: ' + input.context,
    '',
    'Diff:',
    input.diff,
  ].join('\n');
}

export type ExplainResult =
  | { kind: 'ok'; concepts: Concept[] }
  | { kind: 'unavailable'; reason: string };

/**
 * Ask Claude what a reviewer would need to look up, with web search.
 *
 * EGRESS: this sends the diff to the Anthropic API — but so will the real quiz
 * generator (spec FR-011..FR-013), which reads hunks with a model. Once that
 * replaces the placeholder in `questions.ts`, "the diff reaches Anthropic" is
 * true of LGTM generally and is not what this toggle controls.
 *
 * What it does control is the hop past Anthropic: the model issues web
 * searches, so terms derived from the diff reach a search provider and the
 * links come back from third parties. A repo that is fine with a model reading
 * its diff may still not want it queried against the open web. That is the
 * distinction to put in the install copy — not a claim that turning this off
 * keeps everything inside GitHub.
 *
 * Never throws. A model failure, a refusal, or a malformed response all come
 * back as `unavailable`, and the caller omits the section (spec FR-025).
 */
export async function explainConcepts(
  client: Anthropic,
  input: ExplainInput,
): Promise<ExplainResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: prompt(input) },
  ];

  try {
    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        // The 2026-02-09 variant filters results before they reach the context
        // window. It runs code execution internally, so declaring the code
        // execution tool alongside it would give the model two execution
        // environments and confuse it.
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
        output_config: {
          format: { type: 'json_schema', schema: SCHEMA },
        },
        messages,
      });

      // Safety classifiers can decline; that is a 200 with no usable content.
      if (response.stop_reason === 'refusal') {
        return {
          kind: 'unavailable',
          reason: `declined (${response.stop_details?.category ?? 'unspecified'})`,
        };
      }

      // A long server-tool turn stops here rather than finishing. Append the
      // partial assistant turn and re-send; the server resumes on its own, so
      // no extra user message is added.
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      if (response.stop_reason === 'max_tokens') {
        return { kind: 'unavailable', reason: 'response was truncated' };
      }

      return parse(response, input.max);
    }

    return { kind: 'unavailable', reason: 'search did not finish in time' };
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

function parse(response: Anthropic.Message, max: number): ExplainResult {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  if (!text.trim()) return { kind: 'unavailable', reason: 'empty response' };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'unavailable', reason: 'response was not valid JSON' };
  }

  const concepts = (raw as { concepts?: unknown }).concepts;
  if (!Array.isArray(concepts)) {
    return { kind: 'unavailable', reason: 'response had no concepts array' };
  }

  return { kind: 'ok', concepts: concepts.filter(isConcept).slice(0, max) };
}

/**
 * Every field non-empty and the URL an absolute http(s) URL.
 *
 * The URL check is the load-bearing one: a hallucinated relative path or a
 * `javascript:` URL rendered into a PR comment is a link LGTM published, and
 * the reviewer has no way to know LGTM didn't verify it.
 */
function isConcept(value: unknown): value is Concept {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  const fields = ['term', 'why', 'title', 'url'];
  if (!fields.every((f) => typeof c[f] === 'string' && (c[f] as string).trim())) {
    return false;
  }
  try {
    const url = new URL(c.url as string);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function renderConcepts(concepts: Concept[]): string | null {
  if (concepts.length === 0) return null;
  const lines = ['**Might be worth a look**', ''];
  for (const c of concepts) {
    lines.push(`- **${c.term}** — [${c.title}](${c.url}) <sub>${c.why}</sub>`);
  }
  return lines.join('\n');
}
