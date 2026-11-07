import { ContractDecodeError } from "@clockgrove/contracts";
import { SPATIAL_MAX_TIME } from "@clockgrove/domain";
import type { GenesisClockPolicy } from "./world-birth.js";

/** Canonical timeline policy; physical simulation state advances independently. */
export interface TimelineClockPolicy {
  readonly schemaVersion: 1;
  readonly version: bigint;
  readonly running: boolean;
  readonly simulationAnchor: bigint;
  readonly wallAnchor: bigint;
  readonly simulationMillisecondsPerWallMillisecond: number;
  readonly catchUpCapMs: bigint;
}

export type ClockCommand =
  | Readonly<{ type: "PauseWorld" | "ResumeWorld"; schemaVersion: 1 }>
  | Readonly<{
      type: "SetClockPolicy";
      schemaVersion: 1;
      simulationMillisecondsPerWallMillisecond: number;
      catchUpCapMs: bigint;
    }>;

export function isClockCommand(type: string): boolean {
  return type === "PauseWorld" || type === "ResumeWorld" || type === "SetClockPolicy";
}

/** Decode the control payload after the transport's canonical-node decoding. */
export function decodeClockCommand(
  type: "SetClockPolicy",
  payload: unknown,
): Extract<ClockCommand, { type: "SetClockPolicy" }>;
export function decodeClockCommand(type: string, payload: unknown): ClockCommand;
export function decodeClockCommand(type: string, payload: unknown): ClockCommand {
  if (!isClockCommand(type)) throw new ContractDecodeError("type", "unknown clock command");
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ContractDecodeError("payload", "expected a clock control object");
  }
  if (!("schemaVersion" in payload) || payload.schemaVersion !== 1) {
    throw new ContractDecodeError("payload.schemaVersion", "expected version 1");
  }
  const keys =
    type === "SetClockPolicy"
      ? ["schemaVersion", "simulationMillisecondsPerWallMillisecond", "catchUpCapMs"]
      : ["schemaVersion"];
  if (Object.keys(payload).some((key) => !keys.includes(key))) {
    throw new ContractDecodeError("payload", "unknown clock control field");
  }
  if (type === "PauseWorld" || type === "ResumeWorld") return { type, schemaVersion: 1 };
  if (
    !("simulationMillisecondsPerWallMillisecond" in payload) ||
    typeof payload.simulationMillisecondsPerWallMillisecond !== "number" ||
    !Number.isInteger(payload.simulationMillisecondsPerWallMillisecond) ||
    payload.simulationMillisecondsPerWallMillisecond < 1 ||
    payload.simulationMillisecondsPerWallMillisecond > 1_000_000
  ) {
    throw new ContractDecodeError(
      "payload.simulationMillisecondsPerWallMillisecond",
      "expected integer from 1 through 1000000",
    );
  }
  if (
    !("catchUpCapMs" in payload) ||
    typeof payload.catchUpCapMs !== "bigint" ||
    payload.catchUpCapMs <= 0n ||
    payload.catchUpCapMs > SPATIAL_MAX_TIME
  ) {
    throw new ContractDecodeError(
      "payload.catchUpCapMs",
      "expected positive signed-64-bit simulation milliseconds",
    );
  }
  return {
    type: "SetClockPolicy",
    schemaVersion: 1,
    simulationMillisecondsPerWallMillisecond: payload.simulationMillisecondsPerWallMillisecond,
    catchUpCapMs: payload.catchUpCapMs,
  };
}

/** Stored policy decoding errors must be mapped to journal integrity failures by the store. */
export function decodeTimelineClockPolicy(value: unknown): TimelineClockPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractDecodeError("clockPolicy", "expected a timeline policy object");
  }
  const fields = [
    "schemaVersion",
    "version",
    "running",
    "simulationAnchor",
    "wallAnchor",
    "simulationMillisecondsPerWallMillisecond",
    "catchUpCapMs",
  ];
  if (
    Object.keys(value).some((key) => !fields.includes(key)) ||
    !("version" in value) ||
    typeof value.version !== "bigint" ||
    value.version < 0n ||
    !("running" in value) ||
    typeof value.running !== "boolean" ||
    !("simulationAnchor" in value) ||
    typeof value.simulationAnchor !== "bigint" ||
    value.simulationAnchor < 0n ||
    !("wallAnchor" in value) ||
    typeof value.wallAnchor !== "bigint" ||
    value.wallAnchor < 0n
  ) {
    throw new ContractDecodeError("clockPolicy", "invalid timeline policy fields");
  }
  const control = decodeClockCommand("SetClockPolicy", {
    schemaVersion: "schemaVersion" in value ? value.schemaVersion : undefined,
    simulationMillisecondsPerWallMillisecond:
      "simulationMillisecondsPerWallMillisecond" in value
        ? value.simulationMillisecondsPerWallMillisecond
        : undefined,
    catchUpCapMs: "catchUpCapMs" in value ? value.catchUpCapMs : undefined,
  });
  return {
    schemaVersion: 1,
    version: value.version,
    running: value.running,
    simulationAnchor: value.simulationAnchor,
    wallAnchor: value.wallAnchor,
    simulationMillisecondsPerWallMillisecond: control.simulationMillisecondsPerWallMillisecond,
    catchUpCapMs: control.catchUpCapMs,
  };
}

/** Decode the installed genesis policy rather than reconstructing pack configuration. */
export function decodeGenesisClockPolicy(value: unknown): GenesisClockPolicy {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "epoch",
          "wallEpoch",
          "simulationMillisecondsPerWallMillisecond",
          "decisionIntervalMs",
        ].includes(key),
    ) ||
    !("epoch" in value) ||
    typeof value.epoch !== "bigint" ||
    value.epoch < 0n ||
    !("wallEpoch" in value) ||
    typeof value.wallEpoch !== "string" ||
    !Number.isFinite(Date.parse(value.wallEpoch)) ||
    !("decisionIntervalMs" in value) ||
    typeof value.decisionIntervalMs !== "bigint" ||
    value.decisionIntervalMs <= 0n
  ) {
    throw new ContractDecodeError("genesisClockPolicy", "invalid installed clock policy");
  }
  const control = decodeClockCommand("SetClockPolicy", {
    schemaVersion: 1,
    simulationMillisecondsPerWallMillisecond:
      "simulationMillisecondsPerWallMillisecond" in value
        ? value.simulationMillisecondsPerWallMillisecond
        : undefined,
    catchUpCapMs: 86_400_000n,
  });
  return {
    epoch: value.epoch,
    wallEpoch: value.wallEpoch,
    decisionIntervalMs: value.decisionIntervalMs,
    simulationMillisecondsPerWallMillisecond: control.simulationMillisecondsPerWallMillisecond,
  };
}

export function createTimelineClockPolicy(
  genesis: GenesisClockPolicy,
  simulationTime: bigint,
  wallTime: bigint,
): TimelineClockPolicy {
  return {
    schemaVersion: 1,
    version: 0n,
    running: false,
    simulationAnchor: simulationTime,
    wallAnchor: wallTime,
    simulationMillisecondsPerWallMillisecond: genesis.simulationMillisecondsPerWallMillisecond,
    catchUpCapMs: 86_400_000n,
  };
}

/**
 * The earned target is uncapped so an activation budget never discards backlog. It stops at the
 * end of the simulation time range, which 1e6x speed reaches after about 292 years of wall time.
 */
export function clockEarnedSimulationTime(policy: TimelineClockPolicy, now: bigint): bigint {
  const elapsed = policy.running && now > policy.wallAnchor ? now - policy.wallAnchor : 0n;
  const earned =
    policy.simulationAnchor + elapsed * BigInt(policy.simulationMillisecondsPerWallMillisecond);
  return earned < SPATIAL_MAX_TIME ? earned : SPATIAL_MAX_TIME;
}

export function transitionTimelineClockPolicy(
  policy: TimelineClockPolicy,
  command: ClockCommand,
  simulationTime: bigint,
  wallTime: bigint,
): TimelineClockPolicy {
  const earned = clockEarnedSimulationTime(policy, wallTime);
  return {
    ...policy,
    version: policy.version + 1n,
    running:
      command.type === "ResumeWorld" || (command.type === "SetClockPolicy" && policy.running),
    simulationAnchor: simulationTime > earned ? simulationTime : earned,
    wallAnchor: wallTime > policy.wallAnchor ? wallTime : policy.wallAnchor,
    ...(command.type === "SetClockPolicy"
      ? {
          simulationMillisecondsPerWallMillisecond:
            command.simulationMillisecondsPerWallMillisecond,
          catchUpCapMs: command.catchUpCapMs,
        }
      : {}),
  };
}

/**
 * The activation's admitted high-water horizon. A paused policy admits nothing new.
 * Callers persist this accounting independently of physical simulation state and revision.
 */
export function clockTarget(
  policy: TimelineClockPolicy,
  admittedHorizon: bigint,
  now: bigint,
): bigint {
  if (!policy.running) return admittedHorizon;
  const earned = clockEarnedSimulationTime(policy, now);
  if (earned <= admittedHorizon) return admittedHorizon;
  const capped = admittedHorizon + policy.catchUpCapMs;
  return earned < capped ? earned : capped;
}
