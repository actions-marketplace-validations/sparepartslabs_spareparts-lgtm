/**
 * Prints the comment at each state of the checkbox flow, so the UX can be read
 * as a reviewer would see it. `npm run demo`.
 */

import { DEFAULTS } from './config.ts';
import { collect, renderReading } from './reading.ts';
import {
  onCommentEdited,
  renderConfirmed,
  renderQuiz,
  revisitNote,
  type GeneratedQuiz,
} from './quiz.ts';

const KEY = 'demo-key';
const META = { pr: 128, head: 'e4f9a21', reviewer: 'alice' };

const QUIZ: GeneratedQuiz = {
  questions: [
    {
      id: 'q1',
      prompt: 'This PR adds an early return to `chargeCard`. What does it guard against?',
      options: [
        'Charging a card when the order has already been refunded',
        'Charging a card that has expired',
        'Charging more than once for the same order',
      ],
      file: 'src/billing/charge.ts',
      hunk: '@@ -41,6 +41,11 @@',
    },
    {
      id: 'q2',
      prompt: 'Which file carries the change that can affect existing rows?',
      options: [
        'src/billing/charge.ts',
        'migrations/0042_backfill_refunds.sql',
        'src/billing/charge.test.ts',
      ],
      file: 'migrations/0042_backfill_refunds.sql',
      hunk: '@@ -0,0 +1,14 @@',
    },
  ],
  correct: [0, 1],
};

function show(title: string, body: string) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}\n`);
  console.log(body);
}

const reading = DEFAULTS.surfaceReading
  ? renderReading(
      collect({
        files: [
          { filename: 'docs/billing.md', status: 'modified' },
          { filename: 'src/billing/charge.ts', status: 'modified' },
        ],
        prBody:
          'Fixes double-charging on refunded orders. Background in ' +
          '[the billing spec](https://example.com/spec).',
        repo: { owner: 'sparepartslabs', repo: 'demo', ref: META.head },
      }),
    )
  : null;

const posted = renderQuiz(KEY, QUIZ, META, { reading });
show('1. Posted, right after the approval', posted);

// Alice ticks C and B — the first is wrong.
const attempt = posted
  .replace('- [ ] **C.** Charging more', '- [x] **C.** Charging more')
  .replace('- [ ] **B.** migrations', '- [x] **B.** migrations');
const first = onCommentEdited(KEY, {
  body: attempt,
  sender: 'alice',
  commentAuthorIsApp: true,
});
console.log(`\n→ routed as: ${JSON.stringify(first)}`);

if (first.kind === 'revisit') {
  show(
    '2. Edited in place after a wrong tick',
    renderQuiz(KEY, QUIZ, META, {
      selections: [2, 1],
      note: revisitNote(QUIZ, first.wrong),
    }),
  );
}

const retry = posted
  .replace('- [ ] **A.** Charging a card when', '- [x] **A.** Charging a card when')
  .replace('- [ ] **B.** migrations', '- [x] **B.** migrations');
const second = onCommentEdited(KEY, {
  body: retry,
  sender: 'alice',
  commentAuthorIsApp: true,
});
console.log(`\n→ routed as: ${JSON.stringify(second)}`);

if (second.kind === 'confirm') {
  show('3. Collapsed once confirmed', renderConfirmed(META.reviewer));
}
