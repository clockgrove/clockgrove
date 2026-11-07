import { SPATIAL_MAX_TIME } from "@clockgrove/domain";
import { describe, expect, it } from "vitest";
import {
  clockEarnedSimulationTime,
  clockTarget,
  createTimelineClockPolicy,
  decodeClockCommand,
  decodeGenesisClockPolicy,
  transitionTimelineClockPolicy,
} from "../src/index.js";

const genesis = {
  epoch: 100n,
  wallEpoch: "1970-01-01T00:00:00.000Z",
  simulationMillisecondsPerWallMillisecond: 60,
  decisionIntervalMs: 100n,
};
const initial = createTimelineClockPolicy(genesis, 100n, 1_000_000n);
const resume = decodeClockCommand("ResumeWorld", { schemaVersion: 1 });
const pause = decodeClockCommand("PauseWorld", { schemaVersion: 1 });

describe("committed timeline clock policy", () => {
  it("installs paused with the genesis speed and one-day simulation cap", () => {
    expect(decodeGenesisClockPolicy(genesis)).toEqual(genesis);
    expect(initial).toEqual({
      schemaVersion: 1,
      version: 0n,
      running: false,
      simulationAnchor: 100n,
      wallAnchor: 1_000_000n,
      simulationMillisecondsPerWallMillisecond: 60,
      catchUpCapMs: 86_400_000n,
    });
    expect(clockTarget(initial, 100n, 9_000_000n)).toBe(100n);
    const running = transitionTimelineClockPolicy(initial, resume, 123n, 9_000_000n);
    expect(running).toEqual({
      ...initial,
      version: 1n,
      running: true,
      simulationAnchor: 123n,
      wallAnchor: 9_000_000n,
    });
    expect(clockTarget(running, 123n, 9_000_001n)).toBe(183n);
  });

  it("preserves earned backlog through pause, speed changes and resume without earning paused time", () => {
    const running = transitionTimelineClockPolicy(initial, resume, 100n, 1_000_000n);
    const paused = transitionTimelineClockPolicy(running, pause, 150n, 1_000_010n);
    expect(paused).toEqual({
      ...initial,
      version: 2n,
      simulationAnchor: 700n,
      wallAnchor: 1_000_010n,
    });
    expect(clockTarget(paused, 150n, 2_000_000n)).toBe(150n);
    expect(clockEarnedSimulationTime(paused, 2_000_000n)).toBe(700n);
    const changed = transitionTimelineClockPolicy(
      paused,
      decodeClockCommand("SetClockPolicy", {
        schemaVersion: 1,
        simulationMillisecondsPerWallMillisecond: 2,
        catchUpCapMs: 100n,
      }),
      150n,
      2_000_000n,
    );
    expect(changed).toEqual({
      ...paused,
      version: 3n,
      wallAnchor: 2_000_000n,
      simulationMillisecondsPerWallMillisecond: 2,
      catchUpCapMs: 100n,
    });
    const resumed = transitionTimelineClockPolicy(changed, resume, 150n, 3_000_000n);
    expect(resumed).toEqual({ ...changed, version: 4n, running: true, wallAnchor: 3_000_000n });
    expect(clockEarnedSimulationTime(resumed, 3_000_010n)).toBe(720n);
    expect(clockTarget(resumed, 150n, 3_000_010n)).toBe(250n);
    expect(clockTarget(resumed, 650n, 3_000_010n)).toBe(720n);
    expect(clockTarget(resumed, 720n, 3_000_010n)).toBe(720n);
  });

  it("changes running speed continuously and clamps backwards server time", () => {
    const running = transitionTimelineClockPolicy(initial, resume, 100n, 1_000_000n);
    const changed = transitionTimelineClockPolicy(
      running,
      decodeClockCommand("SetClockPolicy", {
        schemaVersion: 1,
        simulationMillisecondsPerWallMillisecond: 3,
        catchUpCapMs: 1_000n,
      }),
      110n,
      1_000_010n,
    );
    expect(changed).toEqual({
      ...running,
      version: 2n,
      simulationAnchor: 700n,
      wallAnchor: 1_000_010n,
      simulationMillisecondsPerWallMillisecond: 3,
      catchUpCapMs: 1_000n,
    });
    expect(clockTarget(changed, 110n, 1_000_010n)).toBe(700n);
    expect(clockTarget(changed, 110n, 1_000_020n)).toBe(730n);
    expect(clockTarget(changed, 110n, 1_000_000n)).toBe(700n);
    expect(clockTarget(changed, 800n, 1_000_020n)).toBe(800n);
    const backwards = transitionTimelineClockPolicy(changed, resume, 110n, 1_000_000n);
    expect(backwards).toEqual({ ...changed, version: 3n });
    expect(clockTarget(backwards, 110n, 1_000_010n)).toBe(700n);
    expect(transitionTimelineClockPolicy(changed, resume, 800n, 1_000_020n)).toEqual({
      ...changed,
      version: 3n,
      simulationAnchor: 800n,
      wallAnchor: 1_000_020n,
    });
  });

  it("stops earned time at the end of the simulation time range", () => {
    const fastest = transitionTimelineClockPolicy(
      transitionTimelineClockPolicy(
        initial,
        decodeClockCommand("SetClockPolicy", {
          schemaVersion: 1,
          simulationMillisecondsPerWallMillisecond: 1_000_000,
          catchUpCapMs: SPATIAL_MAX_TIME,
        }),
        100n,
        1_000_000n,
      ),
      resume,
      100n,
      1_000_000n,
    );
    const end = 1_000_000n + SPATIAL_MAX_TIME / 1_000_000n + 1n;
    expect(clockEarnedSimulationTime(fastest, end)).toBe(SPATIAL_MAX_TIME);
    expect(clockTarget(fastest, 100n, end)).toBe(SPATIAL_MAX_TIME);
  });
});
