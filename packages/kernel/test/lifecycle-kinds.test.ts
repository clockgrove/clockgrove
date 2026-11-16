// Lifecycle per kind and the mate rule (#355), short enough for `pnpm test`.
import { describe, expect, it } from "vitest";
import {
  conceptionDecisions,
  eventsOf,
  lifeChain,
  lifecycleSample,
  lifeWorldFromSample,
  PAIR_SPEC,
  payloadOf,
  SURE_SPEC,
  timeOf,
} from "./lifecycle.scenario.js";

describe("kinds and mates", () => {
  it("leaves a kind with no declared lifecycle out of aging, death and conception", async () => {
    const sample = lifecycleSample({
      ...SURE_SPEC,
      actors: [
        ["a-resident", null],
        ["b-dog", null],
      ],
    });
    const { schemaVersion: _, ...kind } = sample.pack.policy.lifecycle;
    sample.pack.policy.lifecycle = {
      schemaVersion: 2,
      kinds: [{ archetypes: ["reference.weather@1"], ...kind }],
    };
    sample.pack.archetypes.push("reference.dog@1");
    sample.initialState.entities.find(
      (entity: { objectId: string }) => entity.objectId === "b-dog",
    ).archetypeId = "reference.dog@1";
    // The declared adult founder, born at -2000 with a 12000 ms lifespan, dies at 10000; a v1 dog born at 0 would die at 12000.
    const run = lifeChain(await lifeWorldFromSample(sample), "kinds", 13000n);
    expect(
      eventsOf(run.events, "lifecycle.died").map((e) => [payloadOf(e).objectId, timeOf(e)]),
    ).toEqual([["a-resident", 10000n]]);
    expect(
      run.events.filter(
        (e) => e.type.startsWith("lifecycle.") && Object.values(payloadOf(e)).includes("b-dog"),
      ),
    ).toEqual([]);
    expect(conceptionDecisions(run.drafts).filter((d) => d.objectId === "b-dog")).toEqual([]);
    expect(conceptionDecisions(run.drafts)[0]).toMatchObject({
      objectId: "a-resident",
      simulationTime: 1000n,
      outcome: "conceived",
    });
    expect(run.world.state.lifecycle!.entries.find((e) => e.objectId === "b-dog")).toMatchObject({
      stageIndex: 0,
      conceptions: 0,
      gestation: null,
      death: null,
    });
  });

  it("refuses a co-parent that is the actor's own parent or child", async () => {
    const sample = lifecycleSample(PAIR_SPEC);
    Object.assign(sample.initialState.lifecycle.entries[1], {
      parentIds: ["a-resident"],
      generation: 1,
    });
    const run = lifeChain(await lifeWorldFromSample(sample), "mates", 1000n);
    expect(
      conceptionDecisions(run.drafts).map((d) => [d.objectId, d.simulationTime, d.exclusion]),
    ).toEqual([
      ["a-resident", 1000n, "no-co-parent"],
      ["b-resident", 1000n, "no-co-parent"],
    ]);
    expect(eventsOf(run.events, "lifecycle.conceived")).toEqual([]);
  });

  it("refuses a co-parent that is the actor's sibling", async () => {
    // c-elder is the parent of both, so it is no co-parent either.
    const sample = lifecycleSample({
      ...PAIR_SPEC,
      actors: [...PAIR_SPEC.actors, ["c-elder", null]],
      founderBornAt: { ...PAIR_SPEC.founderBornAt, "c-elder": -3000 },
    });
    for (const entry of sample.initialState.lifecycle.entries.slice(0, 2))
      Object.assign(entry, { parentIds: ["c-elder"], generation: 1 });
    const run = lifeChain(await lifeWorldFromSample(sample), "siblings", 1000n);
    expect(
      conceptionDecisions(run.drafts).map((d) => [d.objectId, d.simulationTime, d.exclusion]),
    ).toEqual([
      ["a-resident", 1000n, "no-co-parent"],
      ["b-resident", 1000n, "no-co-parent"],
      ["c-elder", 1000n, "no-co-parent"],
    ]);
    expect(eventsOf(run.events, "lifecycle.conceived")).toEqual([]);
  });

  it("refuses a co-parent of another archetype, even one the same kind declares", async () => {
    const sample = lifecycleSample(PAIR_SPEC);
    const { schemaVersion: _, ...kind } = sample.pack.policy.lifecycle;
    sample.pack.policy.lifecycle = {
      schemaVersion: 2,
      kinds: [{ archetypes: ["reference.dog@1", "reference.weather@1"], ...kind }],
    };
    sample.pack.archetypes.push("reference.dog@1");
    sample.initialState.entities.find(
      (entity: { objectId: string }) => entity.objectId === "b-resident",
    ).archetypeId = "reference.dog@1";
    const run = lifeChain(await lifeWorldFromSample(sample), "archetypes", 1000n);
    expect(
      conceptionDecisions(run.drafts).map((d) => [d.objectId, d.simulationTime, d.exclusion]),
    ).toEqual([
      ["a-resident", 1000n, "no-co-parent"],
      ["b-resident", 1000n, "no-co-parent"],
    ]);
    expect(eventsOf(run.events, "lifecycle.conceived")).toEqual([]);
  });

  it("conceives with an unrelated co-parent of the same archetype", async () => {
    const run = lifeChain(await lifeWorldFromSample(lifecycleSample(PAIR_SPEC)), "pair", 1000n);
    expect(eventsOf(run.events, "lifecycle.conceived")).not.toEqual([]);
  });
});
