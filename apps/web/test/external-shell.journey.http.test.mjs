import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { expect, it } from "vitest";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
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
    const assets = path.join(scratch, "assets/reviewed");
    const outDir = path.join(scratch, "built");
    execFileSync(
      process.execPath,
      [
        "--import",
        path.join(checkout, "packages/assets/bin/typescript-hooks.mjs"),
        "--input-type=module",
        "--eval",
        `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const [checkout, world] = process.argv.slice(1);
      const { encodePng } = await import(pathToFileURL(join(checkout, 'packages/assets/src/png.ts')));
      const { sha256Hex } = await import(pathToFileURL(join(checkout, 'packages/assets/src/validate.ts')));
      const manifest = JSON.parse(readFileSync(join(checkout, 'packages/contracts/test/fixtures/asset-manifest/approved.json')));
      const rgba = new Uint8Array(64);
      rgba.set([32,32,32,255],20); rgba.set([128,128,128,255],40);
      const png = encodePng({width:4,height:4,rgba});
      Object.assign(manifest, {frames:{width:4,height:4,count:1,durationMs:null}, anchor:{x:2,y:3}, bounds:{x:1,y:1,width:2,height:2},contentHash:sha256Hex(png)});
      mkdirSync(join(world,'assets/manifests/fixture-critter'),{recursive:true});
      mkdirSync(join(world,'assets/source/fixture-critter'),{recursive:true});
      mkdirSync(join(world,'reference'),{recursive:true});
      writeFileSync(join(world,'reference/asset-style.json'),readFileSync(join(checkout,'worlds/fixture/reference/asset-style.json')));
      writeFileSync(join(world,'assets/manifests/fixture-critter/idle.json'),JSON.stringify(manifest));
      writeFileSync(join(world,manifest.source.path),png);
      `,
        checkout,
        scratch,
      ],
      { cwd: scratch, timeout: 30_000 },
    );
    execFileSync(
      process.execPath,
      [
        path.join(checkout, "packages/assets/bin/clockgrove-assets.mjs"),
        "build",
        "--world",
        scratch,
      ],
      { cwd: scratch, timeout: 30_000 },
    );
    const atlasName = (await readdir(assets)).find((name) => name.endsWith(".png"));
    const atlasBytes = await readFile(path.join(assets, atlasName));
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
    expect(Buffer.from(await (await fetch(`${origin}/${atlasName}`)).arrayBuffer())).toEqual(
      atlasBytes,
    );
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
    expect(await readFile(path.join(outDir, atlasName))).toEqual(atlasBytes);
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
