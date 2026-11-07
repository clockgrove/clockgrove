import { describe, expect, it } from "vitest";
import { initializeNamedRandomStreams } from "../src/index.js";
import {
  goldenInitialBytes,
  goldenInitialHash,
  installationSeed,
  randomRuntimeEvidence,
  streamNames,
} from "./random-streams.scenario.js";

describe("versioned production named random streams", () => {
  it("matches fixed upstream goldens, canonical bytes/hash, continuation and rejection controls", async () => {
    const evidence = await randomRuntimeEvidence();
    expect(evidence.initialBytes).toBe(goldenInitialBytes);
    expect(evidence.hash).toBe(goldenInitialHash);
    expect(evidence.independence).toHaveLength(2);
    expect(evidence.rejections.state.every(Boolean)).toBe(true);
    expect(evidence.rejections.encoding.every(Boolean)).toBe(true);
  });

  it("derives each name independently of the selected set", () => {
    const all = initializeNamedRandomStreams(installationSeed, streamNames);
    expect(initializeNamedRandomStreams(installationSeed, ["weather"]).weather).toEqual(
      all.weather,
    );
  });
});
