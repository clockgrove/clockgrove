---
name: product-experience
description: Clockgrove's product-experience lens for clockgrove/clockgrove. Use when designing or reviewing anything a player or operator sees or does (observation, conversations, Why, Influence, return after time away, authoring, the web shell), or any feature that could drift toward a generic chatbot, an agent dashboard or a simulation control panel.
---

# Product experience

Clockgrove should feel like **a world worth caring about**, not an AI demo wearing a game skin. Clockgrove is the platform for any world; Raccoon World is the reference world and lives in its own repository (`clockgrove/raccoon-world`). Design for any world pack, and keep `worlds/fixture` working.

## Where the authority lives

- `docs/clockgrove-prd-v0.5.md`: thesis and principles (§3), user roles, chat modes and journeys (§5), timelines (§16), natural-language authoring (§17).
- `BRAND.md`: brand pillars (§4), dynamic-world storytelling (§8), brand test (§11).
- `DESIGN.md` for shell UI tokens; `apps/web/docs/scene.md` for the scene; `docs/protocols/realtime-projection.md` for what the client may show.
- `docs/policy/ai-content-disclosure.md`: how model-made content is disclosed to players.
- `docs/adr/clockgrove-adr-world-personas-and-object-mobility-policy.md` for human participation.

Those documents win over this page.

## Keep the operations distinct

Each is a separate operation with its own audience and authority (PRD §5.2):

- **Observe**: inspect authorized world state. Moving the camera moves no persona, actor or object.
- **Talk**: a durable, attributed conversation with an actor.
- **Why**: an explanation built from recorded evidence. Character narration may sit on top; it never replaces the evidence.
- **Influence**: a suggestion, teaching or offer that enters the actor's decision; it is not control.
- **Public speech**: a committed speech act resolved through audience rules.
- **Physical action**: a typed command (give, place, move, pick up, use).
- **Authoring**: an explicit operator mode that produces a validated, previewable changeset.

Prose never silently performs a physical change or an authoring change.

## The world continues beyond the frame

A good feature strengthens at least one of: persistence, visible consequence, understandable motivation, relationship continuity, spatial coherence, memory and learning, curiosity on return. Ask what happens before the player arrives, while they watch, after they leave and when they return. "While you were away" is built from material events, not generated flavour text.

## Actors, objects and places

- Characters are actors inside a world, not mascots or chat endpoints. For an actor-facing feature ask: what does it need, what could it perceive, what memory or relationship evidence applies, what actions are physically and socially available, what changes later, and can Why show it?
- "Talk to anything" does not make everything sentient. Disclose the mode: embodied dialogue, interpreted perspective (grounded in modelled state and history) or operator inspection. An interpreted object never invents an actor's private beliefs or facts it could not know.
- A modest interaction that becomes durable history beats a clever conversation that changes nothing later.

## Avoid generic AI UX

Keep the world surface concrete: no prompt-box-first layouts, agent status boards, token counters, glowing AI indicators, raw chain-of-thought, "autonomous agent" jargon, or a list of bots instead of a place. Put technical detail in inspector and developer surfaces.

## Review questions

- Does it make the world feel more alive, or just add a control?
- Is surprising behaviour explainable from recorded evidence?
- Does it respect actor agency and world authority, and keep objective and subjective truth apart?
- What persists, and what is presentation only?
- What does the player see when a model or provider fails? Is there a deterministic or text fallback?
- Is there an accessible text equivalent?
- Does the reference world get more compelling without making the platform world-specific?

## For a product design, state

The visible flow, the underlying semantic operation, what is durable and what is presentation only, the authority involved, the degraded experience, the text equivalent, and the evidence that it is better rather than merely more featureful.
