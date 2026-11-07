import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalBytes, sha256Hex } from "@clockgrove/kernel";
import { buildWorldPack } from "@clockgrove/world-pack-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readPackDirectory, sdkSource } from "../../cli/pack-source.js";
import { packPorts, ports } from "../../cli/ports.js";
import { decodeCanonicalBytes } from "../../src/canonical-decode.js";
import { runScenario, seedGenesis } from "../../src/index.js";
import {
  type ArtifactDocument,
  invoke,
  REPO_ROOT,
  stableBytes,
  temporaryDirectory,
} from "./helpers.js";

const WEATHER = {
  type: "world.weather.set",
  version: 2,
  payload: { rainIntensity: 0 },
};
const WEATHER_JSON = '{"type":"world.weather.set","version":2,"payload":{"rainIntensity":0}}';

interface StateFile {
  kind: string;
  pack: ArtifactDocument & { bundleHash: string };
  genesis: Record<string, unknown> & { bundleHash: string };
  steps: unknown[];
  run: {
    finalStateHash: string;
    events: unknown[];
    commands: { commandId: string; outcome: { status: string } }[];
  };
  finalStateHash: string;
  bundleHash: string;
}

let scratch: Awaited<ReturnType<typeof temporaryDirectory>>;
let artifactFile: string;
let counter = 0;

function path(name: string): string {
  counter += 1;
  return join(scratch.path, `${counter}-${name}`);
}

async function readState(file: string): Promise<StateFile> {
  const decoded = decodeCanonicalBytes(new Uint8Array(await readFile(file)));
  if (!decoded.ok) throw new Error("state file is not canonical bytes");
  return decoded.value as StateFile;
}

async function seed(pack: string = "worlds/fixture") {
  const out = path("state");
  return { out, ...(await invoke(["simulate", "seed", "--pack", pack, "--out", out])) };
}

const command = (state: string, json: string = WEATHER_JSON) =>
  invoke(["simulate", "command", "--state", state, "--command", json]);
const advance = (state: string, to: string) =>
  invoke(["simulate", "advance", "--state", state, "--to", to]);
const verify = (bundle: string) => invoke(["simulate", "verify", "--bundle", bundle]);

/** Rewrites a state file; `recompute` records the new `bundleHash`, otherwise the old one is kept. */
function tamper(
  state: StateFile,
  edit: (document: StateFile) => void,
  recompute: boolean,
): Uint8Array {
  const { bundleHash, ...document } = structuredClone(state);
  edit(document as StateFile);
  return canonicalBytes({
    ...document,
    bundleHash: recompute ? sha256Hex(canonicalBytes(document)) : bundleHash,
  });
}

/** Replaces a nested bundle with an edited copy under its own recomputed `bundleHash`. */
function rehashed<T extends { bundleHash: string }>(
  bundle: T,
  edit: (document: Omit<T, "bundleHash">) => void,
): T {
  const { bundleHash: _bundleHash, ...rest } = structuredClone(bundle);
  edit(rest);
  return { ...rest, bundleHash: sha256Hex(canonicalBytes(rest)) } as T;
}

async function pack() {
  const files = await readPackDirectory(join(REPO_ROOT, "worlds/fixture"));
  const built = await buildWorldPack(sdkSource(files), packPorts);
  if (!built.ok) throw new Error("the fixture pack does not build");
  return { artifact: built.value.artifact, source: sdkSource(files) };
}

/** The main run of a scenario with exactly `steps`. */
async function mainRun(steps: unknown[]): Promise<Readonly<Record<string, unknown>>> {
  const { artifact, source } = await pack();
  const scenario = {
    kind: "clockgrove.scenario",
    schemaVersion: 1,
    name: "session",
    pack: { id: artifact.packId, version: artifact.version },
    steps,
  };
  const result = await runScenario({ artifact, source, scenario }, ports);
  if (!result.ok) throw new Error(result.error.code);
  return { ...result.value.bundle.runs[0]! };
}

const commandStep = (key: string) => ({ kind: "command", key, ...WEATHER });
const advanceStep = (key: string, to: bigint) => ({
  kind: "advance",
  key,
  to,
  mode: "fast-forward",
});

beforeAll(async () => {
  scratch = await temporaryDirectory();
  artifactFile = join(scratch.path, "fixture.artifact");
  expect(
    (await invoke(["pack", "build", "--pack", "worlds/fixture", "--out", artifactFile])).run
      .exitCode,
  ).toBe(0);
});
afterAll(() => scratch.dispose());

describe("simulate seed", () => {
  it("writes the same state from an artifact file and a pack directory, embedding and reporting the genesis bundle", async () => {
    const fromFile = await seed(artifactFile);
    const fromDirectory = await seed();
    expect([fromFile.run.exitCode, fromDirectory.run.exitCode]).toEqual([0, 0]);
    expect(Buffer.compare(await readFile(fromFile.out), await readFile(fromDirectory.out))).toBe(0);
    expect(
      Buffer.compare(stableBytes(fromFile.envelope), stableBytes(fromDirectory.envelope)),
    ).toBe(0);
    const seeded = await seedGenesis(await pack(), ports);
    if (!seeded.ok) throw new Error("fixture does not seed");
    const genesis = seeded.value.bundle;
    const { bundleHash, ...unhashed } = await readState(fromFile.out);
    expect(unhashed).toMatchObject({
      kind: "clockgrove.simulation-state",
      steps: [],
      finalStateHash: genesis.finalStateHash,
    });
    expect(Buffer.from(canonicalBytes(unhashed.genesis)).equals(seeded.value.bytes)).toBe(true);
    expect(bundleHash).toBe(sha256Hex(canonicalBytes(unhashed)));
    expect(fromFile.envelope.result).toMatchObject({
      epoch: 100000n,
      events: genesis.events,
      seedProjection: genesis.seedProjection,
      finalStateHash: genesis.finalStateHash,
      bundleHash: genesis.bundleHash,
      stateBundleHash: bundleHash,
    });
  });

  it("refuses a seed projection mismatch (exit 1), an existing --out (exit 2) and non-canonical bytes (exit 3)", async () => {
    const directory = join(scratch.path, "bad-projection");
    await cp(join(REPO_ROOT, "worlds/fixture"), directory, { recursive: true });
    const manifest = await readFile(join(directory, "manifest.json"), "utf8");
    await writeFile(
      join(directory, "manifest.json"),
      manifest.replace(
        /"expectedSeedProjectionHash":"[0-9a-f]{64}"/u,
        `"expectedSeedProjectionHash":"${"a".repeat(64)}"`,
      ),
    );
    const mismatch = await seed(directory);
    expect(mismatch.run.exitCode).toBe(1);
    expect(mismatch.envelope).toMatchObject({
      status: "failed",
      result: null,
      refusal: { code: "SEED_PROJECTION_MISMATCH", path: "manifest.expectedSeedProjectionHash" },
    });
    await expect(readFile(mismatch.out)).rejects.toMatchObject({ code: "ENOENT" });

    const existing = path("existing");
    await writeFile(existing, "keep me");
    const exists = await invoke([
      "simulate",
      "seed",
      "--pack",
      "worlds/fixture",
      "--out",
      existing,
    ]);
    expect([exists.run.exitCode, exists.envelope.refusal?.code]).toEqual([2, "OUT_EXISTS"]);
    expect(await readFile(existing, "utf8")).toBe("keep me");

    const plain = path("plain");
    await writeFile(plain, "not canonical");
    const notCanonical = await seed(plain);
    expect(notCanonical.run.exitCode).toBe(3);
    expect(notCanonical.envelope.refusal).toMatchObject({
      code: "NOT_CANONICAL_BYTES",
      path: "--pack",
    });
  });
});

describe("simulate command and advance", () => {
  it("apply a step, report the run since the previous step and replace the state file", async () => {
    const { out } = await seed();
    const applied = await command(out);
    let state = await readState(out);
    expect(applied.run.exitCode).toBe(0);
    expect(state.steps).toEqual([commandStep("step-1")]);
    expect(state.run.commands[0]?.outcome.status).toBe("accepted");
    expect(applied.envelope.result).toMatchObject({
      commandId: state.run.commands[0]?.commandId,
      events: state.run.events,
      finalStateHash: state.finalStateHash,
      stateBundleHash: state.bundleHash,
    });
    const previous = state.run.events.length;
    const advanced = await advance(out, "170000");
    state = await readState(out);
    expect(advanced.run.exitCode).toBe(0);
    expect(state.steps).toEqual([commandStep("step-1"), advanceStep("step-2", 170000n)]);
    expect(advanced.envelope.result).toMatchObject({
      to: 170000n,
      events: state.run.events.slice(previous),
      ruleDisposition: "recorded-not-executed",
      finalStateHash: state.finalStateHash,
      stateBundleHash: state.bundleHash,
    });
  });

  it("refuse malformed values (exit 2), library, kernel and time refusals (exit 1), leaving the file unchanged", async () => {
    const { out } = await seed();
    const rejected = '{"type":"world.weather.set","version":2,"payload":{"rainIntensity":10001}}';
    type Refused = readonly [
      () => ReturnType<typeof invoke>,
      number,
      { code: string; path: string },
    ];
    const expectRefused = async (refusals: readonly Refused[]) => {
      const before = await readFile(out);
      for (const [invocation, exitCode, refusal] of refusals) {
        const { run, envelope } = await invocation();
        expect(run.exitCode).toBe(exitCode);
        expect(envelope.refusal).toMatchObject(refusal);
        expect(Buffer.compare(before, await readFile(out))).toBe(0);
      }
    };
    await expectRefused([
      [() => command(out, "{not json"), 2, { code: "MALFORMED_VALUE", path: "--command" }],
      [
        () => command(out, '{"type":"world.weather.set"}'),
        2,
        { code: "MALFORMED_VALUE", path: "--command" },
      ],
      [
        () => command(out, '{"type":"nothing.here","version":1,"payload":{}}'),
        1,
        { code: "UNCATALOGUED_COMMAND", path: "scenario.steps[0].type" },
      ],
      [
        () => command(out, rejected),
        1,
        { code: "precondition-failed", path: "payload.rainIntensity" },
      ],
      ...["soon", "-5", "007"].map(
        (to): Refused => [() => advance(out, to), 2, { code: "MALFORMED_VALUE", path: "--to" }],
      ),
    ]);
    expect((await advance(out, "170000")).run.exitCode).toBe(0);
    await expectRefused(
      ["170000", "169999"].map(
        (to): Refused => [
          () => advance(out, to),
          1,
          { code: "TARGET_NOT_AFTER_CURRENT", path: "--to" },
        ],
      ),
    );
  });
});

describe("a session of invocations", () => {
  async function play() {
    const { out } = await seed();
    const steps = [
      commandStep("step-1"),
      advanceStep("step-2", 170000n),
      advanceStep("step-3", 230000n),
    ];
    const states: string[] = [(await readFile(out)).toString("base64")];
    for (const [index, invocation] of [
      () => command(out),
      () => advance(out, "170000"),
      () => advance(out, "230000"),
    ].entries()) {
      const { run, envelope } = await invocation();
      expect(run.exitCode).toBe(0);
      states.push(
        Buffer.from(stableBytes(envelope)).toString("base64"),
        (await readFile(out)).toString("base64"),
      );
      // The state equals the runScenario main run of a scenario with exactly the applied steps, and verifies.
      const state = await readState(out);
      const expected = await mainRun(steps.slice(0, index + 1));
      expect(state.steps).toEqual(steps.slice(0, index + 1));
      expect(Buffer.from(canonicalBytes(state.run)).equals(canonicalBytes(expected))).toBe(true);
      expect((await verify(out)).envelope.result).toEqual({
        bundleHash: state.bundleHash,
        finalStateHash: expected.finalStateHash,
        steps: index + 1,
      });
    }
    return states;
  }

  it("matches runScenario after every invocation and reproduces byte-identical files and results whatever the host clock says", async () => {
    // Every invocation sees a host clock stopped at the given year.
    const playAt = async (year: number) => {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(year, 0, 1) });
      try {
        return await play();
      } finally {
        vi.useRealTimers();
      }
    };
    expect(await playAt(2200)).toEqual(await playAt(2100));
  });
});

describe("simulate verify defects", () => {
  it("names the altered field, or the bundle hash that no longer matches, and refuses to extend the state", async () => {
    const { out } = await seed();
    expect((await command(out)).run.exitCode).toBe(0);
    const state = await readState(out);
    const zero = "0".repeat(64);
    for (const [bytes, code, at] of [
      [
        tamper(state, (document) => void (document.finalStateHash = zero), true),
        "BUNDLE_FIELD_MISMATCH",
        "bundle.finalStateHash",
      ],
      [
        tamper(state, (document) => void (document.run.finalStateHash = zero), true),
        "BUNDLE_FIELD_MISMATCH",
        "bundle.run",
      ],
      [
        tamper(
          state,
          (document) =>
            void (document.genesis = rehashed(
              document.genesis,
              (genesis) => void (genesis.initialStateHash = zero),
            )),
          true,
        ),
        "BUNDLE_FIELD_MISMATCH",
        "bundle.genesis.initialStateHash",
      ],
      [
        tamper(
          state,
          (document) =>
            void (document.pack = rehashed(document.pack, (embedded) => {
              const [resource, content] = Object.entries(embedded.source.resources)[0]!;
              embedded.source.resources[resource] = Buffer.from(
                `${Buffer.from(content, "base64").toString("utf8")} `,
              ).toString("base64");
            })),
          true,
        ),
        "BUNDLE_FIELD_MISMATCH",
        "bundle.pack",
      ],
      [
        tamper(state, (document) => void (document.finalStateHash = zero), false),
        "BUNDLE_HASH_MISMATCH",
        "bundle.bundleHash",
      ],
      [
        tamper(state, (document) => void (document.genesis.initialStateHash = zero), true),
        "BUNDLE_HASH_MISMATCH",
        "bundle.genesis.bundleHash",
      ],
    ] as const) {
      const file = path("tampered");
      await writeFile(file, bytes);
      const { run, envelope } = await verify(file);
      expect(run.exitCode).toBe(1);
      expect(envelope).toMatchObject({ result: null, refusal: { code, path: at } });
    }

    const file = path("unverified");
    await writeFile(
      file,
      tamper(state, (document) => void (document.finalStateHash = zero), true),
    );
    const before = await readFile(file);
    for (const { run, envelope } of [await command(file), await advance(file, "170000")]) {
      expect(run.exitCode).toBe(1);
      expect(envelope.refusal).toMatchObject({
        code: "BUNDLE_FIELD_MISMATCH",
        path: "bundle.finalStateHash",
      });
    }
    expect(Buffer.compare(before, await readFile(file))).toBe(0);
  });
});

describe("unreadable state files", () => {
  it("exits 3 naming the state option for a missing path, non-canonical bytes and another document kind", async () => {
    const text = path("text");
    await writeFile(text, '{"kind":"clockgrove.simulation-state"}');
    for (const [invocation, option, code] of [
      [() => verify(path("absent")), "--bundle", "INPUT_UNREADABLE"],
      [() => verify(text), "--bundle", "NOT_CANONICAL_BYTES"],
      [() => verify(artifactFile), "--bundle", "NOT_SIMULATION_STATE"],
      [() => command(artifactFile), "--state", "NOT_SIMULATION_STATE"],
      [() => advance(artifactFile, "170000"), "--state", "NOT_SIMULATION_STATE"],
    ] as const) {
      const { run, envelope } = await invocation();
      expect(run.exitCode).toBe(3);
      expect(envelope).toMatchObject({ status: "unreadable", refusal: { code, path: option } });
    }
    expect(await readFile(text, "utf8")).toBe('{"kind":"clockgrove.simulation-state"}');
  });
});
