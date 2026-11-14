---
name: clean-room-provenance
description: Clockgrove's clean-room and provenance rules for clockgrove/clockgrove. Use when bringing in third-party code, data, assets or generated media, writing code from memory of another project, adding a dependency or hand-written protocol code, migrating a document, or reviewing whether a change could carry private, unlicensed or secret material into the public repository.
---

# Clockgrove Clean-Room and Provenance

Clockgrove is independently developed and public. Every file must be either original Clockgrove work or recorded third-party work under a licence the repository can take. The boundary is about source and ownership, not about pretending contributors have no prior experience.

## Authority

- `README.md`, "Clean-room and publication boundary".
- `CONTRIBUTING.md`, "Before you start" and "Pull requests".
- `docs/runbooks/development.md`: the `provenance.json`, `REUSE.toml`, SBOM and secret-name rules.
- `AGENTS.md`: Dependencies, and the publication boundary under Product and capability boundaries.
- `docs/policy/ai-content-disclosure.md` for AI-made assets.

They win over this page.

## Allowed and prohibited inputs

Allowed: general engineering knowledge, public standards and documentation, open-source code under a compatible licence, independently reasoned designs, and Clockgrove's own artifacts.

Never bring in: private source code or repository history from unrelated projects or employers; customer or personal data; private prompts, fixtures or datasets; credentials, secrets or config exports; proprietary assets; licence-incompatible code; unpublished operational history or personal deployment details. A concept may be re-derived independently; a private implementation may not be copied.

## Writing code you have seen elsewhere

Implement from the Clockgrove contract (package docs, protocols, tests), public provider documentation and dependency APIs. Never from remembered private code. Do not ask an agent to "recreate how project X did it".

## Bringing in third-party material

1. Prefer depending on the upstream package over vendoring (`AGENTS.md`, Dependencies). npm dependencies are covered by the SBOM from `pnpm run verify:supply-chain`; they need no `provenance.json` entry.
2. For anything else not original (vendored, copied, third-party-licensed, or generated from a third-party source): confirm the licence is compatible with MIT distribution, copy only what it permits, and in the same change add a `provenance.json` entry (path, source, SPDX licence, reason) and a matching `REUSE.toml` annotation. `pnpm check` refuses an entry with a missing path, source, licence or reason; `reuse lint` runs on every PR.
3. If the licence requires notices to travel with redistributions, update `THIRD_PARTY_NOTICES.md`.
4. Hand-written protocol, format or codec code needs an ADR in `docs/adr/` explaining why no library fits, and the PR names the choice.

## Generated and AI-made media

Record how each asset was made as the disclosure policy requires, and give it the provenance and licence records above when it derives from a third-party source. Art takes inspiration from broad styles, never a specific copyrighted work (see `brand-visual-direction`).

## Secrets and personal data

Never commit API keys, tokens, private keys, credentials, customer identifiers or environment dumps, in code, tests, issues, PRs or commit messages. Secret names live in `.env.example` and `.dev.vars.example` without values; real values come from the operator's secret manager. If a real secret reaches Git history, treat it as exposed: rotate it and report it as `SECURITY.md` describes.

## Migrating documents

Never make a truncated or reconstructed source look canonical. If an artifact cannot be retrieved completely, do not fill gaps from memory or chat summaries and do not commit an excerpt under the canonical name; say what is missing. Label format transformations (for example DOCX transcribed to Markdown). Repository documents describe the current state; private working history stays out of the repository (`docs/clockgrove-documentation-index.md` §8).

## Review questions

- Where did this exact text, code or asset come from?
- Is it Clockgrove-authored, public open source, or private third-party?
- If third-party, which licence applies, and are `provenance.json`, `REUSE.toml` and notices updated?
- Could it be written independently from the public contract instead?
- Is it complete, or a fragment presented as whole?
- Would it be safe if published today?

Routine original code needs no provenance note.
