/**
 * Answering a reviewer who mentions @lgtm on a pull request.
 *
 * The obvious version of this feature is the wrong one. A bot on a PR that
 * answers any question will be asked "what does this PR do?", and answering
 * that is precisely the thing LGTM exists to prevent — a summary is what lets
 * someone approve without reading (spec, Out of Scope). Build it naively and
 * the tool undermines itself on day one, politely and at scale.
 *
 * So the answer path is split by what the question is *for*:
 *
 *   Background — "what's a CRDT?", "why would you use a partial index here?",
 *     "link me the Stripe idempotency docs" — answered, with web search.
 *     This is the reading list on demand, and it makes reading the diff easier.
 *
 *   Reading-for-you — "what does this change?", "summarise the migration",
 *     "is this safe to approve?" — declined, warmly, with a pointer at the
 *     part of the diff that answers it. The reviewer is one step from the
 *     answer; handing it over is what costs them the understanding.
 *
 * The model makes that call, because the boundary is fuzzy in exactly the way
 * a keyword list can't capture: "what does `retryable` mean here?" is
 * background, "what does this PR do to retries?" is not.
 */

import Anthropic from '@anthropic-ai/sdk';

import { MODEL } from './concepts.ts';

export interface AskInput {
  /** The reviewer's question, mention stripped. */
  question: string;
  /** Unified diff, for grounding — not for summarising back. */
  diff: string;
  /** Who asked, so the reply can address them. */
  asker: string;
}

export type Answer =
  | { kind: 'answered'; text: string }
  | { kind: 'declined'; text: string }
  | { kind: 'unavailable'; reason: string };

const MAX_CONTINUATIONS = 4;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    /**
     * `background` answers; `reading_for_you` declines. Named for what the
     * question is asking the bot to do, not for the topic it names — the same
     * subject can fall either side.
     */
    kind: { type: 'string' as const, enum: ['background', 'reading_for_you'] },
    /**
     * The answer, or — when declining — the pointer at where in the diff the
     * reviewer can find it themselves. Markdown.
     */
    body: { type: 'string' as const },
  },
  required: ['kind', 'body'],
  additionalProperties: false,
};

function prompt(input: AskInput): string {
  return [
    'A code reviewer asked you a question on a pull request they are reviewing.',
    'You are LGTM, a bot whose purpose is to make sure reviewers actually read',
    'the changes they approve. That purpose constrains what you may answer.',
    '',
    'Classify the question first:',
    '',
    '- "background" — it asks about a concept, a technology, an API, a',
    '  convention, or prior art. Answering makes the diff easier to read.',
    '  Examples: "what is a bloom filter?", "why use SELECT FOR UPDATE?",',
    '  "link me the docs for this library\'s retry behaviour", "what does the',
    '  `Idempotency-Key` header do?". Search the web when the answer benefits',
    '  from a source, and link what you used.',
    '',
    '- "reading_for_you" — it asks you to read, summarise, evaluate, or judge',
    '  this pull request. Examples: "what does this PR do?", "summarise the',
    '  changes", "is this safe to merge?", "did they handle the null case?",',
    '  "any bugs here?", "explain this function to me". Do NOT answer these.',
    '  Instead, say briefly and warmly that reading it is the reviewer\'s call',
    '  to make, and point at WHERE in the diff the answer is — name the file',
    '  and what to look at. Never state the answer itself.',
    '',
    'The distinction is what the question asks YOU to do, not its subject.',
    '"What does `retryable` mean in general?" is background. "What does',
    '`retryable` do in this PR?" is reading_for_you.',
    '',
    'When it is genuinely ambiguous, treat it as reading_for_you. Declining',
    'costs the reviewer thirty seconds; answering costs them the understanding',
    'they are about to put their name on.',
    '',
    'Be brief either way. Two short paragraphs at most. Do not add a preamble,',
    'do not restate the question, and do not sign off.',
    '',
    `Reviewer: @${input.asker}`,
    `Question: ${input.question}`,
    '',
    'The diff, for context only:',
    input.diff,
  ].join('\n');
}

/** Never throws; a failure is a reply we don't post. */
export async function ask(
  client: Anthropic,
  input: AskInput,
): Promise<Answer> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: prompt(input) },
  ];

  try {
    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        output_config: {
          format: { type: 'json_schema', schema: SCHEMA },
        },
        messages,
      });

      if (response.stop_reason === 'refusal') {
        return {
          kind: 'unavailable',
          reason: `declined (${response.stop_details?.category ?? 'unspecified'})`,
        };
      }
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      if (response.stop_reason === 'max_tokens') {
        return { kind: 'unavailable', reason: 'answer was truncated' };
      }

      return parse(response);
    }
    return { kind: 'unavailable', reason: 'search did not finish in time' };
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

function parse(response: Anthropic.Message): Answer {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  if (!text.trim()) return { kind: 'unavailable', reason: 'empty response' };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'unavailable', reason: 'answer was not valid JSON' };
  }

  const o = raw as { kind?: unknown; body?: unknown };
  if (typeof o.body !== 'string' || !o.body.trim()) {
    return { kind: 'unavailable', reason: 'answer had no body' };
  }

  // Anything that isn't explicitly classified as background is treated as
  // reading-for-you. The failure that matters here is answering a question we
  // should have declined, so an unrecognised value falls the safe way.
  if (o.kind !== 'background') {
    return { kind: 'declined', text: o.body.trim() };
  }
  return { kind: 'answered', text: o.body.trim() };
}

/**
 * The mention, and the question after it.
 *
 * Requires the mention to be the start of a line so a passing reference in
 * prose ("ask @lgtm about it") doesn't summon a reply. Returns null when there
 * is a mention but no question — the bot says nothing rather than guessing.
 */
export function parseMention(body: string, botLogin: string): string | null {
  const handle = botLogin.replace(/\[bot\]$/, '');
  // The terminator is a lookahead, not `\b`: after an optional `[bot]` the
  // preceding char is `]`, so `\b` fails there and the engine backtracks into
  // *not* consuming `[bot]` — which then leaves "[bot]" at the head of the
  // question text. The lookahead has no such alternative to fall back to.
  const re = new RegExp(
    `^\\s*@${escape(handle)}(?:\\[bot\\])?(?=[\\s:,.!?]|$)([\\s\\S]*)`,
    'im',
  );
  const m = re.exec(body);
  if (!m) return null;
  const question = m[1].trim();
  return question.length > 0 ? question : null;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function renderAnswer(asker: string, answer: Answer): string | null {
  if (answer.kind === 'unavailable') return null;
  if (answer.kind === 'answered') return `@${asker} ${answer.text}`;
  return (
    `@${asker} ${answer.text}\n\n` +
    `<sub>I don't summarise the PR — reading it is the part that makes your ` +
    `approval mean something. Happy to explain any background you need.</sub>`
  );
}
