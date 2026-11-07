# Test-world fixture pack (`clockgrove.test-world@1.1.0`)

## Purpose

A tiny, deliberately non-reference pack. It exists to catch accidental reference-world assumptions: the
shared conformance suite runs it next to the reference pack, so any engine code that quietly depends on
reference-world names, places or actors fails here. Its theme is a lighthouse hall, and every identity
uses the `beacon.` prefix.

## Contents

- space `beacon.hall` (one rectangular region);
- a placed mobile subject with needs: `beacon.master` (archetype `beacon.keeper-kind`, trait
  `beacon.needs`);
- a stationary conversational object `beacon.lamp`, bound to the `beacon.speak` embodied-dialogue
  capability;
- resource holders `beacon.larder` (food) and `beacon.cistern` (water);
- a scripted memory entry (`cognition/memory.json`);
- rules `beacon.on-choice` (event trigger) and `beacon.on-tide` (schedule trigger), each emitting a
  weather command intent;
- clock and behaviour policies, and a `weather` random stream.

## Scenario

`scenarios/non-raccoon-conformance.json` submits one weather command through the lamp's `beacon.speak`
binding, two commands that binding refuses, then advances 70 seconds. It asserts what that run does: the
weather command is accepted through `beacon.lamp`'s `beacon.speak@1` (an `embodied-dialogue` capability)
and its events are attributed to the lamp, initiated by the scenario; a `movement.interrupt` through the
same binding is refused `CAPABILITY_COMMAND_UNDECLARED`, because `beacon.speak` declares only
`world.weather.set` v2; a weather command through `beacon.speak@1` by `beacon.master`, which holds no such
binding, is refused `CAPABILITY_NOT_HELD`; the subject eats once from the larder and drinks once from the
cistern (leaving it with 4 units), finally chooses to seek water using the scripted memory of the cistern and
reaches it; the choice rule and the tide rule each record a weather intent, which is recorded and not
executed (disposition `recorded-not-executed`); and replay reproduces the final state. Its reviewed golden
is `goldens/non-raccoon-conformance.json`.

The larder and the lamp's rain shelter are part of the pack for contract coverage and for the subject's
choices.

`long-runs/` holds the 30-day and one-year qualification scenarios (summarised recording, no goldens, not in
the pack artifact). They run only in the qualification workflow, through `pnpm run qualify:wave1:long-runs`.
