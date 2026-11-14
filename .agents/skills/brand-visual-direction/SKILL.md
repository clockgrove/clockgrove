---
name: brand-visual-direction
description: How to create or review Clockgrove's own brand art and copy in clockgrove/clockgrove. Use for website, documentation and marketing illustrations, platform demo key art, icons and diagrams, image-generation prompts for them, the neutral web shell's look, and brand copy. Not for a world pack's art, which follows that world's style bible in its own repository.
---

# Clockgrove Brand and Visual Direction

Clockgrove looks like a living illustrated world: warm, busy, inspectable, persistent and causal. Intelligence shows through behaviour, history and consequence, never through AI imagery.

## Pick the right authority

| Work | Authority |
| --- | --- |
| Clockgrove brand idea, voice, naming, population rule | `BRAND.md` |
| Clockgrove brand art and image generation for it | `STYLE.md` |
| Neutral web shell colours, type, layout, components | `DESIGN.md` (checked by `pnpm check`) |
| A world's art, cast, setting and prompts | That world's style bible in its own repository, not this one |
| Disclosing AI-made content to players | `docs/policy/ai-content-disclosure.md` |

Read the authority before you draw or write; it wins over this page. Reason: Clockgrove is world-agnostic, so world-specific setting, characters and palettes belong with the world, not with the platform.

## Rules that never bend

- No humans and no robots in Clockgrove art (`BRAND.md` §5, `STYLE.md` §2). People appear only indirectly: selection, notes, nameplates, viewpoint.
- No generic AI aesthetics: neon gradients, circuit boards, glowing brains, holograms, chrome sci-fi, data particles.
- Original work only. Take the spirit of a classic busy animal-town picture book (`BRAND.md` §7); never reproduce a specific copyrighted illustration, character, composition or logo.
- Every scene shows state and history: visible causes, objects in transit, unfinished actions, before, now and after.

## Making an image

1. Build the prompt with the composition recipe in `STYLE.md` §14, starting from the prompt nucleus (§15) and the scene pattern (§16).
2. Describe activity, state, causality and history in general terms; world-specific cast and setting come from the world's own guide (`STYLE.md` §17).
3. Review the result against the rejection criteria (§18) and the final visual test (§19), and against the brand test in `BRAND.md` §11.
4. Before committing generated media, record how it was made as the disclosure policy and `docs/runbooks/development.md` require (asset provenance; a `provenance.json` entry and `REUSE.toml` annotation for anything generated from a third-party source).

## Writing copy

Follow `BRAND.md` §9 (voice) and §10 (naming): curious, clear, quietly playful, concrete world language, no enterprise AI slogans.

## Output

For creative work, give a concrete brief: world state, focal action, micro-stories, causal evidence, composition, rendering language, constraints and continuity notes. For a review, name exactly which `BRAND.md` and `STYLE.md` rules the work meets or breaks.
