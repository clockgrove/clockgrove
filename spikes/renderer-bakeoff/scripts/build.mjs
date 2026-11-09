// Builds the bake-off into dist/: the harness and one classic-script (IIFE) bundle per candidate, so
// index.html runs from a file:// URL (module scripts do not), plus bundles.json with each bundle's size.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist`;
/** Every bundle the page loads; a candidate's size is its own bundle (the harness is shared). */
export const BUNDLES = {
  harness: "src/harness.ts",
  phaser: "src/candidates/phaser.ts",
  "three-webgl2": "src/candidates/three-webgl2.ts",
  "three-webgpu": "src/candidates/three-webgpu.ts",
};

// BAKEOFF_ONLY=<name> builds one bundle, for a focused check while working on one candidate.
const only = process.env.BAKEOFF_ONLY;
if (!only) await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const sizes = {};
for (const [name, entry] of Object.entries(BUNDLES)) {
  if (only && name !== only) continue;
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    publicDir: false,
    // IIFE has no import.meta; three's KTX2Loader builds URLs from import.meta.url at load (issue 77's shipped
    // models), which would throw on `{}.url`. The page's own location stands in.
    define: { "import.meta.url": "self.location.href" },
    build: {
      outDir: dist,
      emptyOutDir: false,
      minify: true,
      target: "es2022",
      reportCompressedSize: false,
      lib: {
        entry: `${root}${entry}`,
        formats: ["iife"],
        name: `bakeoff_${name.replace(/\W/gu, "_")}`,
        fileName: () => `${name}.js`,
      },
    },
  });
  const bytes = await readFile(`${dist}/${name}.js`);
  sizes[name] = { bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length };
}
if (!only) await copyFile(`${root}index.html`, `${dist}/index.html`);
if (!only) await writeFile(`${dist}/bundles.json`, `${JSON.stringify(sizes, null, 2)}\n`);
console.log(JSON.stringify(sizes));
