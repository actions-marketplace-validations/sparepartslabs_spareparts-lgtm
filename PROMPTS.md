# The shared prompts

`lgtm-questions.v1.json` is byte-identical in two repositories and loaded at
runtime by both:

| Repo | Path | Language |
|---|---|---|
| [`spareparts-cli`](https://github.com/sparepartslabs/spareparts-cli) | `src/spareparts/prompts/lgtm-questions.v1.json` | Python |
| [`spareparts-lgtm`](https://github.com/sparepartslabs/spareparts-lgtm) | `prompts/lgtm-questions.v1.json` | TypeScript |

The paths differ because the packaging does — Python needs it inside the package
to survive a wheel build. **The bytes do not differ, and that is the point.**

## Why

The CLI and the GitHub Action write comprehension questions about the same
diffs. Two tools disagreeing about the same diff is worse than either being
imperfect on its own: it makes the questions look arbitrary, and it makes any
judgement about question quality unreproducible.

Before this file existed the two had already drifted in three places — the
opening framing, "the reviewer" versus "the person answering", and "about this
PR" versus "about this change". Nobody decided that. It happened because the
same paragraph lived in two source files.

## The rule

**No repo-specific vocabulary.** The Action addresses a reviewer who has just
approved a pull request. The CLI addresses someone about to merge a branch they
just read. The prompt has to be true of both, which is why it says neither
"pull request" nor "reviewer". A test in each repo asserts those words are
absent.

## Changing it

Both repos pin the file's SHA-256 and assert it in a test, so an edit fails
until you acknowledge it. That is deliberate: the failing test is the reminder
that the change is not finished.

1. Edit the file.
2. Update the pinned hash in that repo.
3. **Copy the file to the other repo and update its pinned hash too.**
4. Run both test suites.

Doing 1–2 without 3 is exactly the drift this file exists to prevent, and the
hash will not catch it — the guard makes an edit *loud*, it cannot make it
*synchronised*. Nothing but this document does that.

Get the hash with:

```sh
shasum -a 256 <path to the file>
```

## Versioning

The filename carries `v1`. If a change would make the two tools ask materially
different questions and they cannot ship together, add `v2` alongside rather
than editing `v1` in place, and let each repo move when it is ready. Editing in
place is correct for wording; a new file is correct for a change in what gets
asked.
