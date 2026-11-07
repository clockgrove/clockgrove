import type { NamedRandomState } from "@clockgrove/domain";
import {
  canonicalSerialize,
  drawNamedRandomStream,
  forkNamedRandomStream,
  initializeNamedRandomStreams,
  reseedNamedRandomStream,
  restoreNamedRandomState,
  serializeNamedRandomState,
} from "../src/index.js";

export const installationSeed = { version: 1, seed: "installation-golden-1" } as const;
export const streamNames = ["behavior", "lifecycle", "weather"] as const;
// Frozen independently from pure-rand 8.4.2's upstream initializer/next, using the
// documented FNV-1a derivation and a separate string/array canonical encoder.
export const vectors = {
  behavior: {
    initial: [-1n, 611702455n, -611702456n, 0n],
    raw: [611702455n, -738721748n, -407873724n],
    states: [
      [233211668n, 1161636168n, -1900357916n, -1900357916n],
      [-957765794n, 2082871595n, 1895822736n, 1804221977n],
      [-1163631749n, 458804885n, -175839658n, -1026926142n],
    ],
  },
  lifecycle: {
    initial: [-1n, -862433219n, 862433218n, 0n],
    raw: [-862433219n, 879015803n, 1688808197n],
    states: [
      [1667826933n, -1587892286n, -1828059207n, -1828059207n],
      [109996979n, 1481163135n, 1242894206n, 207645062n],
      [-1693550556n, -2083051886n, -2062213335n, -1821599318n],
    ],
  },
  weather: {
    initial: [-1n, 1496693493n, -1496693494n, 0n],
    raw: [1496693493n, 1022796725n, 1728486557n],
    states: [
      [479843962n, 373245194n, 649551531n, 649551531n],
      [-924219620n, 557154935n, 285439015n, 1171331622n],
      [921739869n, -1954713130n, -1668085189n, 1029597036n],
    ],
  },
} as const;
export const goldenInitialBytes =
  '["clockgrove-canonical-v1",["array",[["string","clockgrove-random-v1"],["array",[["array",[["string","behavior"],["string","pure-rand@8.4.2/xoroshiro128plus"],["string","1"],["string","0"],["array",[["string","-1"],["string","611702455"],["string","-611702456"],["string","0"]]]]],["array",[["string","lifecycle"],["string","pure-rand@8.4.2/xoroshiro128plus"],["string","1"],["string","0"],["array",[["string","-1"],["string","-862433219"],["string","862433218"],["string","0"]]]]],["array",[["string","weather"],["string","pure-rand@8.4.2/xoroshiro128plus"],["string","1"],["string","0"],["array",[["string","-1"],["string","1496693493"],["string","-1496693494"],["string","0"]]]]]]]]]]';
export const goldenInitialHash = "d0b76adc7ab7494bc12122ca4c4d47819abcddabeb2ea6d4db6fbbee9e633699";

function equal(actual: unknown, expected: unknown): void {
  if (canonicalSerialize(actual) !== canonicalSerialize(expected))
    throw new Error("random golden mismatch");
}
function refuses(operation: () => unknown): boolean {
  try {
    operation();
  } catch {
    return true;
  }
  throw new Error("random rejection control accepted invalid input");
}
export function randomRejections(initial: NamedRandomState) {
  const weather = initial.weather!;
  const invalid = [
    { ...weather, name: "foreign" },
    { ...weather, algorithm: { ...weather.algorithm, version: 2 } },
    { ...weather, algorithm: { ...weather.algorithm, algorithm: "unknown" } },
    { ...weather, draws: -1n },
    { ...weather, draws: 0 },
    { ...weather, state: [0n, 0n, 0n, 0n] },
    { ...weather, state: [0n] },
    { ...weather, state: [2147483648n, 0n, 0n, 0n] },
    { ...weather, state: [-2147483649n, 0n, 0n, 0n] },
    { ...weather, state: [1, 0n, 0n, 0n] },
    { ...weather, extra: true },
  ];
  const wire = [
    "clockgrove-random-v1",
    [
      [
        "weather",
        "pure-rand@8.4.2/xoroshiro128plus",
        "1",
        "0",
        ["-1", "1496693493", "-1496693494", "0"],
      ],
    ],
  ];
  return {
    state: invalid.map((stream) =>
      refuses(() =>
        drawNamedRandomStream({ weather: stream } as unknown as NamedRandomState, "weather"),
      ),
    ),
    encoding: [
      "invalid-json",
      `${goldenInitialBytes}\n`,
      goldenInitialBytes.replace("clockgrove-random-v1", "clockgrove-random-v2"),
      goldenInitialBytes.replace("clockgrove-canonical-v1", "clockgrove-canonical-v2"),
      goldenInitialBytes.replace('["string","611702455"]', '["string","0611702455"]'),
      canonicalSerialize([wire[0], [...wire[1]!, ...wire[1]!]]),
      canonicalSerialize([
        wire[0],
        [["weather", "pure-rand@8.4.2/xoroshiro128plus", "2", "0", ["-1", "1", "2", "0"]]],
      ]),
      canonicalSerialize([
        wire[0],
        [["weather", "pure-rand@8.4.2/xoroshiro128plus", "1", "-1", ["-1", "1", "2", "0"]]],
      ]),
    ].map((bytes) => refuses(() => restoreNamedRandomState(bytes))),
    names: [[], [""], ["weather", "weather"]]
      .slice(1)
      .map((names) => refuses(() => initializeNamedRandomStreams(installationSeed, names))),
    seed: refuses(() =>
      initializeNamedRandomStreams(
        { version: 2, seed: "recorded" } as unknown as typeof installationSeed,
        streamNames,
      ),
    ),
    implicitReseed: refuses(() => drawNamedRandomStream(initial, "missing")),
    fork: refuses(forkNamedRandomStream),
    reseed: refuses(reseedNamedRandomStream),
  };
}

export async function randomRuntimeEvidence() {
  const initial = initializeNamedRandomStreams(installationSeed, streamNames);
  const initialBytes = serializeNamedRandomState(initial);
  equal(initialBytes, goldenInitialBytes);
  equal(
    serializeNamedRandomState(
      initializeNamedRandomStreams(installationSeed, [...streamNames].reverse()),
    ),
    initialBytes,
  );
  const draws = streamNames.map((name) => {
    equal(initial[name]!.state, vectors[name].initial);
    let state = initial;
    return vectors[name].raw.map((rawValue, index) => {
      const before = serializeNamedRandomState(state);
      const result = drawNamedRandomStream(state, name);
      equal(serializeNamedRandomState(state), before);
      equal(result.draw, {
        stream: name,
        algorithm: "pure-rand@8.4.2/xoroshiro128plus",
        algorithmVersion: 1,
        drawIndex: BigInt(index),
        rawValue,
      });
      equal(result.randomState[name]!.state, vectors[name].states[index]);
      state = restoreNamedRandomState(serializeNamedRandomState(result.randomState));
      equal(state, result.randomState);
      return result;
    });
  });
  let noisy = initial;
  for (let index = 0; index < 17; index += 1)
    noisy = drawNamedRandomStream(noisy, "weather").randomState;
  const independence = ["behavior", "lifecycle"].map((name) => {
    let clean = initial;
    let extra = noisy;
    const sequence = [];
    for (let index = 0; index < 3; index += 1) {
      const left = drawNamedRandomStream(clean, name),
        right = drawNamedRandomStream(extra, name);
      equal(left.draw, right.draw);
      equal(left.randomState[name], right.randomState[name]);
      sequence.push(right.draw);
      clean = left.randomState;
      extra = right.randomState;
    }
    return { name, sequence, state: extra[name] };
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(initialBytes));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  equal(hash, goldenInitialHash);
  return {
    initial,
    initialBytes,
    hash,
    draws,
    independence,
    rejections: randomRejections(initial),
  };
}
