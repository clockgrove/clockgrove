#!/usr/bin/env node
// The bake-off measurement script (README, "Measuring"). Two ways in, one output:
//   measure.mjs --browser <exe> [--browser-arg <flag>]... --out <dir>
//     serves dist/ on a loopback port, starts the browser headless on the page with a real clock,
//     and receives the page's JSON record by POST;
//   measure.mjs --from-dom <dump.html> --out <dir>
//     reads the record a browser wrote into its DOM (`--headless=new --dump-dom file:///.../index.html`).
// Either way it writes results.json (every number with its host, browser and renderer string),
// one PNG per candidate, lighting state and tier, and report.html beside the reference mockup.
// `measure()` is also exported with an injectable launcher: the CI journey passes one that opens the
// page in the repository's pinned Playwright Chromium, launched as its other browser tests launch it.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");

/** Each candidate's adapter source, for the code-complexity count. */
const SOURCES = {
  phaser: ["src/candidates/phaser.ts"],
  "three-webgl2": ["src/candidates/three.ts", "src/candidates/three-webgl2.ts"],
  "three-webgpu": ["src/candidates/three.ts", "src/candidates/three-webgpu.ts"],
};
/** Renderer strings of software rasterisers: their numbers prove correctness, never performance. */
export const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softpipe|software|microsoft basic render/iu;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
/** Decision: 20 minutes covers 3 candidates × 6 runs × 190 frames at SwiftShader's ~0.3 s a frame. */
const DEFAULT_TIMEOUT_MS = 1_200_000;

/**
 * @typedef {object} Launched
 * @property {Promise<string>} failed resolves with the browser's own error if it dies before the page reports
 * @property {() => Promise<void>} close
 * @property {string | null} executable
 * @property {readonly string[]} browserArgs
 */

/**
 * Serves dist/, opens the page with `launch(url)`, and resolves with the first POSTed record.
 * @param {(url: string) => Promise<Launched>} launch
 */
async function servePage(options, launch) {
  let resolveRecord;
  const received = new Promise((resolve) => {
    resolveRecord = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/result") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.end("ok");
      resolveRecord(Buffer.concat(chunks).toString("utf8"));
      return;
    }
    const name = path.basename(new URL(request.url ?? "/", "http://x").pathname) || "index.html";
    try {
      const body = await readFile(path.join(dist, name));
      response.writeHead(200, {
        "content-type": TYPES[path.extname(name)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise((resolve) => server.listen(0, host, resolve));
  const query = new URLSearchParams({ report: "/result" });
  if (options.candidates) query.set("candidates", options.candidates);
  if (options.frames) query.set("frames", String(options.frames));
  if (options.rafFrames) query.set("rafFrames", String(options.rafFrames));
  if (options.warmup) query.set("warmup", String(options.warmup));
  if (options.panFrames) query.set("panFrames", String(options.panFrames));
  let timer;
  let launched;
  try {
    launched = await launch(`http://${host}:${server.address().port}/index.html?${query}`);
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    });
    const outcome = await Promise.race([
      received.then((json) => ({ json })),
      launched.failed.then((error) => ({ error })),
      timeout.then(() => ({ error: "timed out" })),
    ]);
    if (outcome.error !== undefined) throw new Error(`no result from the page: ${outcome.error}`);
    return {
      json: outcome.json,
      browserArgs: launched.browserArgs,
      executable: launched.executable,
    };
  } finally {
    clearTimeout(timer);
    await launched?.close();
    server.close();
  }
}

/** The CLI's launcher: spawns any Chromium-family executable headless, its stderr kept for errors. */
export function spawnLauncher(executable, extra) {
  return async (url) => {
    const profile = extra.some((arg) => arg.startsWith("--user-data-dir"))
      ? undefined
      : await mkdtemp(path.join(os.tmpdir(), "bakeoff-profile-"));
    const args = [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      ...(profile ? [`--user-data-dir=${profile}`] : []),
      ...extra,
    ];
    const browser = spawn(executable, [...args, url], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    browser.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    const failed = new Promise((resolve) => {
      browser.on("error", (error) => resolve(`the browser did not start: ${error.message}`));
      browser.on("exit", (code, signal) =>
        resolve(`the browser exited (${signal ?? code}); its stderr:\n${stderr}`),
      );
    });
    return {
      failed,
      executable,
      browserArgs: args,
      close: async () => {
        browser.kill("SIGKILL");
        if (profile) await rm(profile, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  };
}

async function fromDom(file) {
  const html = await readFile(file, "utf8");
  const match = /<script[^>]*id="bakeoff-result"[^>]*>([\s\S]*?)<\/script>/u.exec(html);
  if (!match?.[1]?.trim())
    throw new Error(`${file} holds no bake-off record (did the page finish?)`);
  return { json: match[1], browserArgs: null, executable: null };
}

/** Non-blank, non-comment source lines: a rough, comparable measure of each adapter's code. */
async function codeLines(files) {
  let lines = 0;
  for (const file of files) {
    const source = await readFile(path.join(root, file), "utf8");
    lines += source
      .split("\n")
      .filter((line) => line.trim() && !/^\s*(\/\/|\/\*|\*)/u.test(line)).length;
  }
  return lines;
}

/**
 * One measurement: either serve the page and open it with `launch`, or read `fromDom`; then write
 * results.json, the screenshots and report.html into `out`. Resolves with the record.
 * @param {{ out: string, label?: string, fromDom?: string, launch?: (url: string) => Promise<Launched>,
 *   candidates?: string, frames?: number | string, rafFrames?: number | string, warmup?: number | string, panFrames?: number | string,
 *   host?: string, timeoutMs?: number | string }} options
 */
export async function measure(options) {
  const { json, browserArgs, executable } = options.fromDom
    ? await fromDom(options.fromDom)
    : await servePage(options, options.launch);
  const record = JSON.parse(json);
  if (record.fatal) throw new Error(`the page failed: ${record.fatal}`);
  const out = path.resolve(options.out);
  await mkdir(out, { recursive: true });
  const bundles = JSON.parse(await readFile(path.join(dist, "bundles.json"), "utf8"));
  const host = {
    label: options.label ?? "",
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? "unknown",
    memoryBytes: os.totalmem(),
    measuredBy: options.fromDom ? "dumped DOM" : "served page",
  };
  for (const candidate of record.candidates) {
    const renderer = candidate.description?.rendererString ?? "";
    candidate.host = host;
    candidate.browser = { userAgent: record.device.userAgent, executable };
    // A dumped DOM comes from --virtual-time-budget, whose clock is virtual: never performance.
    const why = !renderer
      ? "no renderer"
      : SOFTWARE.test(renderer)
        ? "software renderer"
        : options.fromDom
          ? "dumped DOM (virtual clock)"
          : record.page.clock.suspect
            ? "suspect clock"
            : null;
    candidate.performance = why === null;
    candidate.performanceNote =
      why === null ? "hardware renderer, real clock" : `not a performance number: ${why}`;
    candidate.bundle = {
      candidate: bundles[candidate.candidate] ?? null,
      sharedHarness: bundles.harness ?? null,
    };
    candidate.codeLines = SOURCES[candidate.candidate]
      ? await codeLines(SOURCES[candidate.candidate])
      : null;
    for (const [key, dataUrl] of Object.entries(candidate.screenshots)) {
      const file = `${candidate.candidate}-${key.replace("/", "-")}.png`;
      await writeFile(path.join(out, file), Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));
      candidate.screenshots[key] = file;
    }
  }
  record.host = host;
  record.browserArgs = browserArgs;
  record.missing = [
    "integrated GPU: not measured yet (real device needed)",
    "phone: not measured yet (real device needed)",
  ];
  await writeFile(path.join(out, "results.json"), `${JSON.stringify(record, null, 2)}\n`);

  const escapeHtml = (text) =>
    String(text).replace(
      /[&<>"]/gu,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const rows = record.candidates
    .map((c) => {
      const runs = c.runs
        .map(
          (r) =>
            `<tr><td>${r.state}</td><td>${r.tier}</td><td>${r.frameMs.p50}</td><td>${r.frameMs.p95}</td><td>${r.panFrameMs?.p50 ?? "none"}</td><td>${r.panFrameMs?.p95 ?? "none"}</td><td>${r.rafIntervalMs?.p50 ?? "none"}</td></tr>`,
        )
        .join("");
      const shots = Object.entries(c.screenshots)
        .filter(([key]) => key.endsWith("/high"))
        .map(([key, file]) => `<figure><img src="${file}"><figcaption>${key}</figcaption></figure>`)
        .join("");
      return `<section><h2>${escapeHtml(c.candidate)}</h2>
  <p>${escapeHtml(c.description?.api ?? "no api")} · ${escapeHtml(c.description?.rendererString ?? c.error ?? "")} · ${escapeHtml(c.performanceNote)}</p>
  <p>bundle ${c.bundle.candidate?.gzipBytes ?? "?"} B gzip · ${c.codeLines ?? "?"} code lines · est. GPU ${c.description?.estimatedGpuBytes ?? "?"} B</p>
  <div class="row">${shots}</div>
  <table><tr><th>state</th><th>tier</th><th>frame p50 ms</th><th>frame p95 ms</th><th>pan p50 ms</th><th>pan p95 ms</th><th>rAF p50 ms</th></tr>${runs}</table></section>`;
    })
    .join("\n");
  await writeFile(
    path.join(out, "report.html"),
    `<!doctype html><meta charset="utf-8"><title>Renderer bake-off</title>
  <style>body{font:14px system-ui;margin:1rem}img{width:480px}.row{display:flex;gap:8px;flex-wrap:wrap}td,th{padding:2px 8px;text-align:right}</style>
  <h1>Renderer bake-off</h1><p>${escapeHtml(host.label)} · ${escapeHtml(host.platform)} · ${escapeHtml(host.cpu)} · ${escapeHtml(record.device.userAgent)}</p>
  <p>Missing: ${record.missing.map(escapeHtml).join("; ")}</p>
  ${rows}\n`,
  );
  console.log(
    JSON.stringify(
      record.candidates.map((c) => ({
        candidate: c.candidate,
        api: c.description?.api,
        renderer: c.description?.rendererString,
        performance: c.performance,
        error: c.error,
      })),
    ),
  );
  console.log(`wrote ${path.join(out, "results.json")}`);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      browser: { type: "string" },
      "browser-arg": { type: "string", multiple: true, default: [] },
      "from-dom": { type: "string" },
      out: { type: "string" },
      candidates: { type: "string" },
      frames: { type: "string" },
      "raf-frames": { type: "string" },
      warmup: { type: "string" },
      "pan-frames": { type: "string" },
      label: { type: "string", default: "" },
      host: { type: "string", default: "127.0.0.1" },
      "timeout-ms": { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
    },
  });
  if (!values.out || Boolean(values.browser) === Boolean(values["from-dom"])) {
    console.error(
      "usage: measure.mjs (--browser <exe> [--browser-arg <flag>]... | --from-dom <dump.html>) --out <dir> [--candidates a,b] [--frames n] [--label text]",
    );
    process.exit(2);
  }
  await measure({
    out: values.out,
    label: values.label,
    fromDom: values["from-dom"],
    launch: values.browser ? spawnLauncher(values.browser, values["browser-arg"]) : undefined,
    candidates: values.candidates,
    frames: values.frames,
    rafFrames: values["raf-frames"],
    warmup: values.warmup,
    panFrames: values["pan-frames"],
    host: values.host,
    timeoutMs: values["timeout-ms"],
  });
}
