import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type BundleDifference, bytesEqual, describeDifference } from "../../cli/difference.js";
import { ACTUAL_SUFFIX } from "../../cli/pack-source.js";
import type { LoadedPack } from "./pack-source.js";

export { type BundleDifference, bytesEqual, describeDifference };

/** Where a scenario's actual bundle is written for review: next to its golden, git-ignored. */
export const actualBundlePath = (pack: LoadedPack, scenario: string): string =>
  join(pack.directory, "goldens", `${scenario}${ACTUAL_SUFFIX}`);

/**
 * Writes the actual bundle bytes to `goldens/<scenario>.actual.json` in the pack and returns that path.
 * The file holds exactly the canonical bytes, so an author who has reviewed it can copy it over the
 * golden. The golden itself is never written.
 */
export async function writeActualBundle(
  pack: LoadedPack,
  scenario: string,
  bytes: Uint8Array,
): Promise<string> {
  const path = actualBundlePath(pack, scenario);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

/** Removes a stale actual bundle once the golden matches. */
export async function removeActualBundle(pack: LoadedPack, scenario: string): Promise<void> {
  await rm(actualBundlePath(pack, scenario), { force: true });
}
