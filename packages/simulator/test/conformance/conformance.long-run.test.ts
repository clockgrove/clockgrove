import { basename } from "node:path";
import { describe, it } from "vitest";
import { discoverPackDirectories, loadPack, SMALL_PACKS } from "./pack-source.js";
import { ResourceLedger } from "./runtime.js";
import { checkScenarios } from "./scenarios.js";

/**
 * Long-run suite (pnpm test:long-run): Node and workerd parity for every committed pack that the
 * per-PR conformance suite runs in Node only.
 */
const directories = discoverPackDirectories().filter(
  (directory) => !SMALL_PACKS.includes(basename(directory)),
);
const RUNTIME_TIMEOUT = 240000;

describe("pack conformance", () => {
  for (const directory of directories) {
    describe(`pack ${basename(directory)}`, () => {
      it(
        "runs every scenario identically in Node and workerd and matches its golden",
        async () => {
          await checkScenarios(await loadPack(directory), new ResourceLedger());
        },
        RUNTIME_TIMEOUT,
      );
    });
  }
});
