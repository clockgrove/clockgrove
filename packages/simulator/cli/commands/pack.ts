import { writeFile } from "node:fs/promises";
import { buildWorldPack, lintWorldPack, validateWorldPack } from "@clockgrove/world-pack-sdk";
import { type CommandSpec, optionValue } from "../args.js";
import { encodePackArtifact, readPackArtifact } from "../artifact.js";
import { failed, succeed, usage } from "../envelope.js";
import { isFileSystemError, pathExists, readCanonicalFile } from "../input.js";
import { readableSdkSource, readPackDirectory } from "../pack-source.js";
import { packPorts } from "../ports.js";
import { readingOption } from "../reading.js";
import { runPackChecks } from "./pack-checks.js";

const validate: CommandSpec = {
  options: ["--pack"],
  run: (options) =>
    readingOption("--pack", async () => {
      const source = readableSdkSource(await readPackDirectory(optionValue(options, "--pack")));
      const validated = await validateWorldPack(source, packPorts);
      if (!validated.ok) return failed(validated.error);
      const { id: packId, version } = validated.value;
      return succeed({ packId, version, findings: lintWorldPack(validated.value) });
    }),
};

const build: CommandSpec = {
  options: ["--pack", "--out"],
  run: async (options) => {
    const out = optionValue(options, "--out");
    if (await pathExists(out))
      return usage("OUT_EXISTS", "--out", "the output path already exists");
    return readingOption("--pack", async () => {
      const files = await readPackDirectory(optionValue(options, "--pack"));
      const built = await buildWorldPack(readableSdkSource(files), packPorts);
      if (!built.ok) return failed(built.error);
      const file = encodePackArtifact(built.value.artifact, files);
      try {
        await writeFile(out, file.bytes, { flag: "wx" });
      } catch (error) {
        if (isFileSystemError(error))
          return usage("OUT_UNWRITABLE", "--out", "the output file cannot be created");
        throw error;
      }
      return succeed({ artifact: built.value.artifact, bundleHash: file.bundleHash });
    });
  },
};

const test: CommandSpec = {
  options: ["--artifact"],
  run: (options) =>
    readingOption("--artifact", async () => {
      const file = readPackArtifact(await readCanonicalFile(optionValue(options, "--artifact")));
      const checks = await runPackChecks(file);
      const result = { artifact: file.artifact, bundleHash: file.bundleHash, checks };
      return checks.every((check) => check.status === "passed")
        ? succeed(result)
        : failed(null, result);
    }),
};

export const PACK_COMMANDS: ReadonlyMap<string, CommandSpec> = new Map([
  ["pack validate", validate],
  ["pack build", build],
  ["pack test", test],
]);
