/**
 * The checkbox answer flow, as pure functions.
 *
 * A quiz is a comment. Rendering produces markdown with one task-list checkbox
 * per option; answering is the reviewer ticking boxes, which GitHub delivers as
 * `issue_comment.edited` carrying the whole new body. Grading reads that body
 * back, so the comment is both the question and the answer sheet — which is
 * what lets the app keep no database (spec FR-006).
 *
 * The cost of that is the answer key sitting in a world-readable comment, so it
 * isn't there: the sealed block carries a keyed hash per correct option and an
 * authenticator over itself (FR-008, FR-009). See `seal` / `openSeal`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface Question {
  /** Stable within a quiz; used as the hash domain so two questions with the
   *  same options don't produce the same digest. */
  id: string;
  prompt: string;
  /** Rendered in order. Index is the answer identity — never the text, which
   *  a reviewer's edit could mangle. */
  options: string[];
  /** Grounding, shown to the reviewer so a question is always traceable to the
   *  diff it came from (FR-012). */
  file: string;
  hunk: string;
}

/** What the model produces. Never leaves the worker's memory. */
export interface GeneratedQuiz {
  questions: Question[];
  /** Index into `options` for each question, parallel to `questions`. */
  correct: number[];
}

/** The part of the sealed block that identifies the quiz. */
export interface QuizClaims {
  pr: number;
  /** Confirmation binds to this (FR-027). */
  head: string;
  /** The one login whose ticks count (FR-017). */
  reviewer: string;
  questionIds: string[];
  /** Keyed hash of the correct option, one per question. Not the option. */
  answerHashes: string[];
}

export type ParseResult =
  | { kind: 'ok'; claims: QuizClaims; selections: (number | null)[] }
  | { kind: 'tampered' }
  | { kind: 'not-a-quiz' };

export type Grade =
  | { kind: 'incomplete'; answered: number; total: number }
  | { kind: 'confirmed' }
  | { kind: 'revisit'; wrong: number[] };

const MARKER = 'lgtm:v1';
const SEAL_OPEN = `<!-- ${MARKER} `;
const SEAL_CLOSE = ' -->';

// --- sealing ---------------------------------------------------------------

function hmac(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

/**
 * The digest a correct tick must produce. Domained on the quiz's head commit
 * and the question id so the same (option, index) pair in another quiz — or the
 * same quiz on another commit — hashes differently, which stops an answer from
 * being replayed anywhere but where it was earned.
 */
export function answerHash(
  key: string,
  head: string,
  questionId: string,
  optionIndex: number,
): string {
  return hmac(key, `${head}\0${questionId}\0${optionIndex}`);
}

export function seal(key: string, claims: QuizClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${SEAL_OPEN}${payload}.${hmac(key, payload)}${SEAL_CLOSE}`;
}

/**
 * Returns null for both "no seal here" and "seal doesn't verify" — the caller
 * distinguishes them by whether the marker was present at all, because the two
 * lead to different places: ignore the comment, versus reissue the quiz.
 */
export function openSeal(key: string, body: string): QuizClaims | null {
  const start = body.indexOf(SEAL_OPEN);
  if (start === -1) return null;
  const end = body.indexOf(SEAL_CLOSE, start);
  if (end === -1) return null;

  const token = body.slice(start + SEAL_OPEN.length, end).trim();
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;

  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(hmac(key, payload));
  // Lengths differ on a mangled signature, and timingSafeEqual throws on that
  // rather than returning false.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as QuizClaims;
  } catch {
    return null;
  }
}

export function looksLikeQuiz(body: string): boolean {
  return body.includes(SEAL_OPEN);
}

// --- rendering -------------------------------------------------------------

const LETTERS = 'ABCDEFGH';

/**
 * `- [ ] **A.** text` — a task list, so GitHub renders real checkboxes. The
 * letter is what a reviewer types if they'd rather reply than tick, so both
 * input paths read the same comment.
 */
function renderOption(letter: string, text: string, checked: boolean): string {
  return `- [${checked ? 'x' : ' '}] **${letter}.** ${text}`;
}

export interface RenderOptions {
  /** Ticks to pre-fill, e.g. re-rendering after a wrong attempt. */
  selections?: (number | null)[];
  /** Shown above the questions. Absent on the first post. */
  note?: string;
  /**
   * Pre-rendered reading list, above the questions. Deliberately before them:
   * handing someone what they need to answer is the point, not a hint they get
   * after failing.
   */
  reading?: string | null;
}

export function renderQuiz(
  key: string,
  quiz: GeneratedQuiz,
  meta: { pr: number; head: string; reviewer: string },
  opts: RenderOptions = {},
): string {
  const claims: QuizClaims = {
    pr: meta.pr,
    head: meta.head,
    reviewer: meta.reviewer,
    questionIds: quiz.questions.map((q) => q.id),
    answerHashes: quiz.questions.map((q, i) =>
      answerHash(key, meta.head, q.id, quiz.correct[i]),
    ),
  };

  const lines: string[] = [
    `### Thanks for reviewing, @${meta.reviewer} 👋`,
    '',
    quiz.questions.length === 1
      ? 'One quick question about what you just approved — tick your answer.'
      : `${quiz.questions.length} quick questions about what you just approved — tick your answers.`,
    '',
  ];

  if (opts.note) lines.push(opts.note, '');
  if (opts.reading) lines.push(opts.reading, '');

  quiz.questions.forEach((q, i) => {
    const chosen = opts.selections?.[i] ?? null;
    lines.push(`**${i + 1}. ${q.prompt}**`);
    lines.push(`<sub>${q.file} · ${q.hunk}</sub>`);
    lines.push('');
    q.options.forEach((text, j) => {
      lines.push(renderOption(LETTERS[j], text, j === chosen));
    });
    lines.push('');
  });

  lines.push(
    '<sub>Take another look if you need to — there is no limit on tries, and ' +
      'nothing here is recorded against you. If a question looks wrong, tick ' +
      '**Something is off** below and you are done.</sub>',
  );
  lines.push('');
  lines.push('- [ ] 🚩 Something is off about these questions');
  lines.push('');
  lines.push(seal(key, claims));

  return lines.join('\n');
}

export function renderConfirmed(reviewer: string): string {
  return `✅ @${reviewer} confirmed what's in this PR. Thanks!`;
}

export function renderWaived(reviewer: string, waivedBy: string): string {
  return `☑️ Review confirmation for @${reviewer} was waived by @${waivedBy}.`;
}

export function renderFlagged(reviewer: string): string {
  return (
    `✅ Marked confirmed for @${reviewer} — you flagged the questions as off, ` +
    `so that one is on us. We've filed it.`
  );
}

/** What goes above the questions on a re-render after a wrong attempt. */
export function revisitNote(quiz: GeneratedQuiz, wrong: number[]): string {
  const where = wrong.map((i) => `\`${quiz.questions[i].file}\``);
  const list =
    where.length === 1
      ? where[0]
      : `${where.slice(0, -1).join(', ')} and ${where[where.length - 1]}`;
  return (
    `Not quite on ${wrong.length === 1 ? 'one of these' : 'a couple of these'} — ` +
    `worth another look at ${list}. Retick whenever you're ready.`
  );
}

// --- parsing ---------------------------------------------------------------

const OPTION_RE = /^\s*-\s*\[([ xX])\]\s*\*\*([A-H])\.\*\*/;
const FLAG_RE = /^\s*-\s*\[([ xX])\]\s*🚩/u;

/**
 * Reads ticks back out of an edited body.
 *
 * Position, not text: the Nth option block after the Nth prompt. A reviewer who
 * ticks two boxes in one question gets `null` for it rather than the first or
 * last tick — guessing which they meant is how you grade someone as wrong for
 * something they didn't say.
 */
export function parseAnswers(key: string, body: string): ParseResult {
  if (!looksLikeQuiz(body)) return { kind: 'not-a-quiz' };
  const claims = openSeal(key, body);
  if (!claims) return { kind: 'tampered' };

  const selections: (number | null)[] = [];
  let ticked: number[] = [];
  let open = false;

  // A question's ticks are decided only once its block has ended, because a
  // second tick anywhere in the block invalidates the first.
  const flush = () => {
    if (!open) return;
    selections.push(ticked.length === 1 ? ticked[0] : null);
    ticked = [];
    open = false;
  };

  for (const line of body.split('\n')) {
    if (FLAG_RE.test(line)) continue; // handled by `parseFlag`
    const m = OPTION_RE.exec(line);
    if (!m) continue;

    const index = LETTERS.indexOf(m[2]);
    // Option A opens a block, so it closes the one before it.
    if (index === 0) flush();
    open = true;
    if (m[1] !== ' ') ticked.push(index);
  }
  flush();

  // A body whose option blocks don't line up with the sealed questions has been
  // restructured, not just ticked. Treat it the way we treat a broken seal.
  if (selections.length !== claims.questionIds.length) return { kind: 'tampered' };

  return { kind: 'ok', claims, selections };
}

export function parseFlag(body: string): boolean {
  for (const line of body.split('\n')) {
    const m = FLAG_RE.exec(line);
    if (m && m[1] !== ' ') return true;
  }
  return false;
}

// --- grading ---------------------------------------------------------------

/**
 * Grades ticks against the sealed hashes. Needs no access to the original
 * questions — which is the point: the worker that grades never refetches the
 * diff or re-runs the model.
 */
export function grade(
  key: string,
  claims: QuizClaims,
  selections: (number | null)[],
): Grade {
  const answered = selections.filter((s) => s !== null).length;
  if (answered < selections.length) {
    return { kind: 'incomplete', answered, total: selections.length };
  }

  const wrong: number[] = [];
  selections.forEach((choice, i) => {
    const got = answerHash(key, claims.head, claims.questionIds[i], choice!);
    if (got !== claims.answerHashes[i]) wrong.push(i);
  });

  return wrong.length === 0 ? { kind: 'confirmed' } : { kind: 'revisit', wrong };
}

// --- event routing ---------------------------------------------------------

export type Action =
  | { kind: 'ignore'; why: string }
  | { kind: 'reissue' }
  | { kind: 'wait' }
  | { kind: 'confirm' }
  | { kind: 'flagged' }
  | { kind: 'revisit'; wrong: number[] };

/**
 * What an `issue_comment.edited` on our own comment should cause.
 *
 * The two guards that matter: our own edits come back as events and must not
 * loop, and a tick by anyone but the reviewer the quiz names is not an answer
 * (FR-017) — it's someone else's checkbox and the quiz stays open.
 */
export function onCommentEdited(
  key: string,
  ev: { body: string; sender: string; commentAuthorIsApp: boolean },
): Action {
  if (!looksLikeQuiz(ev.body)) return { kind: 'ignore', why: 'not-a-quiz' };
  if (!ev.commentAuthorIsApp) return { kind: 'ignore', why: 'not-our-comment' };
  if (ev.sender === 'lgtm[bot]') return { kind: 'ignore', why: 'our-own-edit' };

  const parsed = parseAnswers(key, ev.body);
  if (parsed.kind === 'not-a-quiz') return { kind: 'ignore', why: 'not-a-quiz' };
  if (parsed.kind === 'tampered') return { kind: 'reissue' };

  if (ev.sender !== parsed.claims.reviewer) {
    return { kind: 'ignore', why: 'not-the-reviewer' };
  }
  if (parseFlag(ev.body)) return { kind: 'flagged' };

  const g = grade(key, parsed.claims, parsed.selections);
  if (g.kind === 'incomplete') return { kind: 'wait' };
  if (g.kind === 'confirmed') return { kind: 'confirm' };
  return { kind: 'revisit', wrong: g.wrong };
}
