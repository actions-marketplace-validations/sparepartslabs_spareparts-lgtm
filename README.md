# LGTM

A GitHub App that asks the reviewer two or three questions about the PR they just approved, generated from the diff, and reports the result as a check run.

Not a code reviewer. It has no opinion on whether the change is good — only on whether anyone read it. Friendly by design: it hands you the docs first, gives unlimited attempts, keeps no score, and can never mark a review as failed.

## Shape

- Webhook handler → worker. **No database**: quiz state lives in the comment and the check run, configuration in `.github/lgtm.yml`.
- The answer key is never published. The comment carries a keyed hash per correct option, authenticated so an edited quiz is reissued rather than graded.
- The shared Spare Parts API (`api.sparepartslabs.com`, `client_id` `lgtm`) is for the dashboard only. The quiz loop does not depend on it.

Spec: [`specs/001-lgtm-backend/spec.md`](specs/001-lgtm-backend/spec.md).

## Configuration

`.github/lgtm.yml`, read from the base branch so a PR cannot exempt itself. See [the annotated example](.github/lgtm.yml) — all fields optional.

| Field | Default | |
| --- | --- | --- |
| `questions` | `2` | 1–5. Raising it deepens the quiz rather than reshuffling it. |
| `difficulty` | `medium` | `easy` / `medium` / `hard`. Changes how close the distractors sit to the answer, never which answer is correct. |
| `surfaceReading` | `true` | List the docs and links the reviewer needs, above the questions. |
| `webConcepts` | `true` | Also link web explainers for concepts the diff assumes. Uses web search. |
| `answerQuestions` | `true` | Let people with write access ask questions by mentioning `@lgtm`. |
| `enforce` | `false` | Whether an unanswered quiz holds the merge. |
| `exemptPaths` | `[]` | Globs never quizzed about, on top of the built-in generated-file set. |
| `exemptReviewers` | `[]` | Logins never quizzed. Bots always are. |

A malformed field falls back to its default and is reported in the check output. A typo can neither silently disable enforcement nor block every merge.

## Blocking merge

Two things must both be true:

1. `enforce: true` in `.github/lgtm.yml`.
2. **LGTM — review confirmed** marked as a required status check in the repo's branch protection or ruleset.

LGTM does not request the permissions that would let it do step 2 for you — a tool that can grant itself the power to block merges is a different and worse thing.

With both on, an unanswered quiz leaves the check incomplete, which holds the merge. Anyone who could already merge the PR releases it with `/lgtm waive`, recorded in the thread.

What never blocks: a check LGTM concluded `neutral`. Every LGTM-side problem — model failure, an unquizzable diff, a PR too large, an unreadable config — lands there, so LGTM being broken can't freeze a repo. A `failure` conclusion is never used at all.

## Running it locally against a real repo

```sh
npm install
cp .env.example .env      # fill in APP_ID, PRIVATE_KEY, WEBHOOK_SECRET
                          # LGTM_SEAL_KEY: openssl rand -base64 32
                          # ANTHROPIC_API_KEY: required to generate questions
npm run dev
```

Point the app's webhook URL at your machine (`npx smee-client --url <smee-url> --path /api/github/webhooks --port 3000`), install it on a scratch repo, and approve a PR.

Register the app from [`app.yml`](app.yml) — it declares the permission set: read on pull requests and contents, write on checks and issues.

## Other commands

```sh
npm test        # 92 tests, no network
npm run demo    # prints the comment at each state of the flow
npm run typecheck
```

## How questions are generated

`src/questions.ts` screens the file list first — too many files, all-generated, all-exempt — so the common skip costs nothing. Then `src/generator.ts` runs three stages on the diff:

1. **Propose** — one call reads the hunks and writes candidates about what the change *does*: what a new guard prevents, which edit touches existing rows, what an error path now returns. It's told explicitly not to ask statistics, naming, or formatting questions.
2. **Verify** — each candidate goes to an independent call that never saw the proposer's reasoning and is told to *refute* it. A candidate survives only if that call agrees the answer is right, the question is answerable from the diff alone, and someone who skipped the diff couldn't guess it.
3. **Ground** — the cited `file` + `@@` hunk is checked against the parsed diff in code (`src/diff.ts`), and the options are checked for structural tells (a correct answer much longer than its distractors).

Everything is conservative in one direction. A candidate that can't be confirmed is dropped, and a quiz with no survivors isn't posted — the check concludes neutral. Asking nothing is fine; asking something wrong fails a reviewer who did their job, which is the one failure this tool can't recover from.

## Asking `@lgtm` a question

Mention `@lgtm` at the start of a line in a PR comment. Background questions get answered, with web search where a source helps: *"what's a CRDT?"*, *"why `SELECT FOR UPDATE` here?"*, *"link me the idempotency docs"*.

Questions that ask LGTM to read the PR **for** you are declined — *"what does this do?"*, *"is this safe to merge?"*, *"any bugs?"* You get a pointer at which file answers it, never the answer. Ambiguous questions resolve toward declining, because answering one of those costs you the understanding you're about to put your name on.

**Write access only** — `OWNER`, `MEMBER`, or `COLLABORATOR`, the same standing the waiver requires. It's read straight off the webhook payload, so there's no extra API call and no dependence on being added to the reviewer list first: a maintainer who wanders into a PR to help can ask immediately.

Everyone else is ignored silently. A bot that publicly tells someone they may not ask is the policing tone this tool exists to avoid, and it would fire on every drive-by; the reason goes to the log instead, where a maintainer sees it. Set `answerQuestions: false` to turn the feature off entirely.

## Status

Spec plus a working prototype. Two things are known-incomplete:

- **No queue.** Generation runs outside the acknowledged webhook (`deferred()` in `src/app.ts`) so GitHub's 10s budget is met, but there's no durability — a restart mid-generation loses the work with no retry. Spec FR-002 wants a real worker.
- **The checkbox question is unsettled.** See below.

The prototype exists to settle one question against a live installation: **can a reviewer actually tick a checkbox in a comment the app authored?** Toggling a task list in a comment appears to require permission to edit that comment, which collaborators have and outside contributors may not. If that holds, the checkbox flow silently excludes outside contributors and the letter-reply path becomes the primary input rather than the fallback. `src/app.ts` logs `author_association` on every edit so the answer is visible in the logs.
