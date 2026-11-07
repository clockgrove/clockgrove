import type { OpaqueId } from "@clockgrove/contracts";

export type RandomStreamName = OpaqueId<"RandomStreamName">;

export interface RandomAlgorithmVersion {
  readonly algorithm: string;
  readonly version: number;
}

export interface NamedRandomStreamState {
  readonly name: RandomStreamName;
  readonly algorithm: RandomAlgorithmVersion;
  readonly state: readonly bigint[];
  readonly draws: bigint;
}

export type NamedRandomState = Readonly<Record<string, NamedRandomStreamState>>;

export interface RandomDrawMetadata {
  readonly stream: RandomStreamName;
  readonly algorithm: string;
  readonly algorithmVersion: number;
  readonly drawIndex: bigint;
  readonly rawValue: bigint;
}

export function validateNamedRandomState(randomState: NamedRandomState): void {
  for (const [key, stream] of Object.entries(randomState)) {
    if (key.length === 0 || stream.name !== key) {
      throw new TypeError("random stream keys must be non-empty and match the branded stream name");
    }
    if (
      stream.algorithm.algorithm.length === 0 ||
      !Number.isSafeInteger(stream.algorithm.version)
    ) {
      throw new TypeError("random stream algorithm and integer version are required");
    }
    if (stream.algorithm.version < 1 || stream.state.length === 0 || stream.draws < 0n) {
      throw new TypeError("random stream version/state/draw count is invalid");
    }
  }
}
