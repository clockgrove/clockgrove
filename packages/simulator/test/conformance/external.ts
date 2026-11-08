import {
  checkArtifactImmutability,
  checkContractCoverage,
  checkReproducibleBuild,
  checkScenarioGoldenLayout,
  checkSeedGenesis,
  checkValidateAndBuild,
} from "./checks.js";
import { loadPack } from "./pack-source.js";
import { checkPresentationBindings } from "./presentation.js";
import { ResourceLedger } from "./runtime.js";
import { checkScenarios } from "./scenarios.js";

export async function checkExternalPack(directory: string, assetsRoot: string) {
  const pack = await loadPack(directory);
  const build = await checkValidateAndBuild(pack);
  await checkReproducibleBuild(pack);
  await checkArtifactImmutability(pack);
  await checkSeedGenesis(pack, build);
  await checkContractCoverage(pack);
  await checkPresentationBindings(pack, assetsRoot);
  checkScenarioGoldenLayout(pack);
  const { reports } = await checkScenarios(pack, new ResourceLedger());
  return reports;
}
