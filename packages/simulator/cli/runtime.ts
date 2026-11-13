import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT } from "./repo.js";
import { runWire, type WireRequest, type WireResponse } from "./wire.js";

/** Runtime observations. They are measured by the host and never enter a bundle. */
export interface Observation {
  readonly runtime: string;
  readonly durationMs: number;
  readonly peakMemoryBytes: number | null;
  readonly peakMemoryNullReason: string | null;
}

export interface RuntimeRun {
  readonly response: WireResponse;
  readonly observation: Observation;
}

export const WORKERS_RUNTIME_HEADER = "x-clockgrove-runtime";
export const WORKERS_PEAK_MEMORY_REASON =
  "workerd exposes no in-isolate memory API; the harness cannot measure its peak memory from the host here";

/** True when undici's fetch failed at the connection (it throws a TypeError "fetch failed" with the socket error as cause). */
function isConnectionFailure(error: unknown): boolean {
  return error instanceof TypeError && (error as { cause?: unknown }).cause !== undefined;
}

/** The connection error behind a failed fetch, for the message: its code and text. */
function describeCause(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  if (cause === undefined || cause === null) return String((error as Error)?.message ?? error);
  return [cause.code, cause.message].filter((part) => part !== undefined).join(": ");
}

/**
 * Sends a request to the local workerd, again (twice at most) when the loopback connection failed. A long CPU-bound
 * Node run between two requests keeps this process from reading the socket, workerd closes the kept-alive connection
 * as idle, and the next request fails at the connection before reaching the worker: UND_ERR_SOCKET ("other side
 * closed") or another connection error. A wire request is a deterministic simulation with no state in the worker, so sending it again is safe. A failure that is not at the
 * connection is not retried; a connection that still fails is reported with its cause.
 */
export async function retryStaleSocket<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (!isConnectionFailure(error)) throw error;
      if (attempt === 3)
        throw new Error(
          `the workerd request failed at the connection ${attempt} times: ${describeCause(error)}`,
          {
            cause: error,
          },
        );
    }
  }
}

/** The workers runtime could not be started or did not answer as actual workerd. */
export class WorkersUnavailable extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "WorkersUnavailable";
  }
}

/** Tracks the workers and temporary directories a run creates; `disposeAll` disposes them. */
export class ResourceLedger {
  readonly tempDirs: string[] = [];
  readonly workers: WorkersSession[] = [];

  async makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    this.tempDirs.push(directory);
    return directory;
  }

  async disposeAll(): Promise<void> {
    for (const worker of this.workers) await worker.dispose();
    for (const directory of this.tempDirs) await rm(directory, { recursive: true, force: true });
  }
}

interface MiniflareLike {
  dispatchFetch(
    url: string,
    init: { method: string; body: string },
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
  dispose(): Promise<void>;
}

/** An actual workerd (Miniflare from the pinned root Wrangler) running `worker.ts`. */
export class WorkersSession {
  private worker: MiniflareLike | undefined;
  disposed = false;

  private constructor(readonly directory: string) {}

  /** Starts workerd; a failure disposes the session and throws `WorkersUnavailable`. */
  static async start(ledger: ResourceLedger): Promise<WorkersSession> {
    const directory = await ledger.makeTempDir("clockgrove-workers-");
    const session = new WorkersSession(directory);
    ledger.workers.push(session);
    try {
      await session.boot();
    } catch (error) {
      await session.dispose();
      if (error instanceof WorkersUnavailable) throw error;
      throw new WorkersUnavailable(
        `workerd could not be started: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return session;
  }

  private async boot(): Promise<void> {
    const require = createRequire(import.meta.url);
    const wranglerPackage = require.resolve("wrangler/package.json");
    const wranglerVersion = (require(wranglerPackage) as { version: string }).version;
    const rootManifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const pinned = rootManifest.devDependencies?.wrangler;
    if (pinned !== wranglerVersion)
      throw new WorkersUnavailable(
        `resolved wrangler ${wranglerVersion} is not the pinned root wrangler ${String(pinned)}`,
      );
    const { Miniflare, convertV4MiniflareOptions } = createRequire(wranglerPackage)("miniflare");

    const config = join(this.directory, "wrangler.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "clockgrove-workers",
        main: join(import.meta.dirname, "worker.ts"),
        compatibility_date: "2026-10-01",
      }),
    );
    const output = join(this.directory, "bundle");
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
        timeout: 90000,
        env: {
          PATH: process.env.PATH,
          HOME: this.directory,
          XDG_CONFIG_HOME: this.directory,
          WRANGLER_SEND_METRICS: "false",
          CI: "true",
        },
      },
    );
    const entries = (await readdir(output)).filter((file) => file.endsWith(".js"));
    if (entries.length !== 1)
      throw new WorkersUnavailable(`expected one bundled worker module, found ${entries.length}`);
    this.worker = new Miniflare(
      convertV4MiniflareOptions({
        name: "clockgrove",
        rootPath: this.directory,
        modulesRoot: output,
        modules: true,
        scriptPath: join(output, entries[0]!),
        compatibilityDate: "2026-10-01",
      }),
    ) as MiniflareLike;
  }

  async run(request: WireRequest): Promise<RuntimeRun> {
    if (this.worker === undefined || this.disposed)
      throw new WorkersUnavailable("the workers session is not running");
    const started = performance.now();
    const worker = this.worker;
    const response = await retryStaleSocket(() =>
      worker.dispatchFetch("http://local.invalid/", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
    const text = await response.text();
    const durationMs = performance.now() - started;
    if (response.status !== 200)
      throw new WorkersUnavailable(`worker answered ${response.status}: ${text.slice(0, 300)}`);
    const runtime = response.headers.get(WORKERS_RUNTIME_HEADER) ?? "";
    if (runtime !== "Cloudflare-Workers")
      throw new WorkersUnavailable(
        `the second runtime reported "${runtime}", not actual workerd ("Cloudflare-Workers")`,
      );
    return {
      response: JSON.parse(text) as WireResponse,
      observation: {
        runtime: `${runtime} (workerd)`,
        durationMs,
        peakMemoryBytes: null,
        peakMemoryNullReason: WORKERS_PEAK_MEMORY_REASON,
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    this.worker = undefined;
    try {
      await worker?.dispose();
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}

/** Runs the same wire request in this Node process; peak memory is the process high-water RSS. */
export async function runInNode(request: WireRequest): Promise<RuntimeRun> {
  const started = performance.now();
  const response = await runWire(request);
  const durationMs = performance.now() - started;
  return {
    response,
    observation: {
      runtime: `node/${process.version}`,
      durationMs,
      peakMemoryBytes: process.resourceUsage().maxRSS * 1024,
      peakMemoryNullReason: null,
    },
  };
}
