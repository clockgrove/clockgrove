import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";

export interface WorkerdResult {
  readonly status: number;
  readonly runtime: string | null;
  readonly body: string;
  readonly wrangler: string;
  readonly miniflare: string;
  readonly nativeRuntimeVersion: string;
}

/**
 * Bundles weather-needs.worker.ts with the pinned Wrangler, serves it from actual workerd through
 * Miniflare, fetches one URL and disposes the worker and its directory.
 */
export async function fetchFromWorkerd(url: string): Promise<WorkerdResult> {
  const temporary = await mkdtemp(join(tmpdir(), "clockgrove-kernel-workers-"));
  const require = createRequire(import.meta.url);
  const wranglerPackage = require.resolve("wrangler/package.json");
  const { Miniflare, convertV4MiniflareOptions } = createRequire(wranglerPackage)("miniflare");
  let worker: InstanceType<typeof Miniflare> | undefined;
  try {
    const config = join(temporary, "wrangler.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "clockgrove-kernel-differential",
        main: join(import.meta.dirname, "weather-needs.worker.ts"),
        compatibility_date: "2026-10-01",
      }),
    );
    const output = join(temporary, "bundle");
    await promisify(execFile)(
      process.execPath,
      [
        join(dirname(wranglerPackage), "bin/wrangler.js"),
        "deploy",
        "--dry-run",
        "--config",
        config,
        "--outdir",
        output,
      ],
      {
        timeout: 30000,
        env: {
          PATH: process.env.PATH,
          HOME: temporary,
          XDG_CONFIG_HOME: temporary,
          WRANGLER_SEND_METRICS: "false",
          CI: "true",
        },
      },
    );
    const entries = (await readdir(output)).filter((file) => file.endsWith(".js"));
    expect(entries).toHaveLength(1);
    worker = new Miniflare(
      convertV4MiniflareOptions({
        name: "kernel-differential",
        rootPath: temporary,
        modulesRoot: output,
        modules: true,
        scriptPath: join(output, entries[0]!),
        compatibilityDate: "2026-10-01",
      }),
    );
    const response = await worker!.dispatchFetch(url);
    const miniflarePackage = createRequire(wranglerPackage)("miniflare/package.json");
    return {
      status: response.status,
      runtime: response.headers.get("x-kernel-runtime"),
      body: await response.text(),
      wrangler: require(wranglerPackage).version,
      miniflare: miniflarePackage.version,
      nativeRuntimeVersion: miniflarePackage.dependencies.workerd,
    };
  } finally {
    try {
      await worker?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

export async function evidenceHash(bytes: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
