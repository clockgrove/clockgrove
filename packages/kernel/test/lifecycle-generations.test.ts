// Population over generations (#358): the 128 bound counts what a birth cannot free, not every
// life so far, and the dead stay explainable from the lineage.
import { replayWorldEvents, resolveLifecycleLinks } from "@clockgrove/domain";
import { describe, expect, it } from "vitest";
import { canonicalBytes } from "../src/index.js";
import {
  eventsOf,
  lifeChain,
  lifeWorld,
  payloadOf,
  SURE_SPEC,
  timeOf,
} from "./lifecycle.scenario.js";

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
});
