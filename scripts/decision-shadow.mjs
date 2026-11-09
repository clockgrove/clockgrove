#!/usr/bin/env node
import "../packages/simulator/cli/typescript-hooks.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { runShadowDay } = await import("./decision-shadow-runner.mjs");

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      pack: { type: "string" },
      alias: { type: "string" },
      out: { type: "string" },
      "span-ms": { type: "string" },
      "spend-microusd": { type: "string" },
      margin: { type: "string" },
      "cohort-margin": { type: "string" },
      "models-off": { type: "boolean", default: false },
      "reference-pack": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  for (const name of ["pack", "alias", "out", "span-ms", "spend-microusd"])
    if (values[name] === undefined) throw new Error(`--${name} is required`);
  const report = await runShadowDay({
    pack: resolve(values.pack),
    alias: JSON.parse(await readFile(resolve(values.alias), "utf8")),
    spanMs: values["span-ms"],
    spendMicrousd: Number(values["spend-microusd"]),
    margin: values.margin,
    cohortMargin: values["cohort-margin"],
    modelsOff: values["models-off"],
    referencePack:
      values["reference-pack"] === undefined ? undefined : resolve(values["reference-pack"]),
  });
  await writeFile(resolve(values.out), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Decision shadow report written to ${resolve(values.out)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  try {
    await main(process.argv.slice(2));
  } catch {
    // Provider errors stay behind the gateway; do not echo arbitrary configuration values.
    process.stderr.write(
      "Decision shadow failed; check the pack, alias configuration and bounded run arguments.\n",
    );
    process.exitCode = 1;
  }
