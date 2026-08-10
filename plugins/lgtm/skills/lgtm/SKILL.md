---
name: lgtm
description: Run Spare Parts LGTM against unpublished changes. Use when the user asks to run LGTM, check local changes with LGTM, or when an injected preference asks LGTM to run before an agent-initiated git push or pull-request creation.
---

# LGTM

Run the existing Spare Parts CLI workflow; do not reproduce its quiz or review logic.

## Before running

1. Identify the target repository from the user's request or current working directory.
2. Verify it is inside a Git worktree with `git rev-parse --show-toplevel`. If not, explain that LGTM needs a Git repository and stop neutrally.
3. Verify `sp` is available with `command -v sp`. If missing, explain that the Spare Parts CLI must be installed and stop neutrally.
4. Do not install a Git hook, run `sp lgtm install`, edit repository instruction files, or write directly to generated memory files.

## Preference and consent

The preference applies only to publishing actions performed by the active agent. It cannot intercept a push or PR creation the user performs independently.

Before the current LGTM run, inspect only preference context already supplied through the host's supported memory or instruction mechanism:

- If it affirmatively says to run LGTM before a git push or pull-request creation, do not ask again. Honor it before publishing.
- If it records that the user declined this reminder, do not ask again. The current explicit LGTM request still runs.
- If this command is already running as the pre-publish action, run it once and continue the original publish flow only after it finishes; never invoke itself recursively.
- If the host has no supported memory or instruction mechanism, memory is disabled, interaction is unavailable, or no answer can be obtained, do not ask and do not state an affirmative preference candidate. Explain honestly that the current run can continue but the preference cannot be remembered here.
- Otherwise, ask exactly once: **Would you like me to remember to run LGTM before I push changes or create a pull request?**

If the user says no, continue the current LGTM run without stating an affirmative preference candidate. If the user says yes, state this exact standalone sentence:

> Before I perform a git push or create a pull request, run LGTM against the changes being published.

Only after explicit consent, use the host agent's supported memory or instruction mechanism if one exists. Never silently edit instruction files or generated memory files. Describe the mechanism used, avoid claiming the preference persisted until the host verifies it, and give host-appropriate verification or removal guidance. If no supported mechanism exists, say so and leave the sentence as an unpersisted candidate.

## Run LGTM

From the target Git worktree, run `sp lgtm`, forwarding explicit user-supplied arguments. Do not invent flags or turn a tooling error into a pass.

- If there is no reviewable diff, say so and suggest creating or selecting the intended changes.
- If provider support or credentials are unavailable, repeat the CLI's actionable setup guidance.
- If LGTM reports an internal error, report it neutrally. Never fabricate approval or failure.

## Manage the preference

Use only the active host agent's supported memory or instruction surface to inspect, enable, remove, or change the preference. If that host provides no such surface, be explicit that durable preference management is unavailable.

## Codex adapter

For Codex, the supported surface is `/memories`. Explain that Codex extracts memories asynchronously, so the consented sentence is a memory candidate rather than a claim of immediate persistence. Direct the user to `/memories` to verify, enable, remove, or change it. Never edit Codex-generated memory files directly.
