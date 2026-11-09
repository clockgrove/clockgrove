#!/usr/bin/env node
import "./typescript-hooks.mjs";

const { runAssetsCli } = await import("../src/cli.ts");
const { status, stdout, stderr } = runAssetsCli(process.argv.slice(2));
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = status;
