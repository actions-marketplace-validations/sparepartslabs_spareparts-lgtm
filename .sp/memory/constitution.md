<!--
SYNC IMPACT REPORT
Version change: unfilled template -> 1.0.0
Rationale: First evidence-based LGTM constitution.
Principles: Strict Types; Privilege Separation; Quiz Integrity; Neutral Failure and
Provider Parity; Deterministic Coverage.
Templates checked: OK .sp/templates/plan-template.md, spec-template.md,
tasks-template.md, and .claude/commands/constitution.md.
-->

# Spare Parts LGTM Constitution

## Stack & Constraints

LGTM is strict TypeScript on Node 22 and 24. It has no server or database. Untrusted
review events cross from a permissionless collector into a privileged workflow.

## Core Principles

### I. Strict Types at Trust Boundaries

No any or double assertion may bypass validation. Webhooks, relay artifacts, repository
configuration, model output, and comment state MUST remain unknown until parsed and
narrowed. Invalid state transitions SHOULD be excluded with discriminated unions.

### II. Privilege Separation

Fork-controlled code MUST NOT run with secrets or write tokens. The collector remains
permissionless; privileged code MUST treat relay data as untrusted. Runtime secrets MUST
come from declared action.yml inputs and MUST never enter logs, artifacts, comments,
prompts, or model-visible data.

### III. Quiz Integrity

LGTM confirms reading; it is not a code reviewer. Questions MUST be answerable from cited
changed hunks, independently verified, and free of style trivia or hidden context.
Answers MUST remain authenticated and unpublished. Edited or unverifiable state MUST be
reissued or rejected. Waivers and enforcement changes MUST remain auditable.

### IV. Neutral Failure and Provider Parity

LGTM-side errors MUST conclude neutral, never failure, so a broken tool cannot freeze a
repository. Anthropic, OpenAI, and Gemini MUST provide equivalent generation,
verification, reading, and question-answering behavior. Provider-specific shortcuts MUST
NOT weaken grounding or security.

### V. Deterministic Coverage

Behavior changes MUST include offline tests. Relay validation, author permission,
tampered seals, base-branch config, and neutral conclusions require focused coverage.
npm run typecheck and npm test MUST pass on all supported Node versions. Privileged npm
installs retain --ignore-scripts unless the trust model is deliberately changed.

## Review Process

Review source and caller workflows together. Secret exposure, privileged execution of
fork code, forged quiz acceptance, answer publication, or blocking internal failures are
Critical. Every finding MUST cite file and line, describe impact, and propose a targeted
fix.

## Governance

Constitution Check exceptions require written justification. All commits MUST
use Conventional Commits with an accurate type and optional scope; breaking behavior
uses ! or a BREAKING CHANGE footer. No AI or tool attribution is allowed.

Amendments require evidence. MAJOR removes or redefines a principle, MINOR adds or
expands one, PATCH clarifies. README.md, TESTING.md, action.yml, and workflows MUST stay
consistent with this constitution.

**Version**: 1.0.0 | **Ratified**: 2026-08-09 | **Last Amended**: 2026-08-09
