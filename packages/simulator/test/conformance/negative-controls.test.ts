import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkScenarioGoldenLayout } from "./checks.js";
import { ConformanceFailure } from "./failure.js";
import { FIXTURE_SCENARIO, type FixturePackOptions, writeFixturePack } from "./fixture-pack.js";
import { checkEngineNeutrality } from "./neutrality.js";
import { type LoadedPack, loadPack, WORLDS_ROOT } from "./pack-source.js";
import { checkPresentationBindings } from "./presentation.js";
import { ResourceLedger } from "./runtime.js";
import { checkScenarios } from "./scenarios.js";

/**
 * Negative controls: the determinism layer must fail when its evidence is wrong. A planted defect in a
 * temporary pack must fail with a message naming the pack and the check.
 */
const TIMEOUT = 240000;
const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function packWith(name: string, options: FixturePackOptions = {}): Promise<LoadedPack> {
  const root = await mkdtemp(join(tmpdir(), "clockgrove-conformance-control-"));
  temporary.push(root);
  return loadPack(await writeFixturePack(root, name, options));
}

async function failureOf(run: () => Promise<unknown> | unknown): Promise<ConformanceFailure> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConformanceFailure) return error;
    throw error;
  }
  throw new Error("expected the conformance check to fail");
}

const nodeOnly = (pack: LoadedPack) =>
  checkScenarios(pack, new ResourceLedger(), { workers: false });

describe("conformance negative controls", () => {
  it("fails presentation bindings to another pack, a missing actor and the wrong entity", async () => {
    const pack = await loadPack(join(WORLDS_ROOT, "raccoons"));
    const presentation = JSON.parse(
      await readFile(join(pack.directory, "presentation.json"), "utf8"),
    );
    const directory = await mkdtemp(join(tmpdir(), "clockgrove-presentation-control-"));
    temporary.push(directory);
    const binding = { assetId: "stevie", animationFamily: "idle", accessibilityLabel: "Stevie" };
    await writeFile(
      join(directory, "presentation.json"),
      JSON.stringify({
        ...presentation,
        pack: { ...presentation.pack, version: "9.0.0" },
        bindings: [
          { ...binding, objectId: "grove.ghost" },
          { ...binding, objectId: "grove.porch" },
        ],
      }),
    );
    const failure = await failureOf(() => checkPresentationBindings({ ...pack, directory }));
    expect(failure.problems.map(({ check, detail }) => `${check}: ${detail}`)).toEqual([
      "presentation-bindings: presentation names clockgrove.green-lake-yard@9.0.0, the pack is clockgrove.green-lake-yard@1.1.0",
      "presentation-bindings: bindings[0]: grove.ghost is not an actor of the pack",
      "presentation-bindings: bindings[1]: manifest stevie/idle depicts grove.stevie, not grove.porch",
    ]);
  });

  it(
    "fails a mismatched golden and writes the actual bundle beside it",
    async () => {
      const pack = await packWith("mismatch-pack", { golden: "mismatch" });
      const failure = await failureOf(() => nodeOnly(pack));
      expect(failure.message).toContain('pack "mismatch-pack"');
      expect(failure.message).toContain('check "golden-match"');
      expect(failure.message).toMatch(/differing bundle fields: .*runs/u);
      const actual = join(pack.directory, "goldens", `${FIXTURE_SCENARIO}.actual.json`);
      expect(failure.message).toContain(actual);
      const committed = await readFile(join(pack.directory, "goldens", `${FIXTURE_SCENARIO}.json`));
      expect(Array.from(committed)).toEqual(Array.from(pack.goldens[0]!.bytes));
    },
    TIMEOUT,
  );

  it(
    "fails a missing golden without writing one into the pack",
    async () => {
      const pack = await packWith("missing-pack", { golden: "missing" });
      const failure = await failureOf(() => nodeOnly(pack));
      expect(failure.message).toContain('check "golden-match"');
      expect(existsSync(join(pack.directory, "goldens", `${FIXTURE_SCENARIO}.json`))).toBe(false);
      const layout = await failureOf(() => checkScenarioGoldenLayout(pack));
      expect(layout.message).toContain('check "scenario-golden-layout"');
    },
    TIMEOUT,
  );

  it("fails an engine source that uses a pack identity or a reference-world name outside comments", async () => {
    const pack = await packWith("neutral-pack");
    const engine = await mkdtemp(join(tmpdir(), "clockgrove-conformance-engine-"));
    temporary.push(engine);
    await writeFile(
      join(engine, "clean.ts"),
      '// sec.parent and green-lake only in a comment\nexport const note = "neutral";\n',
    );
    await checkEngineNeutrality([pack], [engine]);
    await writeFile(join(engine, "planted.ts"), 'export const keeper = "sec.parent";\n');
    const identity = await failureOf(() => checkEngineNeutrality([pack], [engine]));
    expect(identity.message).toContain('check "engine-neutrality"');
    expect(identity.message).toContain("planted.ts:1");
    await rm(join(engine, "planted.ts"));
    await writeFile(join(engine, "named.ts"), "export const who = `green-lake`;\n");
    const named = await failureOf(() => checkEngineNeutrality([], [engine]));
    expect(named.message).toContain("green-lake");
  });
});
