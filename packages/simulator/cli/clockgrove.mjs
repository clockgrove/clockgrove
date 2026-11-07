#!/usr/bin/env node
// The clockgrove executable. Node runs the TypeScript sources directly: the hooks only teach the
// module loader the repository's `./x.js` -> `./x.ts` import convention and transform the TypeScript
// syntax Node's strip-only mode does not support. There is no build step.
import "./typescript-hooks.mjs";

const { main } = await import("./main.ts");
process.exitCode = await main(process.argv.slice(2));
