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

import type { Provider } from './providers.ts';

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
  /** Unified diff. Sent to the model vendor; see the privacy note below. */
  diff: string;
  /** Repo languages/frameworks, so the model doesn't explain the obvious. */
  context: string;
  /** Hard ceiling on concepts. Three is already a lot to hand someone. */
  max: number;
}

export const MAX_CONCEPTS = 3;

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
 * Ask the model what a reviewer would need to look up, with web search.
 *
 * The caller supplies a provider built with `{ search: true }`, so which vendor
 * searches is the repository's choice. Every vendor does it with its own
 * server-side tool.
 *
 * EGRESS: this sends the diff to whichever vendor is configured — but so does
 * the quiz generator, which reads hunks with a model. "The diff reaches a model
 * vendor" is true of LGTM generally and is not what this toggle controls.
 *
 * What it does control is the hop past that vendor: the model issues web
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
  client: Provider,
  input: ExplainInput,
): Promise<ExplainResult> {
  let text: string;
  try {
    text = await client.complete(prompt(input), SCHEMA);
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: err instanceof Error ? err.message : 'unknown error',
    };
  }

  return parse(text, input.max);
}

function parse(text: string, max: number): ExplainResult {
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
