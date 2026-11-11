import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_SCENARIO, writeFixturePack } from "../conformance/fixture-pack.js";
import { invoke, temporaryDirectory } from "./helpers.js";

const WEATHER_JSON = '{"type":"world.weather.set","version":2,"payload":{"rainIntensity":0}}';

let scratch: Awaited<ReturnType<typeof temporaryDirectory>>;
let seeded: string;
let advanced: string;
beforeAll(async () => {
  scratch = await temporaryDirectory();
  seeded = join(scratch.path, "seeded.state");
  advanced = join(scratch.path, "advanced.state");
  expect(
    (await invoke(["simulate", "seed", "--pack", "worlds/fixture", "--out", seeded])).run.exitCode,
  ).toBe(0);
  await copyFile(seeded, advanced);
  expect(
    (await invoke(["simulate", "command", "--state", advanced, "--command", WEATHER_JSON])).run
      .exitCode,
  ).toBe(0);
});
afterAll(() => scratch.dispose());

describe("simulate diff", () => {
  it("exits 0 with an empty difference for byte-identical canonical files", async () => {
    const copy = join(scratch.path, "seeded-copy.state");
    await copyFile(seeded, copy);
    const { run, envelope } = await invoke(["simulate", "diff", seeded, copy]);
    expect(run.exitCode).toBe(0);
    expect(envelope).toMatchObject({
      status: "ok",
      refusal: null,
      result: { identical: true, fields: [], paths: [] },
    });
  });

  it("exits 1 with the sorted differing fields and the first paths of two state bundles", async () => {
    const { run, envelope } = await invoke(["simulate", "diff", seeded, advanced]);
    expect(run.exitCode).toBe(1);
    expect(envelope.status).toBe("failed");
    expect(envelope.refusal).toBeNull();
    expect(envelope.result).toEqual({
      identical: false,
      fields: ["bundleHash", "finalStateHash", "run", "steps"],
      paths: [
        "document.bundleHash",
        "document.finalStateHash",
        "document.run.commands.length (0 != 1)",
        "document.run.eventCounts.needs.changed",
        "document.run.eventCounts.weather.changed",
        "document.run.eventCounts.wellbeing.integrated",
        "document.run.events.length (0 != 3)",
        "document.run.finalState.entities[3].needs.hunger",
      ],
    });
  });

  it("exits 1 for a golden and a different scenario bundle", async () => {
    const root = join(scratch.path, "packs");
    await writeFixturePack(root, "alpha", { golden: "match" });
    await writeFixturePack(root, "beta", { golden: "mismatch" });
    const golden = (pack: string) => join(root, pack, "goldens", `${FIXTURE_SCENARIO}.json`);
    const { run, envelope } = await invoke(["simulate", "diff", golden("alpha"), golden("beta")]);
    expect(run.exitCode).toBe(1);
    expect(envelope.result).toEqual({
      identical: false,
      fields: ["assertions", "bundleHash", "runs", "scenario"],
      paths: [
        "document.assertions[0].observed",
        "document.bundleHash",
        "document.runs[0].commands.length (4 != 2)",
        "document.runs[0].decisions.length (10 != 6)",
        "document.runs[0].eventCounts.growth.integrated",
        "document.runs[0].eventCounts.movement.completed",
        "document.runs[0].eventCounts.movement.region-exited",
        "document.runs[0].eventCounts.needs.changed",
      ],
    });
  });

  it("exits 3 naming the argument that is missing or not canonical bytes", async () => {
    const missing = await invoke(["simulate", "diff", join(scratch.path, "absent"), seeded]);
    expect(missing.run.exitCode).toBe(3);
    expect(missing.envelope.status).toBe("unreadable");
    expect(missing.envelope.refusal).toMatchObject({ code: "INPUT_UNREADABLE", path: "<a>" });

    const plain = join(scratch.path, "plain.json");
    await writeFile(plain, '{"a":1}\n');
    const notCanonical = await invoke(["simulate", "diff", seeded, plain]);
    expect(notCanonical.run.exitCode).toBe(3);
    expect(notCanonical.envelope.refusal).toMatchObject({
      code: "NOT_CANONICAL_BYTES",
      path: "<b>",
    });
  });
});
