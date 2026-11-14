---
name: typescript-implementation-discipline
description: Implementation rules for Clockgrove TypeScript. Use when writing or reviewing code in packages/ or apps/, especially package boundaries, IDs and domain types, boundary validation, deterministic kernel logic, command results and errors, idempotency, transactions and dispatch, persistence, provider adapters and structured logs.
---

# TypeScript implementation discipline

Turn Clockgrove's boundaries into code where the right path is easy and a violation is obvious.

## Read first

These are the authority; where this page and they differ, they win.

- `docs/clockgrove-cloudflare-implementation-plan.md` §5.2 dependency direction, §5.3 core ports, §5.4 coding conventions, §6 IDs and envelopes.
- `dependency-cruiser.config.mjs` and `scripts/check-boundaries.mjs`: the enforced package rules (`pnpm check`).
- `AGENTS.md` (Dependencies): use an existing SDK or library before writing your own; record exceptions as an ADR.
- `docs/runbooks/development.md`, `docs/runbooks/testing.md`, `docs/runbooks/design-checklist.md`.
- The lockfile and `tsconfig.base.json` for versions and compiler settings, never prose.

## Rules

- **Dependencies point inward.** `contracts <- domain <- kernel <- application <- persistence <- apps/runtime`; `apps/web` imports only `contracts`. Domain and kernel import no Cloudflare, SQL, model, browser, telemetry or environment code. Production never imports `testkit`. Reason: the pure core stays deterministic and testable, and dependency-cruiser fails the build otherwise.
- **Branded IDs, never overloaded.** Every ID is an opaque branded string; a run ID is not a trace ID and a provider subject is not a principal ID. Also keep simulation time vs wall time, quantity with unit, and revision vs epoch as distinct types.
- **Validate once, at the boundary.** HTTP and WebSocket requests, queue and Workflow messages, model structured output, MCP arguments and results, webhooks, pack imports and versioned JSON from the database get strict decoders. Inside, pass typed values. A schema-valid identity field is still untrusted until trusted composition resolves it.
- **No hidden nondeterminism in canon.** Pass simulation time, named random stream state, revisions and policy versions in. No `Date.now()`, `Math.random()`, environment reads, global caches or network calls in kernel logic. Deterministic IDs come from the injected `IdSource`.
- **Results, not exceptions, for domain outcomes.** A command result distinguishes accepted, stale revision, denied with a safe reason, not found within scope, invariant violation and idempotent replay. Exceptions are for infrastructure faults. Errors carry stable codes and correlation identity; no catch-and-log without a typed disposition.
- **Idempotency is in the contract.** Stable operation IDs and durable receipts for commands, provisioning steps, queue and Workflow handlers and external effects. Same ID with the same bytes returns the stored result; same ID with different bytes is an invariant failure. Do not hide it in transport middleware.
- **Commit and dispatch together.** When a commit implies later delivery, record the dispatch in the same transaction, then deliver and reconcile. Never "commit, then hopefully publish".
- **The database enforces invariants.** Use constraints for anything that must hold under concurrency (cross-world containment, append-only journals). Projections and caches are visibly rebuildable. Every append-only table has a `db/retention.json` entry.
- **Wrap seams that matter.** Ports exist where provider replacement, testing, authority or durable contracts depend on them (`ModelGateway`, `CapabilityExecutor`, `SpatialIndexPort`, auth, artifact store). Do not wrap trivial libraries. Provider SDK types never appear in durable contracts.
- **Logs are not evidence.** Structured logs with world, timeline, command and run IDs, epochs and safe error codes; secrets and private payloads denied by default.
- **Readable for the next agent.** Explicit names, small modules with clear ownership, exhaustive tagged unions with `assertNever`, comments that state invariants and reasons, TSDoc on exported APIs, contracts in `packages/<package>/docs/`.

## Tests

Unit tests are scaffolding: write them while building, delete them before handoff unless the code sits in a listed `unitTestAreas` directory. Keep one integration test per claim through the real path (native owner, PostgreSQL, HTTP) with exact values whose expected side does not reuse the code under test. `pnpm check` enforces the test budget.

## Reject

Provider SDK types in domain contracts, unbranded string IDs at boundaries, hidden clock or randomness in reducers, direct SQL from unrelated layers, generic retry around non-idempotent effects, `any` to dodge a contract, mutable ledger or history rows, package cycles, unrecorded hand-written protocol or codec code.
