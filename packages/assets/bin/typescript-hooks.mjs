// Teaches Node's module loader the repository's `./x.js` -> `./x.ts` import convention and transforms
// the TypeScript syntax Node's strip-only mode does not support. Importing this module registers the
// hooks; the asset pipeline executable runs its sources this way.
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code === "ERR_MODULE_NOT_FOUND" &&
        specifier.startsWith(".") &&
        specifier.endsWith(".js")
      ) {
        return nextResolve(`${specifier.slice(0, -".js".length)}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: stripTypeScriptTypes(source, { mode: "transform" }),
      shortCircuit: true,
    };
  },
});
