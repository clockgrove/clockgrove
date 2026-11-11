import {
  type CommandId,
  decodeOpaqueId,
  type PrincipalId,
  type SimTimeMs,
} from "@clockgrove/contracts";
import {
  CONTAINMENT_PAYLOAD_SCHEMAS,
  type ContainmentPayload,
} from "./commands/containment-commands.js";
import { EnvironmentValidationError } from "./environment/environment.js";
import type { WorldBehaviorPolicy, WorldState } from "./world.js";

/** A declared off-screen principal performs an ordinary inventory command on a fixed cadence. */
export interface WorldProcess {
  readonly id: string;
  readonly principalId: PrincipalId;
  readonly firstAtMs: bigint;
  readonly periodMs: bigint;
  readonly command: Readonly<{
    type: "resource.transfer";
    payload: ContainmentPayload<"resource.transfer">;
  }>;
}
export interface WorldProcessState {
  readonly processId: string;
  /** Null only when the next occurrence would exceed the simulation-time range. */
  readonly nextAt: SimTimeMs | null;
}
export interface ProcessCommandEventData {
  readonly type: "process.command-attempted";
  readonly payload: Readonly<{
    processId: string;
    commandId: CommandId;
    nextAt: SimTimeMs | null;
    refusal: Readonly<{ code: string; path: string; check?: string }> | null;
  }>;
}
// Existing simulation-time range and ecology duration range; processes share these bounds.
const MAX_TIME = (1n << 63n) - 1n;
const MAX_DURATION = 1n << 53n;
function bad(path: string): never {
  throw new EnvironmentValidationError(path, "invalid declared process");
}
function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad(path);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)))
    bad(path);
  return raw;
}
// Decision: use the existing command object-id text bound for process ids.
function name(value: unknown, path: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  )
    bad(path);
}
// Decision: at most 64 processes, matching each ecology policy list, bounds per-instant work.
export function validateWorldProcesses(value: unknown): asserts value is readonly WorldProcess[] {
  if (!Array.isArray(value) || value.length > 64) bad("policy.processes");
  const ids = new Set<string>();
  value.forEach((candidate, i) => {
    const path = `policy.processes[${i}]`;
    const raw = record(candidate, ["id", "principalId", "firstAtMs", "periodMs", "command"], path);
    name(raw.id, `${path}.id`);
    if (ids.has(raw.id as string)) bad(`${path}.id`);
    ids.add(raw.id as string);
    try {
      decodeOpaqueId(raw.principalId, "PrincipalId");
    } catch {
      bad(`${path}.principalId`);
    }
    for (const key of ["firstAtMs", "periodMs"] as const)
      if (typeof raw[key] !== "bigint" || raw[key] <= 0n || raw[key] > MAX_DURATION)
        bad(`${path}.${key}`);
    const command = record(raw.command, ["type", "payload"], `${path}.command`);
    if (command.type !== "resource.transfer") bad(`${path}.command.type`);
    if (!CONTAINMENT_PAYLOAD_SCHEMAS["resource.transfer"].safeParse(command.payload).success)
      bad(`${path}.command.payload`);
  });
}
export function validateWorldProcessState(
  value: unknown,
): asserts value is readonly WorldProcessState[] {
  if (!Array.isArray(value) || value.length > 64) bad("state.processes");
  const ids = new Set<string>();
  value.forEach((candidate, i) => {
    const path = `state.processes[${i}]`;
    const raw = record(candidate, ["processId", "nextAt"], path);
    name(raw.processId, `${path}.processId`);
    if (ids.has(raw.processId as string)) bad(`${path}.processId`);
    ids.add(raw.processId as string);
    if (
      raw.nextAt !== null &&
      (typeof raw.nextAt !== "bigint" || raw.nextAt < 0n || raw.nextAt > MAX_TIME)
    )
      bad(`${path}.nextAt`);
  });
}
export function nextProcessTime(process: WorldProcess, after: bigint): SimTimeMs | null {
  const time = after + process.periodMs;
  return time > MAX_TIME ? null : (time as SimTimeMs);
}
/** No occurrences precede world birth, including worlds whose clock epoch is nonzero. */
export function initialWorldProcesses(
  processes: readonly WorldProcess[],
  epoch: SimTimeMs,
): readonly WorldProcessState[] {
  return processes.map((process) => {
    const elapsed = epoch - process.firstAtMs;
    const next =
      elapsed <= 0n
        ? process.firstAtMs
        : process.firstAtMs +
          ((elapsed + process.periodMs - 1n) / process.periodMs) * process.periodMs;
    return { processId: process.id, nextAt: next > MAX_TIME ? null : (next as SimTimeMs) };
  });
}
export function worldProcessDisagreement(
  policy: WorldBehaviorPolicy,
  state: WorldState,
): string | undefined {
  if (policy.processes === undefined)
    return state.processes === undefined ? undefined : "state.processes";
  if (state.processes?.length !== policy.processes.length) return "state.processes";
  for (const [i, process] of policy.processes.entries()) {
    const entry = state.processes[i]!;
    if (entry.processId !== process.id) return `state.processes[${i}].processId`;
    const time = entry.nextAt;
    if (
      time !== null &&
      (time < state.simulationTime ||
        time < process.firstAtMs ||
        (time - process.firstAtMs) % process.periodMs !== 0n)
    )
      return `state.processes[${i}].nextAt`;
    if (time === null && state.simulationTime <= MAX_TIME - process.periodMs)
      return `state.processes[${i}].nextAt`;
  }
  return undefined;
}
