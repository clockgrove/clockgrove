# AI content disclosure policy

How Clockgrove tells players which content AI made. Owner decision, 2026-11-07 (issue 83).

Clockgrove uses the two categories Steam adopted in its January 2026 disclosure update ([PC Gamer report](https://www.pcgamer.com/software/ai/steam-updates-ai-disclosure-form-to-specify-that-its-focused-on-ai-generated-content-that-is-consumed-by-players-not-efficiency-tools-used-behind-the-scenes/)): content made before shipping, and content a model makes while the game runs. Disclosure covers what players see, hear or read.

This policy points at the plans that build each disclosure. It does not change their acceptance.

## Pre-generated content

Assets made with AI before shipping: sprites, art, audio, text.

- **World pack.** A pack discloses its AI-made assets in its asset provenance and license report. For Raccoon World that is [`assets/license-report.md`](https://github.com/clockgrove/raccoon-world/blob/main/assets/license-report.md), generated from each asset's manifest (creator, tool, source, review).
- **Per asset.** Each asset records how it was made as an [IPTC Digital Source Type](https://cv.iptc.org/newscodes/digitalsourcetype/) (`trainedAlgorithmicMedia`, `compositeWithTrainedAlgorithmicMedia` or `digitalCreation`), in its provenance record and embedded in the file's XMP, so any tool or store can read it. Assetforge writes it ([clockgrove/assetforge#29](https://github.com/clockgrove/assetforge/issues/29)).
- **Review.** AI-made assets go through the same human review as any other asset: a named reviewer approves each one before it ships ([asset pipeline](../../packages/assets/docs/pipeline.md#steps)). Assetforge never approves an asset.
- **Requirement.** The PRD requires provenance on every asset ([PRD §6.4](../clockgrove-prd-v0.5.md#64-asset-pipeline)).

## Live-generated content

Model output players see at runtime: actor conversations, actor speech, interpreted perspectives, generated text and summaries.

- **Disclosed where it appears.** The UI labels it in place. Wave 5's voice disclosure is this category's UI: each session and, where ambiguous, each answer is labelled cognitive (the actor's own subjective words), interpreted (a narrated reading of modeled state; the object is not sentient) or canonical/operator (an authorized explanation from world evidence) ([Wave 5 §6.3](../waves/clockgrove-wave-5-conversations-models-capabilities-mcp-implementation-plan.md#63-voice-disclosure), [§14](../waves/clockgrove-wave-5-conversations-models-capabilities-mcp-implementation-plan.md#14-web-experience)).
- **PRD requirements.** The UI discloses the interaction mode ([PRD §5.2](../clockgrove-prd-v0.5.md#52-chat-modes)) and whether an answer is an actor's belief, an interpreted perspective or canonical state ([PRD §10.2](../clockgrove-prd-v0.5.md#102-actor-activation-and-cognitive-turn-execution)).
- **Authoring and previews.** Authoring shows its mode and authority, and preview results separate model-generated hypotheses from simulated consequences ([Wave 7 §12](../waves/clockgrove-wave-7-rules-timelines-authoring-implementation-plan.md#12-fast-forward-and-comparison), [§14](../waves/clockgrove-wave-7-rules-timelines-authoring-implementation-plan.md#14-authoring-web-experience)).
- **The demo.** Raccoon World covers every response mode, each answer carries its mode and evidence, and players are tested on telling them apart ([Wave 8 §9.1](../waves/clockgrove-wave-8-living-neighborhood-demo-implementation-plan.md#91-required-modes-in-the-yard), [§9.2](../waves/clockgrove-wave-8-living-neighborhood-demo-implementation-plan.md#92-grounding), [RW-0806](../waves/clockgrove-wave-8-living-neighborhood-demo-implementation-plan.md#rw-0806--objectspace-conversation-and-interaction-polish), [§16.2](../waves/clockgrove-wave-8-living-neighborhood-demo-implementation-plan.md#162-product-rubrics)).

### Guardrails

- **Grants.** Models propose; they never mutate the world directly. Tools run only under capability grants scoped to tenant, world, timeline, actor and session, with human approval for high-impact actions ([Wave 5 §11.2](../waves/clockgrove-wave-5-conversations-models-capabilities-mcp-implementation-plan.md#112-grants-and-approvals), [PRD §22.2](../clockgrove-prd-v0.5.md#222-required-controls)).
- **Privacy.** Tenant, timeline and session privacy is enforced in SQL and application paths; credentials never reach a model ([Wave 5 §18](../waves/clockgrove-wave-5-conversations-models-capabilities-mcp-implementation-plan.md#18-budgets-observability-and-security)).
- **Moderation.** Every message records a moderation disposition ([Wave 5 §6.2](../waves/clockgrove-wave-5-conversations-models-capabilities-mcp-implementation-plan.md#62-messages-and-turns)). Generated content that breaks world policy is a named threat ([PRD §22.1](../clockgrove-prd-v0.5.md#221-threat-model)); mute, revoke and kill switches act without waiting for the model.

### Reporting

Players can mute, block and report an actor's proactive contact, and report public or shared content, through the GA moderation hooks ([Wave 9 §7.1](../waves/clockgrove-wave-9-ga-open-source-release-implementation-plan.md#71-controls)). Until those ship, open a GitHub issue, or follow [SECURITY.md](../../SECURITY.md) when the content exposes private data.

## Not player content

Development tools are not disclosed as player content: Factory, coding agents, and models that help write code, docs or tests. This matches Steam's focus on content players consume. Assets those tools produce for players are still pre-generated content and follow that section.
