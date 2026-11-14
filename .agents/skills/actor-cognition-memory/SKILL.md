---
name: actor-cognition-memory
description: Rules for designing or implementing Clockgrove actor cognition in clockgrove/clockgrove. Use for perception, conversations, the model gateway, decision points, context assembly, tools and MCP, memory, beliefs, relationships, field guides, social learning, actor-authored SKILL.md and compiled policy, or any model-backed actor behaviour.
---

# Clockgrove Actor Cognition and Memory

Actors should behave differently because of what they perceived, remember, believe and learned, while cognition stays subjective, inspectable, bounded, and unable to change physical truth directly.

## Authority

Read the documents for the part you touch; they win over this page.

- Boundaries: Wave 5 §3 and Wave 6 §3 in `docs/waves/`.
- Decision tiers: `docs/adr/clockgrove-adr-actor-decision-ladder.md`.
- Field guides and counterfactual Why: `docs/adr/clockgrove-adr-field-guides-and-counterfactual-why.md`.
- Implemented contracts: `docs/protocols/` (`conversations.md`, `conversation-fibers.md`, `runs.md`, `context-assembly.md`, `capabilities.md`, `mcp.md`, `decision-shadow.md`), `packages/model-gateway/docs/model-gateway.md`, and `packages/kernel/docs/` (`perception.md`, `utility-decisions.md`).

## The boundary

Cognition may receive authorized perceptions, retrieve the actor's own context, converse, call granted tools, and **propose** speech, world commands, memory changes and plans. It may not write physical state, fabricate perception, treat model text as committed fact, widen its own grants, skip expected revisions, or write another actor's private cognition. Every behaviour-affecting result becomes a typed event through the Journal after validation. Reason: the deterministic world must stay replayable and the model must never become world-truth authority.

## Keep epistemic kinds apart

Perception, episode, claim, evidence, belief, relationship, summary and skill are different state classes with different authority (Wave 6 §3.1). Firsthand experience is not testimony; social learning keeps who said what. Summaries keep source links and uncertainty. Embeddings and indexes are rebuildable projections. Do not collapse it all into "memory" or treat retrieval as memory.

## Decide at the lowest tier that can

Use the five-tier ladder: reflex, utility scoring, compiled policy, bounded decision model, open-ended LLM. A tier that cannot decide abstains with a recorded reason. Tiers 1 to 3 run the world with models off. A decision model only picks among candidates the kernel already made valid, uses a configured alias, and has a budget and a deterministic fallback. Replay reads recorded answers and never calls a model. Model use should scale with meaningful cognitive work, not wall time, and a logical actor is dormant until something needs its attention.

## Perception and context

Perception is actor-relative and policy-filtered (location, senses, audience, privacy, timing). Do not fan every event out to every actor; resolve audiences and wake actors only when an event is relevant.

Authorize before retrieving. Each turn records a context manifest: every candidate source with its version, trust label and decision, and the rule behind each exclusion, reproducible from recorded inputs (`context-assembly.md`). Never inject global state "because the model might need it". Raw prompts, transcripts and provider payloads are protected evidence with retention, not general context.

## Models, tools and MCP

Clockgrove owns the run loop even when an SDK executes the model: aliases and routing, structured proposal schemas, approvals, run and step evidence, retry and reconciliation, fallback and telemetry. Provider SDK objects never become durable identity.

A tool is a granted capability, not an ambient power. A model's tool call is a proposal to the capability layer; accepted world commands still pass ordinary validation. External effects use intent, outbox, idempotency and a recorded disposition; replay never resends them; preview timelines block or simulate them.

## Conversations

A session is a durable transcript and execution scope, not the actor's memory or identity. Keep separate: streamed provisional text, the final durable message, private Caretaker Talk, public speech, proposed actions, committed effects and memory changes. An interrupted stream is not the transcript.

## Memory writes and learning

Memory changes are structured change sets against governed, versioned actor documents, with evidence references, source type, preconditions, size bounds, privacy scope and a contradiction policy. A model never rewrites a whole memory store as one blob.

Actor-authored `SKILL.md` and compiled policy are actor-scoped, evidence-linked, versioned, bounded in capability, governed on adoption and invalidation, and proven by changed behaviour. When one actor teaches another, store the lesson as the learner's testimony or observed demonstration, never as a copy of the teacher's episode; the learner forms its own belief. Field guides are attributed testimony to their readers and never become world truth.

## Why without hidden reasoning

Do not store or require chain-of-thought. Explain behaviour from salient perceptions, retrieved evidence, candidates and scores, the selected proposal, model and tool receipts, the authority result and downstream event links.

## Degraded modes

Define behaviour for an unavailable provider, an exhausted budget, failed retrieval, a denied tool, an interrupted run and stale compiled policy. Model unavailability degrades cognition; it never stops the world.

## Proving it

Test behaviour, not retrieval accuracy: a later choice changes after an episode; contradictory evidence revises a belief; a taught skill changes behaviour; privacy blocks cross-actor leakage; models-off keeps routine behaviour; a stale proposal is refused at commit; inspection recovers run inputs and evidence. Test placement and budget follow `docs/runbooks/testing.md`.

## Output

For a cognitive feature, specify perception inputs, the context manifest, the decision tier and activation policy, model and tool contracts, the proposal or change-set schema, persistence and provenance, revalidation at commit, privacy, fallback, and the behavioural test.
