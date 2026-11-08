import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { neutralShell, readWorldShell } from "./src/shell-input.js";

// The composition root supplies a world-owned file; the platform never imports a world.
const shell = process.env.CLOCKGROVE_WORLD_SHELL
  ? readWorldShell(JSON.parse(readFileSync(process.env.CLOCKGROVE_WORLD_SHELL, "utf8")))
  : neutralShell;
const assets = process.env.CLOCKGROVE_WORLD_ASSETS;
const publicDir =
  assets === undefined
    ? fileURLToPath(new URL("../../assets/reviewed", import.meta.url))
    : resolve(assets);
if (assets !== undefined && (!assets.trim() || !statSync(publicDir).isDirectory()))
  throw new Error(`CLOCKGROVE_WORLD_ASSETS must name a directory: ${assets}`);

export default defineConfig({
  esbuild: { jsx: "automatic" },
  define: { __WORLD_SHELL__: JSON.stringify(shell) },
  publicDir,
  plugins: [
    {
      name: "world-shell-title",
      transformIndexHtml: (html) =>
        html.replace(
          "<title>Clockgrove</title>",
          `<title>${shell.name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</title>`,
        ),
    },
  ],
});
