import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkArtifactImmutability,
  checkContractCoverage,
  checkReproducibleBuild,
  checkScenarioGoldenLayout,
  checkSeedGenesis,
  checkValidateAndBuild,
} from "./checks.js";
import { checkEngineNeutrality } from "./neutrality.js";
import { discoverPackDirectories, loadAllPacks, loadPack, SMALL_PACKS } from "./pack-source.js";
import { checkPresentationBindings } from "./presentation.js";
import { ResourceLedger } from "./runtime.js";
import { checkScenarios } from "./scenarios.js";

/**
 * The shared pack conformance suite. Every directory under `worlds/` that holds a `manifest.json`
 * is a committed pack and gets the same checks; with no committed pack only the engine-neutrality
 * check has anything to look at.
 */
const directories = discoverPackDirectories();
const RUNTIME_TIMEOUT = 240000;

describe("pack conformance", () => {
  it("discovers every committed pack under worlds/ (none is a pass)", async () => {
    expect(directories).toEqual([...directories].sort());
    expect((await loadAllPacks()).map((pack) => pack.name)).toEqual(
      directories.map((directory) => basename(directory)),
    );
  });

  it("keeps engine sources free of pack identities and reference-world names", async () => {
    await checkEngineNeutrality(await loadAllPacks());
  });

  for (const directory of directories) {
    describe(`pack ${basename(directory)}`, () => {
      it("validates and builds with the simulator ports", async () => {
        await checkValidateAndBuild(await loadPack(directory));
      });

      it("builds reproducibly from the same and a reordered source", async () => {
        await checkReproducibleBuild(await loadPack(directory));
      });

      it("returns an immutable artifact and leaves the source unchanged", async () => {
        await checkArtifactImmutability(await loadPack(directory));
      });

      it("seeds genesis with the recorded seed projection and verifies the bundle", async () => {
        const pack = await loadPack(directory);
        await checkSeedGenesis(pack, await checkValidateAndBuild(pack));
      });

      it("covers the engine contracts", async () => {
        await checkContractCoverage(await loadPack(directory));
      });

      it("binds its presentation metadata to pack actors and asset manifests", async () => {
        await checkPresentationBindings(await loadPack(directory));
      });

      it("pairs every scenario with exactly one golden", async () => {
        checkScenarioGoldenLayout(await loadPack(directory));
      });

      // Per PR every committed scenario runs once in Node against its golden; only the small
      // fixture pack also runs in workerd. conformance.long-run.test.ts runs the rest in workerd.
      const workers = SMALL_PACKS.includes(basename(directory));
      it(
        workers
          ? "runs every scenario identically in Node and workerd and matches its golden"
          : "runs every scenario in Node and matches its golden",
        async () => {
          await checkScenarios(await loadPack(directory), new ResourceLedger(), { workers });
        },
        RUNTIME_TIMEOUT,
      );
    });
  }
});
