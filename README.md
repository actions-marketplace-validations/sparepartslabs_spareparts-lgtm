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
npm run dev
```

Point the app's webhook URL at your machine (`npx smee-client --url <smee-url> --path /api/github/webhooks --port 3000`), install it on a scratch repo, and approve a PR.

Register the app from [`app.yml`](app.yml) — it declares the permission set: read on pull requests and contents, write on checks and issues.

## Other commands

```sh
npm test        # 37 tests, no network
npm run demo    # prints the comment at each state of the flow
npm run typecheck
```

## Status

Spec plus a working prototype of the answer loop. The questions are a **placeholder** generator built from file statistics (`src/questions.ts`) — deterministic and grounded, but not the real thing. The model-backed generator is the next piece.

The prototype exists to settle one question against a live installation: **can a reviewer actually tick a checkbox in a comment the app authored?** Toggling a task list in a comment appears to require permission to edit that comment, which collaborators have and outside contributors may not. If that holds, the checkbox flow silently excludes outside contributors and the letter-reply path becomes the primary input rather than the fallback. `src/app.ts` logs `author_association` on every edit so the answer is visible in the logs.
