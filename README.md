# LGTM

A GitHub Action that asks the reviewer two or three questions about the PR they just approved, generated from the diff, and reports the result as a check run.

## Agent command

The release archive provides one canonical LGTM command for Claude, Codex,
Cursor, GitHub Copilot, Gemini, and OpenCode—the same agent matrix supported by
`sp ec install`. Install it through the Spare Parts CLI:

```sh
sp plugin install lgtm --agent claude --dir .
sp plugin install lgtm --agent cursor --agent gemini --dir .
sp plugin install lgtm --all --dir .
```

The installed command checks for `sp` and delegates to `sp lgtm`; it does not
reproduce the CLI workflow. On first interactive use, when no preference is
already visible, it asks whether the active agent should remember to run LGTM
before an agent-initiated `git push` or pull-request creation. With consent it
uses only that host's supported, user-visible memory or instruction mechanism,
and never claims persistence until the host confirms it.

This reminder applies only to publishing performed by the agent. It cannot
intercept commands the user runs independently and does not install a Git hook.
The existing `sp lgtm install` hook remains a separate, explicit CLI feature.

The canonical source is `plugins/lgtm/commands/lgtm.md`. Agent-specific files
are wrappers around that source, and validation prevents them from drifting.
Codex also has an optional marketplace adapter, `lgtm@sparepartslabs`; that
adapter adds only Codex-specific `/memories` guidance.

Not a code reviewer. It has no opinion on whether the change is good — only on whether anyone read it. Friendly by design: it hands you the docs first, gives unlimited attempts, keeps no score, and can never mark a review as failed.

## Shape

- A **GitHub Action** — two workflow files, two secrets, no server. Each repo supplies its own model key, so adoption costs the adopter.
- **No database**: quiz state lives in the comment and the check run, configuration in `.github/lgtm.yml`.
- The answer key is never published. The comment carries a keyed hash per correct option, authenticated so an edited quiz is reissued rather than graded.
- Approvals reach privileged code by relay, because `pull_request_review` gets no secrets on a fork PR. The relay artifact is treated as untrusted.

## Install

Two workflow files and two secrets. No checkout, no server, no database: the diff and the config are read through the API.

`.github/workflows/lgtm-collect.yml` — the powerless half. On a fork PR, `pull_request_review` gets no secrets and a read-only token, so all this can do is hand the event on.

```yaml
name: LGTM (collect)
on:
  pull_request_review:
    types: [submitted]
permissions: {}
jobs:
  collect:
    if: github.event.review.state == 'approved'
    runs-on: ubuntu-latest
    steps:
      - env:
          EVENT: ${{ toJSON(github.event) }}
        run: |
          mkdir -p relay
          jq -n --arg name pull_request_review --argjson payload "$EVENT" \
            '{event_name: $name, payload: $payload}' > relay/event.json
      - uses: actions/upload-artifact@v4
        with:
          name: lgtm-event
          path: relay/event.json
          retention-days: 1
```

`.github/workflows/lgtm.yml` — the privileged half.

```yaml
name: LGTM
on:
  workflow_run:
    workflows: [LGTM (collect)]
    types: [completed]
  issue_comment:
    types: [created, edited]

permissions:
  contents: read
  checks: write
  issues: write
  pull-requests: write
  actions: read

jobs:
  lgtm:
    if: >
      github.event_name == 'workflow_run' ||
      (github.event.issue.pull_request != null &&
       (contains(github.event.comment.body, 'lgtm:v1') ||
        contains(github.event.comment.body, '/lgtm waive') ||
        contains(github.event.comment.body, '@lgtm')))
    runs-on: ubuntu-latest
    steps:
      - name: Fetch the relayed event
        if: github.event_name == 'workflow_run'
        uses: actions/download-artifact@v4
        with:
          name: lgtm-event
          path: relay
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - uses: sparepartslabs/spareparts-lgtm@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          seal-key: ${{ secrets.LGTM_SEAL_KEY }}
          relayed-event: ${{ github.event_name == 'workflow_run' && 'relay/event.json' || '' }}
```

Then two secrets:

| Secret | |
| --- | --- |
| A model key | One of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`, passed as the matching input. `provider:` picks between them and defaults to Anthropic. All three write questions, verify them, produce the reading aids and answer `@lgtm`. |
| `LGTM_SEAL_KEY` | `openssl rand -base64 32`, stored once and kept stable. No fallback: unset is a startup failure rather than a quiz nobody can grade. |

Every input is listed in [`action.yml`](action.yml).

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

## Development

```sh
npm ci
npm test        # 119 tests, no network
npm run typecheck
```

This repository runs the action on its own pull requests through `uses: ./`, so a change is exercised here before it is tagged for anyone else. Approve a PR and watch the run.

To drive the entry point by hand, set the same variables `action.yml` sets and point it at an event payload:

```sh
GITHUB_REPOSITORY=owner/repo \
GITHUB_EVENT_NAME=issue_comment \
GITHUB_EVENT_PATH=./event.json \
GITHUB_TOKEN=... LGTM_SEAL_KEY=... ANTHROPIC_API_KEY=... \
npm run action
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

One thing is unsettled: **can an outside contributor tick a checkbox in a comment the bot authored?** Toggling a task list appears to require permission to edit that comment, which collaborators have and outside contributors may not. If that holds, the checkbox flow silently excludes them and the letter-reply path is the primary input rather than the fallback. `src/handlers.ts` logs `author_association` on every edit, so a live installation answers it in the log.

Generation is durable enough as an Action: a workflow has no ten-second acknowledgement budget, so it runs inline and a failure is a failed run you can re-run, not work lost in a background task.
