import type { NamedRandomState, RandomDrawMetadata, RandomStreamName } from "@clockgrove/domain";
import { xoroshiro128plus, xoroshiro128plusFromState } from "pure-rand/generator/xoroshiro128plus";
import { CANONICAL_ENCODING_VERSION, canonicalSerialize } from "./canonical.js";

export const RANDOM_CONTRACT_VERSION = "clockgrove-random-v1";
export const RANDOM_ALGORITHM = "pure-rand@8.4.2/xoroshiro128plus";
export interface InstallationRandomSeed {
  readonly version: 1;
  readonly seed: string;
}

/** Installation only: never call this to resume a persisted timeline. */
export function initializeNamedRandomStreams(
  seed: InstallationRandomSeed,
  names: readonly string[],
): NamedRandomState {
  if (
    canonicalSerialize(seed) !== canonicalSerialize({ version: 1, seed: seed.seed }) ||
    typeof seed.seed !== "string" ||
    seed.seed.length === 0
  )
    throw new TypeError("explicit version 1 installation seed required");
  canonicalSerialize(names);
  if (
    new Set(names).size !== names.length ||
    names.some((name) => typeof name !== "string" || name.length === 0)
  )
    throw new TypeError("distinct non-empty stream names required");
  return freezeState(
    Object.fromEntries(
      [...names].sort().map((name) => {
        // FNV-1a over the canonical UTF-8 tuple, wrapping after each multiply.
        let hash = 2166136261;
        for (const byte of new TextEncoder().encode(
          canonicalSerialize([RANDOM_CONTRACT_VERSION, seed.seed, name]),
        ))
          hash = Math.imul(hash ^ byte, 16777619) >>> 0;
        return [
          name,
          {
            name: name as RandomStreamName,
            algorithm: { algorithm: RANDOM_ALGORITHM, version: 1 },
            state: xoroshiro128plus(hash).getState().map(BigInt),
            draws: 0n,
          },
        ];
      }),
    ),
  );
}

function validate(state: NamedRandomState): void {
  // Reject accessors, symbols, exotic prototypes, sparse arrays and hidden fields first.
  canonicalSerialize(state);
  if (
    state === null ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(state))
  )
    throw new TypeError("random state must be a plain record");
  for (const [name, stream] of Object.entries(state)) {
    if (
      name.length === 0 ||
      stream.name !== name ||
      canonicalSerialize(Object.keys(stream).sort()) !==
        canonicalSerialize(["algorithm", "draws", "name", "state"]) ||
      canonicalSerialize(stream.algorithm) !==
        canonicalSerialize({ algorithm: RANDOM_ALGORITHM, version: 1 }) ||
      typeof stream.draws !== "bigint" ||
      stream.draws < 0n ||
      stream.state.length !== 4 ||
      stream.state.some(
        (word) => typeof word !== "bigint" || word < -2147483648n || word > 2147483647n,
      ) ||
      stream.state.every((word) => word === 0n)
    )
      throw new TypeError("invalid or unsupported named random state");
  }
}
function freezeState(state: NamedRandomState): NamedRandomState {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(state).map(([name, stream]) => [
        name,
        Object.freeze({
          ...stream,
          algorithm: Object.freeze({ ...stream.algorithm }),
          state: Object.freeze([...stream.state]),
        }),
      ]),
    ),
  );
}

export function drawNamedRandomStream(
  state: NamedRandomState,
  name: string,
): { readonly randomState: NamedRandomState; readonly draw: RandomDrawMetadata } {
  validate(state);
  if (!Object.hasOwn(state, name))
    throw new TypeError("recorded stream required; implicit reseeding is unsupported");
  const stream = state[name]!;
  const generator = xoroshiro128plusFromState(stream.state.map(Number));
  const rawValue = BigInt(generator.next());
  return Object.freeze({
    randomState: freezeState({
      ...state,
      [name]: { ...stream, state: generator.getState().map(BigInt), draws: stream.draws + 1n },
    }),
    draw: Object.freeze({
      stream: stream.name,
      algorithm: stream.algorithm.algorithm,
      algorithmVersion: stream.algorithm.version,
      drawIndex: stream.draws,
      rawValue,
    }),
  });
}

export function serializeNamedRandomState(state: NamedRandomState): string {
  validate(state);
  return canonicalSerialize([
    RANDOM_CONTRACT_VERSION,
    Object.keys(state)
      .sort()
      .map((name) => {
        const stream = state[name]!;
        return [
          name,
          stream.algorithm.algorithm,
          "1",
          stream.draws.toString(),
          stream.state.map(String),
        ];
      }),
  ]);
}

export function restoreNamedRandomState(bytes: string): NamedRandomState {
  const parsed: unknown = JSON.parse(bytes);
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== CANONICAL_ENCODING_VERSION)
    throw new TypeError("unsupported canonical encoding");
  function decode(value: unknown): unknown {
    if (!Array.isArray(value) || value.length !== 2) throw new TypeError("invalid random encoding");
    if (value[0] === "string" && typeof value[1] === "string") return value[1];
    if (value[0] === "array" && Array.isArray(value[1])) return value[1].map(decode);
    throw new TypeError("invalid random encoding tag");
  }
  const wire = decode(parsed[1]);
  if (
    !Array.isArray(wire) ||
    wire.length !== 2 ||
    wire[0] !== RANDOM_CONTRACT_VERSION ||
    !Array.isArray(wire[1])
  )
    throw new TypeError("unsupported random contract");
  const entries = wire[1].map((entry: unknown) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 5 ||
      entry.slice(0, 4).some((item) => typeof item !== "string") ||
      !Array.isArray(entry[4]) ||
      entry[4].some(
        (item: unknown) => typeof item !== "string" || !/^(?:0|-?[1-9][0-9]*)$/u.test(item),
      ) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(entry[3] as string) ||
      entry[2] !== "1"
    )
      throw new TypeError("invalid random wire state");
    return [
      entry[0] as string,
      {
        name: entry[0] as RandomStreamName,
        algorithm: { algorithm: entry[1] as string, version: 1 },
        draws: BigInt(entry[3] as string),
        state: (entry[4] as string[]).map(BigInt),
      },
    ] as const;
  });
  const state = Object.fromEntries(entries);
  if (serializeNamedRandomState(state) !== bytes)
    throw new TypeError("noncanonical random encoding");
  return freezeState(state);
}

export function forkNamedRandomStream(): never {
  throw new TypeError("runtime random stream forks are unsupported");
}
export function reseedNamedRandomStream(): never {
  throw new TypeError("runtime random stream reseeding is unsupported");
}
