import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Build-time scene budgets (apps/web/docs/scene.md): run after `vite build` in apps/web.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps/web");
const { budgets } = JSON.parse(await readFile(path.join(web, "scene-budgets.json"), "utf8"));
const built = path.join(web, "dist/assets");
// Every built JS chunk counts (today the entry and the scene chunk), so a renamed or newly split
// chunk can only raise the figure, never drop out of it.
const chunks = (await readdir(built)).filter((name) => name.endsWith(".js"));
if (!chunks.some((name) => name.startsWith("index-")) || !chunks.some((name) => name.startsWith("renderer-")))
  throw new Error(`scene budget: expected the entry and scene chunks in ${built}, found ${chunks.join(", ")}`);
let initial = 0;
for (const name of chunks)
  initial += gzipSync(await readFile(path.join(built, name)), { level: 9 }).length;
let assets = 0;
for (const name of await readdir(path.join(root, "worlds/fixture/assets/reviewed")))
  assets += (await readFile(path.join(root, "worlds/fixture/assets/reviewed", name))).length;
const measured = { initialJsGzipBytes: initial, assetBytes: assets };
const over = Object.entries(measured).filter(([name, value]) => value > budgets[name].limit);
if (over.length)
  throw new Error(
    `scene budget exceeded: ${over.map(([name, value]) => `${name} ${value} > ${budgets[name].limit}`).join(", ")}`,
  );
console.log(`scene build budgets held: ${JSON.stringify(measured)}`);
