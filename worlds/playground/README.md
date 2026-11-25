# Playground pack (`clockgrove.playground@1.1.0`)

## Purpose

The neutral default world, in the spirit of a 3D editor's default plane and cube: simple and quiet, so the
engine is easy to see and nothing distracts. It is little more than a rock, declared in the disclosed object (interpreted)
Conversation mode, declared a shelter (`clockgrove.shelter`, `rainProtection` 5000: others may shelter at it), and with the capability its scenario changes the weather through,
plus the smallest neutral set the shared conformance suite requires of every committed pack (a cube with a
need and a puddle it drinks from). Weather does not change the rock's own properties yet. Under
`pnpm playground` its owner can Talk to the rock: the owner's privacy ceiling holds the `conversation`
category, and since the pack declares no model, the runtime's scripted conversation fixture answers, so no
model key is needed. It has nothing to do with any other world, and it is separate from `worlds/fixture`, which exists to catch
reference-world assumptions. Every identity uses the `playground.` prefix.

## Contents

- space `playground.plane` (one rectangular region);
- `playground.cube`, a placed mobile subject with needs (archetype `playground.cube-kind`, trait
  `playground.thirst`);
- `playground.rock`, a stationary object (archetype `playground.rock-kind`, `interpreted` Conversation mode,
  shelter `clockgrove.shelter` with `rainProtection` 5000 and no declared cover), bound to the `playground.voice` embodied-dialogue capability;
- `playground.puddle`, a water resource holder the cube drinks from;
- a scripted memory of the puddle for the cube (`cognition/memory.json`);
- rule `playground.drizzle` (schedule trigger) emitting a weather command intent;
- clock and behaviour policies, and a `weather` random stream.

There is no art: the manifest lists no assets.

## Scenario

`scenarios/weathered-rock.json` submits one weather command through the rock's `playground.voice` binding,
two commands that binding refuses, then advances 70 seconds. It asserts: the weather command is accepted
through `playground.rock`'s `playground.voice@1` and its one `weather.changed` event is attributed to the
rock, initiated by the scenario; a `movement.interrupt` through the same binding is refused
`CAPABILITY_COMMAND_UNDECLARED`; the same weather command by `playground.cube`, which holds no such binding,
is refused `CAPABILITY_NOT_HELD`; the cube uses the scripted memory of the puddle, chooses to seek water,
reaches the puddle and drinks twice, leaving it with 3 units; the `playground.drizzle` rule records a weather
intent at 120000, recorded and not executed; and replay reproduces the final state. Its reviewed golden is
`goldens/weathered-rock.json`.
