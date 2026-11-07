import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Change the pinned producer's metadata inputs before compilation/output, never artifacts.
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith("/wrangler/wrangler-dist/cli.js")) return loaded;
    let source = loaded.source.toString();
    for (const [before, after] of [
      ["sourceRoot: destination,", 'sourceRoot: "",'],
      [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal pinned producer expression
        "generated at ${(/* @__PURE__ */ new Date()).toISOString()}.",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal pinned producer expression
        "generated at ${process.env.CLOCKGROVE_BUILD_DATE}.",
      ],
    ]) {
      assert.equal(source.split(before).length, 2, "pinned Wrangler metadata input changed");
      source = source.replace(before, after);
    }
    return { ...loaded, source };
  },
});
