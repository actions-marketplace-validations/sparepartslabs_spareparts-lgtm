# Testing LGTM live

Everything below runs against `sparepartslabs/spareparts-lgtm` — LGTM quizzing
its own pull requests. [PR #1](https://github.com/sparepartslabs/spareparts-lgtm/pull/1)
is already open and waiting to be approved.

`.env` already has a generated `LGTM_SEAL_KEY`. Two steps need you.

## 1. Add your Anthropic key

```sh
# in .env
ANTHROPIC_API_KEY=sk-ant-...
```

Without it the app still runs and still posts a check — it just concludes
`neutral` saying generation isn't configured. That's worth seeing once, since
it's the path an unconfigured install takes and it must never hold a merge.

## 2. Register the GitHub App

```sh
npm run setup
```

Open <http://localhost:3000>. Probot's wizard sends GitHub the permission set
from [`app.yml`](app.yml), and GitHub sends back credentials that Probot writes
into `.env` — so you never transcribe a private key.

In the browser:

1. **Register** → choose the **sparepartslabs** organisation.
2. **Install** → *Only select repositories* → **spareparts-lgtm**.

Then stop the process (Ctrl-C).

## 3. Run it

```sh
npm run dev
```

In a second terminal, tunnel GitHub's webhooks to your machine. The wizard puts
a `WEBHOOK_PROXY_URL` in `.env`; use that:

```sh
npx smee-client --url "$(grep WEBHOOK_PROXY_URL .env | cut -d= -f2)" \
  --path /api/github/webhooks --port 3000
```

## 4. Approve the PR

Open PR #1 → **Files changed** → **Review changes** → **Approve** → **Submit**.

Watch the `npm run dev` logs. Expect, in order:

| Log line | What it means |
| --- | --- |
| `posted quiz` | Generation and verification finished; the comment is up |
| *(a pause of 20–60s first)* | One proposal call plus one verification per candidate |
| `no web concepts` | Only if the concept search found nothing — not an error |

Then read the comment. **The thing you are actually testing is whether the
questions demonstrate understanding** — whether someone who read this diff
answers correctly and someone who skimmed the file list does not. Statistics
questions ("which file changed most") mean the generator regressed to what the
placeholder did, and the propose prompt forbids them explicitly.

The diff in PR #1 was chosen to have a real answer: it adds a per-asker
cooldown, and the interesting property is the **bucket key is per-asker, not
per-PR**. A good question turns on that. A bad one asks how many lines changed.

## 5. Answer it

Tick a box per question. This is the unsettled mechanic: **toggling a checkbox
in a comment the app authored may require permission to edit that comment.**
You have write access, so it should work for you — the open question is whether
an outside contributor can. Watch for:

```
edit on a quiz comment    sender=... author_association=...
```

No log line when you tick means the edit event never fired, which would mean
the checkbox flow can't be the primary input and the letter-reply path has to
be. That single observation is the main reason this live test exists.

Wrong answers get a revisit note and the comment re-renders with your ticks
intact. Right answers collapse the comment to one line and turn the check green.

## 6. Try the rest

```
@lgtm what is a token bucket?          → answered, with a link
@lgtm what does this PR do?            → declined, with a pointer at the file
```

Both need write access; comments from anyone else are ignored silently, and the
reason lands in the log rather than the thread.

To see merge blocking, add `enforce: true` to `.github/lgtm.yml` on `main` and
mark **LGTM — review confirmed** as a required check in branch protection. LGTM
deliberately lacks the permission to do that second step for you.

## Cleanup

I created `sparepartslabs/lgtm` before you pointed me at `spareparts-lgtm`.
It's redundant — delete it when convenient:

```sh
gh repo delete sparepartslabs/lgtm
```
