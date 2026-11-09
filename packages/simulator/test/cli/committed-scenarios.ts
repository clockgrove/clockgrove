import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256Hex } from "@clockgrove/kernel";
import { expect } from "vitest";
import { walk } from "../../cli/pack-source.js";
import { WORLDS_ROOT } from "../../cli/repo.js";
import { decodeCanonicalBytes } from "../../src/canonical-decode.js";
import { discoverPackDirectories } from "../conformance/pack-source.js";
import { invoke } from "./helpers.js";

type Rec = Record<string, any>;

export async function committedScenarios(): Promise<{ pack: string; name: string }[]> {
  const found: { pack: string; name: string }[] = [];
  for (const directory of discoverPackDirectories())
    for (const file of (await readdir(join(directory, "scenarios"))).sort())
      found.push({ pack: relative(WORLDS_ROOT, directory), name: file.slice(0, -".json".length) });
  return found;
}

export async function treeDigest(root: string): Promise<Record<string, string>> {
  const files: Record<string, Uint8Array> = {};
  await walk(root, "", files);
  return Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256Hex(bytes)]));
}

async function canonicalFile(path: string): Promise<Rec> {
  const decoded = decodeCanonicalBytes(new Uint8Array(await readFile(path)));
  if (!decoded.ok) throw new Error(`${path} is not canonical bytes`);
  return decoded.value as Rec;
}

/**
 * Runs each named committed scenario through `simulate scenario --runtime node` and expects its
 * golden, passing assertions and Node observations, without changing anything under worlds/.
 */
export async function expectCommittedScenariosMatch(
  scenarios: readonly { pack: string; name: string }[],
): Promise<void> {
  const before = await treeDigest(WORLDS_ROOT);
  for (const { pack, name } of scenarios) {
    const { run, envelope } = await invoke(["simulate", "scenario", name, "--runtime", "node"]);
    expect(run.exitCode, name).toBe(0);
    const result = envelope.result as Rec;
    expect(result.golden).toEqual({ status: "match", difference: null });
    expect(result.bundle).toEqual(
      await canonicalFile(join(WORLDS_ROOT, pack, "goldens", `${name}.json`)),
    );
    expect((result.assertions as Rec[]).every((assertion) => assertion.passed === true)).toBe(true);
    expect(envelope.observations.runtime).toMatch(/^node\/v\d+\.\d+\.\d+/u);
  }
  expect(await treeDigest(WORLDS_ROOT)).toEqual(before);
}
