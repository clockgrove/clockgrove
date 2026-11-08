import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { neutralShell, readWorldShell } from "./src/shell-input.js";

// The composition root supplies a world-owned file; the platform never imports a world.
const shell = process.env.CLOCKGROVE_WORLD_SHELL
  ? readWorldShell(JSON.parse(readFileSync(process.env.CLOCKGROVE_WORLD_SHELL, "utf8")))
  : neutralShell;
export default defineConfig({
  esbuild: { jsx: "automatic" },
  define: { __WORLD_SHELL__: JSON.stringify(shell) },
  publicDir: fileURLToPath(new URL("../../assets/reviewed", import.meta.url)),
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
