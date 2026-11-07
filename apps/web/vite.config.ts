import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
// The reviewed issue 813 atlas is served as-is: the scene loads `/<atlasId>.png` and its animations.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  publicDir: fileURLToPath(new URL("../../assets/reviewed", import.meta.url)),
});
