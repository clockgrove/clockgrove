import { encodeResource } from "@clockgrove/world-pack-sdk";

export type Status = "ok" | "failed" | "usage" | "unreadable";

export const EXIT_CODES: Readonly<Record<Status, number>> = {
  ok: 0,
  failed: 1,
  usage: 2,
  unreadable: 3,
};

/** An internal defect: a stderr diagnostic only, never an envelope. */
export const INTERNAL_DEFECT_EXIT_CODE = 70;

export const CLI_RESULT_KIND = "clockgrove.cli-result";

export interface Refusal {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** What a command decided: its evidence (or null) and, when it did not succeed, why. */
export interface Outcome {
  readonly status: Status;
  readonly result: unknown;
  readonly refusal: Refusal | null;
  readonly observed?: HostRuntime;
}

export interface Observations {
  readonly runtime: string;
  readonly durationMs: number;
  readonly peakMemoryBytes: number | null;
  readonly peakMemoryNullReason: string | null;
}

/** The runtime a command ran in, when it is not the host process; `durationMs` is always the host's. */
export type HostRuntime = Pick<
  Observations,
  "runtime" | "peakMemoryBytes" | "peakMemoryNullReason"
>;

export function succeed(result: unknown): Outcome {
  return { status: "ok", result, refusal: null };
}

/** The inputs were read but the outcome is negative; the refusal keeps its code and path unchanged. */
export function failed(refusal: Refusal | null, result: unknown = null): Outcome {
  return {
    status: "failed",
    result,
    refusal:
      refusal === null
        ? null
        : { code: refusal.code, path: refusal.path, message: refusal.message },
  };
}

export function usage(code: string, path: string, message: string): Outcome {
  return { status: "usage", result: null, refusal: { code, path, message } };
}

export function unreadable(code: string, path: string, message: string): Outcome {
  return { status: "unreadable", result: null, refusal: { code, path, message } };
}

/** The one stdout document: SDK `encodeResource` encoding followed by a newline. */
export function encodeEnvelope(
  command: string,
  outcome: Outcome,
  observations: Observations,
): Uint8Array {
  const document = encodeResource({
    kind: CLI_RESULT_KIND,
    version: 1,
    command,
    status: outcome.status,
    exitCode: EXIT_CODES[outcome.status],
    result: outcome.result,
    refusal: outcome.refusal,
    observations,
  });
  const bytes = new Uint8Array(document.length + 1);
  bytes.set(document);
  bytes[document.length] = 0x0a;
  return bytes;
}
