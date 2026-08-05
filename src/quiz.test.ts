import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  grade,
  onCommentEdited,
  openSeal,
  parseAnswers,
  parseFlag,
  renderQuiz,
  revisitNote,
  seal,
  type GeneratedQuiz,
} from './quiz.ts';

const KEY = 'test-key-not-the-real-one';
const META = { pr: 42, head: 'abc123', reviewer: 'alice' };

const QUIZ: GeneratedQuiz = {
  questions: [
    {
      id: 'q1',
      prompt: 'What does the new guard in `parseAnswers` reject?',
      options: [
        'A body whose option blocks do not match the sealed questions',
        'A comment posted by a bot',
        'A PR with more than three files',
      ],
      file: 'src/quiz.ts',
      hunk: '@@ -180,6 +180,9 @@',
    },
    {
      id: 'q2',
      prompt: 'Where is the answer key stored?',
      options: [
        'In the app database',
        'As a keyed hash in the comment itself',
        'In the check run output',
      ],
      file: 'src/quiz.ts',
      hunk: '@@ -60,0 +72,8 @@',
    },
  ],
  correct: [0, 1],
};

/** Tick option `choice` in question `n` (0-based) of a rendered body. */
function tick(body: string, n: number, choice: number): string {
  const lines = body.split('\n');
  let block = -1;
  let index = 0;
  return lines
    .map((line) => {
      const m = /^(\s*-\s*\[)([ xX])(\]\s*\*\*([A-H])\.\*\*)/.exec(line);
      if (!m) return line;
      const i = 'ABCDEFGH'.indexOf(m[4]);
      if (i === 0) {
        block++;
        index = 0;
      }
      const here = index++;
      if (block !== n) return line;
      return `${m[1]}${here === choice ? 'x' : ' '}${m[3]}${line.slice(m[0].length)}`;
    })
    .join('\n');
}

function answerAll(body: string, choices: number[]): string {
  return choices.reduce((b, c, i) => tick(b, i, c), body);
}

test('a freshly rendered quiz has nothing ticked', () => {
  const body = renderQuiz(KEY, QUIZ, META);
  const parsed = parseAnswers(KEY, body);
  assert.equal(parsed.kind, 'ok');
  assert.deepEqual(parsed.kind === 'ok' && parsed.selections, [null, null]);
});

test('the seal round-trips and carries no plaintext answer', () => {
  const body = renderQuiz(KEY, QUIZ, META);
  const claims = openSeal(KEY, body);
  assert.ok(claims);
  assert.equal(claims.reviewer, 'alice');
  assert.deepEqual(claims.questionIds, ['q1', 'q2']);
  // The correct option's text must not be recoverable from the seal (FR-008,
  // SC-008). Its position must not be either.
  const marker = body.slice(body.indexOf('<!-- lgtm:v1'));
  assert.ok(!marker.includes('keyed hash in the comment'));
  assert.ok(!/"correct"/.test(marker));
});

test('correct ticks confirm', () => {
  const body = answerAll(renderQuiz(KEY, QUIZ, META), [0, 1]);
  const parsed = parseAnswers(KEY, body);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  assert.deepEqual(parsed.selections, [0, 1]);
  assert.deepEqual(grade(KEY, parsed.claims, parsed.selections), {
    kind: 'confirmed',
  });
});

test('a wrong tick names which question to revisit, not the person', () => {
  const body = answerAll(renderQuiz(KEY, QUIZ, META), [2, 1]);
  const parsed = parseAnswers(KEY, body);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  const g = grade(KEY, parsed.claims, parsed.selections);
  assert.deepEqual(g, { kind: 'revisit', wrong: [0] });
  const note = revisitNote(QUIZ, [0]);
  assert.match(note, /another look/);
  assert.doesNotMatch(note, /wrong|fail|incorrect/i);
});

test('a partly ticked quiz waits rather than grading', () => {
  const body = tick(renderQuiz(KEY, QUIZ, META), 0, 0);
  const parsed = parseAnswers(KEY, body);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  assert.deepEqual(grade(KEY, parsed.claims, parsed.selections), {
    kind: 'incomplete',
    answered: 1,
    total: 2,
  });
});

test('two ticks in one question is no answer, not the first one', () => {
  let body = renderQuiz(KEY, QUIZ, META);
  body = tick(body, 1, 1);
  // Tick a second box in question 1 by hand.
  body = body.replace('- [ ] **A.** A body whose', '- [x] **A.** A body whose');
  body = body.replace('- [ ] **B.** A comment', '- [x] **B.** A comment');
  const parsed = parseAnswers(KEY, body);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  assert.equal(parsed.selections[0], null);
});

test('an edited seal is detected', () => {
  const body = answerAll(renderQuiz(KEY, QUIZ, META), [0, 1]);
  const forged = body.replace(/<!-- lgtm:v1 .*? -->/, () =>
    seal(KEY, {
      pr: 42,
      head: 'abc123',
      reviewer: 'alice',
      questionIds: ['q1', 'q2'],
      // Attacker's guess at the hashes.
      answerHashes: ['nope', 'nope'],
    }).replace('lgtm:v1 ', 'lgtm:v1 '),
  );
  // A validly-sealed-but-wrong-hash block is still opened — it just grades as
  // wrong. What must be caught is a block sealed with a key we don't hold.
  const outsider = body.replace(
    /<!-- lgtm:v1 .*? -->/,
    seal('attacker-key', {
      pr: 42,
      head: 'abc123',
      reviewer: 'mallory',
      questionIds: ['q1', 'q2'],
      answerHashes: ['x', 'y'],
    }),
  );
  assert.equal(parseAnswers(KEY, outsider).kind, 'tampered');
  assert.notEqual(parseAnswers(KEY, forged).kind, 'not-a-quiz');
});

test('deleting a question block is tampering, not a partial answer', () => {
  const body = renderQuiz(KEY, QUIZ, META);
  const truncated = body.slice(0, body.indexOf('**2.')) +
    body.slice(body.indexOf('<!-- lgtm:v1'));
  assert.equal(parseAnswers(KEY, truncated).kind, 'tampered');
});

test('answers replayed onto a new head do not confirm', () => {
  const body = answerAll(renderQuiz(KEY, QUIZ, META), [0, 1]);
  const parsed = parseAnswers(KEY, body);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  const moved = { ...parsed.claims, head: 'def456' };
  assert.equal(grade(KEY, moved, parsed.selections).kind, 'revisit');
});

test('the flag box resolves in the reviewer favour', () => {
  const body = renderQuiz(KEY, QUIZ, META).replace(
    '- [ ] 🚩',
    '- [x] 🚩',
  );
  assert.equal(parseFlag(body), true);
  // The flag must not be read as an answer to the last question.
  const parsed = parseAnswers(KEY, body);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  assert.deepEqual(parsed.selections, [null, null]);
});

test('routing: our own edit does not loop', () => {
  const body = renderQuiz(KEY, QUIZ, META);
  assert.deepEqual(
    onCommentEdited(KEY, {
      body,
      sender: 'lgtm[bot]',
      commentAuthorIsApp: true,
    }),
    { kind: 'ignore', why: 'our-own-edit' },
  );
});

test('routing: someone else ticking leaves the quiz open', () => {
  const body = answerAll(renderQuiz(KEY, QUIZ, META), [0, 1]);
  assert.deepEqual(
    onCommentEdited(KEY, { body, sender: 'bob', commentAuthorIsApp: true }),
    { kind: 'ignore', why: 'not-the-reviewer' },
  );
});

test('routing: the reviewer answering correctly confirms', () => {
  const body = answerAll(renderQuiz(KEY, QUIZ, META), [0, 1]);
  assert.deepEqual(
    onCommentEdited(KEY, { body, sender: 'alice', commentAuthorIsApp: true }),
    { kind: 'confirm' },
  );
});

test('routing: a comment we did not post is ignored', () => {
  const body = answerAll(renderQuiz(KEY, QUIZ, META), [0, 1]);
  assert.deepEqual(
    onCommentEdited(KEY, { body, sender: 'alice', commentAuthorIsApp: false }),
    { kind: 'ignore', why: 'not-our-comment' },
  );
});

test('a re-rendered quiz keeps the ticks it had', () => {
  const body = renderQuiz(KEY, QUIZ, META, {
    selections: [2, 1],
    note: revisitNote(QUIZ, [0]),
  });
  const parsed = parseAnswers(KEY, body);
  assert.equal(parsed.kind, 'ok');
  assert.deepEqual(parsed.kind === 'ok' && parsed.selections, [2, 1]);
});
