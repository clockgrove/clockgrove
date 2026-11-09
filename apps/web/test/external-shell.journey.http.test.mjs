import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

it("serves and builds an external world's theme and static assets, refusing invalid asset paths", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "clockgrove-external-shell-"));
  const previous = {
    CLOCKGROVE_WORLD_SHELL: process.env.CLOCKGROVE_WORLD_SHELL,
    CLOCKGROVE_WORLD_ASSETS: process.env.CLOCKGROVE_WORLD_ASSETS,
  };
  let server;
  try {
    const shell = JSON.parse(
      await readFile(new URL("../../../worlds/fixture/shell.json", import.meta.url), "utf8"),
    );
    shell.name = "External Harbor & Light";
    shell.wordmark = "External Harbor";
    shell.tokens = { "--cg-v1-bg": "#123abc" };
    const shellFile = path.join(scratch, "shell.json");
    const assets = path.join(scratch, "reviewed");
    const outDir = path.join(scratch, "built");
    await mkdir(assets);
    await writeFile(shellFile, JSON.stringify(shell));
    await writeFile(path.join(assets, "external-art.txt"), "external placeholder art\n");
    process.env.CLOCKGROVE_WORLD_SHELL = shellFile;
    process.env.CLOCKGROVE_WORLD_ASSETS = assets;
    const config = { root, configFile: path.join(root, "vite.config.ts"), logLevel: "silent" };
    server = await createServer({ ...config, server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const text = (route) => fetch(`${origin}${route}`).then((response) => response.text());
    expect(await text("/")).toContain("<title>External Harbor &amp; Light</title>");
    expect(await text("/external-art.txt")).toBe("external placeholder art\n");
    const compiled = await text("/@vite/env");
    expect(compiled).toContain("External Harbor & Light");
    expect(compiled).toContain("#123abc");
    await server.close();
    server = undefined;
    await build({ ...config, build: { outDir, emptyOutDir: true } });
    expect(await readFile(path.join(outDir, "index.html"), "utf8")).toContain(
      "<title>External Harbor &amp; Light</title>",
    );
    expect(await readFile(path.join(outDir, "external-art.txt"), "utf8")).toBe(
      "external placeholder art\n",
    );
    const chunks = await Promise.all(
      (await readdir(path.join(outDir, "assets")))
        .filter((file) => file.endsWith(".js"))
        .map((file) => readFile(path.join(outDir, "assets", file), "utf8")),
    );
    expect(chunks.join("\n")).toContain("External Harbor & Light");
    expect(chunks.join("\n")).toContain("#123abc");
    for (const invalid of [path.join(scratch, "missing"), shellFile, ""]) {
      process.env.CLOCKGROVE_WORLD_ASSETS = invalid;
      await expect(createServer(config)).rejects.toThrow();
    }
  } finally {
    await server?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  }
}, 120_000);
