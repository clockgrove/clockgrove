import { join } from "node:path";
import { buildWorldPack } from "@clockgrove/world-pack-sdk";
import { describe, expect, it } from "vitest";
import { createSimulatorPackPorts } from "../../src/index.js";
import { DigestStream, STREAM_BATCH } from "../../src/scenario/summary.js";
import { loadPack, WORLDS_ROOT } from "../conformance/pack-source.js";
import {
  advance,
  MATERIAL_TYPES,
  ports,
  rain,
  runOk,
  SECTION_EPOCH,
  scenario,
  yard,
} from "./harness.js";

// No committed golden records `summarised`; the qualification long runs do. This file keeps the
// property that a summarised recording keeps every outcome of the full one and digests its streams.

type Rec = Record<string, any>;

function yardDocument(recording: "full" | "summarised"): Rec {
  return scenario({
    recording,
    steps: [advance("span", SECTION_EPOCH + 600_000n, "live", 60_000n)],
    variants: [
      { name: "aggregate", steps: [advance("span", SECTION_EPOCH + 600_000n, "fast-forward")] },
      {
        name: "rainy",
        steps: [rain("wet", 9000), advance("span", SECTION_EPOCH + 600_000n, "fast-forward")],
      },
    ],
    equivalences: [
      {
        id: "small-vs-aggregate",
        left: "main",
        right: "aggregate",
        fields: ["events", "eventCounts"],
        eventTypes: MATERIAL_TYPES,
      },
      {
        id: "dry-vs-rainy",
        left: "aggregate",
        right: "rainy",
        fields: ["events", "decisions", "rules", "finalState"],
      },
    ],
    assertions: [
      {
        kind: "eventCount",
        id: "routines",
        run: "main",
        eventType: "routine.selected",
        operator: "gte",
        value: 0,
      },
      {
        kind: "equivalence",
        id: "progression-agrees",
        equivalence: "small-vs-aggregate",
        expect: true,
      },
    ],
  });
}

async function chainDigest(records: readonly unknown[]): Promise<Rec> {
  const stream = new DigestStream(async (bytes) => ports.sha256(bytes));
  for (const record of records) stream.push(record);
  return stream.finish();
}

describe("summarised recording", () => {
  it("keeps the outcomes of a full recording with streams replaced by counts and digests", async () => {
    const { source, artifact } = await yard({ rules: true });
    const full = (await runOk({ artifact, source, scenario: yardDocument("full") })).bundle;
    const summarised = (await runOk({ artifact, source, scenario: yardDocument("summarised") }))
      .bundle;
    expect(summarised.equivalences).toEqual(full.equivalences);
    expect(summarised.assertions).toEqual(full.assertions);
    expect(summarised.replayVerified).toBe(true);
    for (const [index, fullRecorded] of full.runs.entries()) {
      const fullRun: Rec = { ...fullRecorded };
      const run: Rec = { ...summarised.runs[index] };
      for (const field of [
        "randomState",
        "commands",
        "schedule",
        "eventCounts",
        "finalState",
        "finalStateHash",
        "replay",
      ])
        expect(run[field], field).toEqual(fullRun[field]);
      for (const field of [
        "events",
        "decisions",
        "scheduledInputs",
        "scheduleMutations",
        "perception",
      ])
        expect(run[field], field).toEqual(await chainDigest(fullRun[field]));
      for (const field of ["evaluations", "intents", "trace"])
        expect(run.rules[field], field).toEqual(await chainDigest(fullRun.rules[field]));
    }
  });

  it("stays bounded while the event volume grows several times", async () => {
    const { source } = await loadPack(join(WORLDS_ROOT, "fixture"));
    const built = await buildWorldPack(source, createSimulatorPackPorts(ports));
    if (!built.ok) throw new Error(`fixture build failed: ${JSON.stringify(built.error)}`);
    const pack = { id: source.manifest.id, version: source.manifest.version };
    const record = async (hours: bigint, recording: string) => {
      const steps = [advance("span", 100_000n + hours * 3_600_000n, "fast-forward")];
      const document = scenario({ pack, recording, steps });
      const { bundle, bytes } = await runOk({
        artifact: built.value.artifact,
        source,
        scenario: document,
      });
      return { size: bytes.length, events: (bundle.runs[0] as Rec).replay.eventCount as number };
    };
    const full = await record(2n, "full");
    const [short, long] = [await record(2n, "summarised"), await record(72n, "summarised")];
    // Over 4x the events, yet the summarised bundle grows by less than one event of a full recording.
    expect(long.events).toBeGreaterThanOrEqual(short.events * 4);
    expect(long.size - short.size).toBeLessThan(full.size / full.events);
  });

  it("digests a record list the same way however it is pushed and drained", async () => {
    const records = Array.from({ length: STREAM_BATCH * 2 + 7 }, (_, index) => ({ index }));
    const stream = new DigestStream(async (bytes) => ports.sha256(bytes));
    for (const [index, record] of records.entries()) {
      stream.push(record);
      if (index % 333 === 0) await stream.drain();
    }
    expect(await stream.finish()).toEqual(await chainDigest(records));
  });
});
