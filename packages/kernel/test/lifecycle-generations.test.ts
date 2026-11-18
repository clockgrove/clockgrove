// Population over generations (#358): the 128 bound counts what a birth cannot free, not every
// life so far, and the dead stay explainable from the lineage.
import { replayWorldEvents, resolveLifecycleLinks } from "@clockgrove/domain";
import { describe, expect, it } from "vitest";
import { canonicalBytes } from "../src/index.js";
import { executeWorldKernel } from "../src/world.js";
import {
  eventsOf,
  lifeChain,
  lifeWorld,
  payloadOf,
  SURE_SPEC,
  timeOf,
} from "./lifecycle.scenario.js";
import { movementInput } from "./spatial.scenario.js";

describe("population over generations", () => {
  it("keeps reproducing past 128 cumulative births with the living under the cap", async () => {
    const start = await lifeWorld(SURE_SPEC);
    const run = lifeChain(start, "generations", 600_000n, 1024, 4096);
    const births = eventsOf(run.events, "lifecycle.born");
    const deaths = eventsOf(run.events, "lifecycle.died");
    const state = run.world.state;
    const lifecycle = state.lifecycle!;

    // Before #358 the 128th life (founder plus 127 births) stopped every later conception.
    // The run is deterministic: a change in who reproduces or how many dead move fails these.
    expect([births.length, deaths.length]).toEqual([238, 233]);
    const last = births.at(-1)!;
    expect(timeOf(last)).toBe(599_000n);
    const living = lifecycle.entries.filter((entry) => entry.death === null);
    expect(living.length).toBe(6);
    expect([state.entities.length, lifecycle.entries.length]).toEqual([116, 116]);

    // Every death is a life in `entries` or the lineage; nobody counted twice or lost.
    const lineage = lifecycle.lineage ?? [];
    expect(lineage.length).toBe(123);
    expect(lifecycle.entries.length + lineage.length).toBe(births.length + 1);
    expect(timeOf(deaths.at(-1)!)).toBe(596_000n);
    expect(lineage.every((dead) => dead.death.diedAt <= 596_000n)).toBe(true);
    expect(lineage[0]).toMatchObject({
      objectId: "a-resident",
      archetypeId: "reference.weather@1",
      gestation: null,
    });

    // Family links of the latest child resolve through its dead ancestors in the lineage.
    const child = payloadOf(last).childId as string;
    expect(child).toBe("child_f5a4e6a83ccc9cc1");
    const links = resolveLifecycleLinks(state, child as never)!;
    expect(links.entity?.objectId).toBe(child);
    const parent = links.parents[0]!;
    expect(parent.objectId).toBe(payloadOf(last).gestatingParentId);
    let ancestor = parent;
    let depth = 0;
    while (ancestor.parentIds.length > 0 && depth < 1000) {
      const up = resolveLifecycleLinks(state, ancestor.objectId as never);
      if (up === undefined) break;
      ancestor = up.parents[0]!;
      depth += 1;
    }
    expect(depth).toBe(84);
    const deadLinks = resolveLifecycleLinks(state, lineage[0]!.objectId);
    expect(deadLinks?.entity).toBeUndefined();
    expect(deadLinks?.entry.death).not.toBeNull();

    // Replay of the journaled events from the saved initial state reproduces the final state.
    const replayed = replayWorldEvents(start.state, run.events as never);
    expect(Buffer.from(canonicalBytes(replayed)).toString("hex")).toBe(
      Buffer.from(canonicalBytes(state)).toString("hex"),
    );
  }, 300_000);

  it("commits a movement whose passed time crosses the birth that moves the dead to the lineage", async () => {
    const start = await lifeWorld(SURE_SPEC);
    // The founder plus 127 births fill the 128-entry record; the 128th birth moves the dead out.
    const filled = lifeChain(start, "generations-fill", 330_000n, 1024, 4096);
    const births = eventsOf(filled.events, "lifecycle.born");
    const crossing = timeOf(births[127]!);
    expect(crossing).toBe(324_000n);
    const before = lifeChain(start, "generations-before", crossing - 1n, 1024, 4096).world;
    expect(before.state.lifecycle!.entries.length).toBe(128);
    expect(before.state.lifecycle!.lineage).toBeUndefined();

    const mover = before.state.lifecycle!.entries.find(
      (entry) => entry.death === null && entry.gestation === null,
    )!.objectId;
    const pose = before.state.entities.find((entity) => entity.objectId === mover)!.pose;
    const command = (world: typeof before, type: string, payload: object, id: string) =>
      executeWorldKernel(
        movementInput(
          {
            ...world.template,
            partition: {
              ...world.template.partition,
              revision: world.state.revision,
              state: world.state,
            },
            simulationTime: world.state.simulationTime,
            schedules: world.schedules,
            randomState: world.random,
          },
          type,
          payload,
          id,
        ) as never,
        { mode: "test" },
      );
    const started = command(
      before,
      "movement.start",
      {
        schemaVersion: 1,
        objectId: mover,
        destination: { kind: "pose", pose: { ...pose, coordinates: [500n, 0n] } },
        unitsPerSecond: 1n,
        observeUntil: before.state.simulationTime,
      },
      "generations-start",
    );
    if (!started.ok)
      throw new Error(`${started.error.code} ${started.error.path} ${started.error.check}`);
    const moving = {
      ...before,
      state: started.result.state,
      schedules: started.result.schedules,
      random: started.result.updatedRandomState,
    };
    // The interrupt passes world time up to the birth that finds the record full.
    const outcome = command(
      moving,
      "movement.interrupt",
      { schemaVersion: 1, objectId: mover, at: crossing },
      "generations-interrupt",
    );
    // Before movement.scope@5 this was invariant-violated at state.entities: no entity removed.
    expect(outcome.ok ? undefined : outcome.error).toBeUndefined();
    if (!outcome.ok) return;
    const { events, state } = outcome.result;
    expect(eventsOf(events, "movement.interrupted").map(timeOf)).toEqual([crossing]);
    const born = eventsOf(events, "lifecycle.born");
    expect(born.map(timeOf)).toEqual([crossing]);
    const lineage = state.lifecycle!.lineage ?? [];
    expect([lineage.length, state.lifecycle!.entries.length]).toEqual([123, 6]);
    for (const dead of lineage) {
      expect(before.state.entities.some((entity) => entity.objectId === dead.objectId)).toBe(true);
      expect(state.entities.some((entity) => entity.objectId === dead.objectId)).toBe(false);
    }
    expect(lineage[0]).toMatchObject({ objectId: "a-resident" });
  }, 300_000);
});
