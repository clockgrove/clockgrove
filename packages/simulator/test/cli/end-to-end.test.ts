import { describe, expect, it } from "vitest";
import { readEnvelope, runExecutable, spawnExecutable, stableBytes } from "./helpers.js";

// Every other CLI test runs `runCli` in process; this one proves the bin entry is the same program.
describe("the bin entry", () => {
  it("runs as its own Node process with the same exit codes and result documents as in process", async () => {
    for (const [args, exitCode] of [
      [["pack", "validate", "--pack", "worlds/fixture"], 0],
      [["pack", "validate", "worlds/fixture"], 2],
    ] as const) {
      const spawned = await spawnExecutable(args);
      expect(spawned.exitCode).toBe(exitCode);
      const envelope = readEnvelope(spawned.stdout);
      expect(envelope.exitCode).toBe(exitCode);
      expect(envelope.observations.runtime).toBe(`node/${process.version}`);
      expect(envelope.observations.peakMemoryBytes).toBeGreaterThan(0);
      const inProcess = readEnvelope((await runExecutable(args)).stdout);
      expect(Buffer.from(stableBytes(envelope))).toEqual(Buffer.from(stableBytes(inProcess)));
    }
  });
});
