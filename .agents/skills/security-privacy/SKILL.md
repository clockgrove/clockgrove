---
name: security-privacy
description: Threat model and privacy rules for Clockgrove. Use when designing or reviewing authentication, authorization grants, tenancy, world membership and personas, projection privacy, RLS and database roles, secrets, MCP and tool effects, moderation, logging, pack import, billing boundaries, or any change where identity, data or actions could cross a scope.
---

# Security and privacy

Authority and privacy are explicit in the same places Clockgrove makes world truth explicit, from the first durable contract.

## Read first

These are the authority; where this page and they differ, they win.

- `docs/protocols/shared-contracts.md`: execution-context trust boundary, privacy categories, attribution.
- `docs/protocols/capabilities.md` and `docs/protocols/mcp.md`: grants, budgets, revocation, effect approval.
- `docs/runbooks/database.md`: roles and transaction-local runtime authorization.
- `docs/protocols/realtime-projection.md` (Audience, assets and privacy).
- `docs/adr/clockgrove-adr-management-plane-world-runtime-plane-and-shared-wallet.md` and `docs/adr/clockgrove-adr-world-personas-and-object-mobility-policy.md`.
- `docs/runbooks/design-checklist.md`: questions 1 (authority) and 3 (attribution) are security questions.
- `SECURITY.md` for reporting.

## Trust boundaries

Untrusted until verified: browser fields, provider profile claims beyond the verified mapping, model output, MCP and tool input and output, queue and webhook payloads, pack and asset imports, user-authored rules, external URLs, and any ID from another scope. Schema-valid is not authority-valid: `decodeExecutionContext` creates no authority; only trusted composition mints a `TrustedExecutionContext`, and narrowing can only remove grants.

## Identity layers

`Principal -> WorldMembership -> WorldPersona -> Presence`, with external identity and workspace membership separate. A provider session does not imply world access; workspace admin does not imply world membership; presence does not imply durable membership. Resolve trusted identity server-side from authenticated context.

## Rules

- **Authorize at the owner.** Management authorizes workspace, provisioning and billing; Runtime authorizes world entry, commands, object use, cognition access and scene evidence. Models and tools propose; they never grant themselves authority. The browser renders effective actions; it never creates them.
- **Narrowest grant.** A new power gets its own grant rather than riding a broad one (e.g. `runtime:world-clock` apart from `runtime:world-command`).
- **Scope every query.** Carry and check tenant, world and timeline; use branded IDs, scope-requiring repository methods, database constraints and RLS. Never load by global ID and check the tenant later.
- **Privacy before delivery.** Five categories: `public_scene`, `private_cognition`, `conversation`, `credential`, `operator_evidence`. A ceiling is a set, narrowed by inclusion. Only `public_scene` enters shared projection. On revocation, purge client state before the next render.
- **Cognition is private.** Raw memories, beliefs and relationships stay out of nearby players' views, generic projections, other actors' context and public Why. Why shows only evidence the requester may see; operator detail needs an explicit grant.
- **Effects are capabilities.** An effectful tool needs a declared capability, scope, input validation, approval policy, stable operation ID, timeout and retry policy, unknown-outcome reconciliation, provenance and budget. A denial cannot be bypassed through a more generic tool.
- **Secrets stay out** of Git, journals, prompts, browser bundles, logs, evidence, pack artifacts and any plane that does not need them. Credentials are environment references resolved by adapters. Least privilege per plane.
- **Money is Management-only.** Runtime never stores card details, provider customer or subscription IDs, invoices, tax, refund or dispute state; it consumes entitlement mode, epoch and bounded lease with safe reason codes.
- **Moderation is an audited authority path**, not a superuser shortcut. A removed or suspended user loses mutation authority promptly, including on open sockets.
- **Rate limits protect availability**, never replace authorization.
- **Packs are validated before install**: schema, references, compatibility, hashes, asset type and license, bounded rules; no untrusted code path.
- **Logs minimize payloads.** Keep operational telemetry, canonical evidence, protected cognitive evidence and accounting evidence apart. Sampling telemetry never erases required audit evidence.

## Threat questions

What can the caller forge or guess? Which trusted facts are client- or model-supplied? What is the smallest grant? What does deny or not-found return, and can timing or error differences reveal hidden objects or membership? What survives revocation: stale sockets, leases, claims? What private data reaches prompts, tools or logs? What happens after a provider token leaks?

## Proving it

The database attack suite (`tests/database/`) proves authorization and isolation; extend it rather than adding a parallel harness. Each security claim gets one integration test through the real path with foreign IDs, forged fields or revoked membership (`docs/runbooks/testing.md`).

## Reject

Authorization inferred from UI state, provider organization as world permission, "admin can edit any runtime row", client-supplied attribution, private cognition in generic search or projection, secrets shared across planes, logging everything for debugging.
