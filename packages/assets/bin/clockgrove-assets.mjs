#!/usr/bin/env node
import { setFlagsFromString } from "node:v8";
import "./typescript-hooks.mjs";

// One command is a short-lived process. With V8's default tier-up budget, a small world's KTX2
// encodes pass the threshold of the Basis Universal wasm's largest functions just before exit, and
// the process then spends about as long again compiling them with the optimising tier, which it
// must finish before it can exit and which nothing then runs. A ten-times budget keeps short commands
// on the baseline tier while a large world's long encodes still tier up. Set before the encoder's
// wasm module is compiled; the encoded bytes are the same on either tier.
setFlagsFromString("--wasm-tiering-budget=130000000");

const { runAssetsCli } = await import("../src/cli.ts");
const { status, stdout, stderr } = runAssetsCli(process.argv.slice(2));
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = status;
