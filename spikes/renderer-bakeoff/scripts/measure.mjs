#!/usr/bin/env node
// The bake-off measurement script (README, "Measuring"). Two ways in, one output:
//   measure.mjs --browser <exe> [--browser-arg <flag>]... --out <dir>
//     serves dist/ on a loopback port, starts the browser headless on the page with a real clock,
//     and receives the page's JSON record by POST;
//   measure.mjs --from-dom <dump.html> --out <dir>
//     reads the record a browser wrote into its DOM (`--headless=new --dump-dom file:///.../index.html`).
// Either way it writes results.json (every number with its host, browser and renderer string),
// one PNG per candidate, lighting state and tier, and report.html beside the reference mockup.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
const MOCKUP = path.resolve(root, "../../docs/design/reference/raccoon-world-reference.png");
/** Each candidate's adapter source, for the code-complexity count. */
const SOURCES = {
  phaser: ["src/candidates/phaser.ts"],
  "three-webgl2": ["src/candidates/three.ts", "src/candidates/three-webgl2.ts"],
  "three-webgpu": ["src/candidates/three.ts", "src/candidates/three-webgpu.ts"],
};
/** Renderer strings of software rasterisers: their numbers prove correctness, never performance. */
const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softpipe|software|microsoft basic render/iu;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

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
    label: { type: "string", default: "" },
    host: { type: "string", default: "127.0.0.1" },
    // Decision: 20 minutes covers 3 candidates × 6 runs × 160 frames at SwiftShader's ~0.3 s a frame.
    "timeout-ms": { type: "string", default: "1200000" },
  },
});
if (!values.out || (!values.browser && !values["from-dom"])) {
  console.error(
    "usage: measure.mjs (--browser <exe> [--browser-arg <flag>]... | --from-dom <dump.html>) --out <dir> [--candidates a,b] [--frames n] [--label text]",
  );
  process.exit(2);
}

/** Serves dist/ and resolves with the first POSTed record. */
async function runBrowser() {
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
  await new Promise((resolve) => server.listen(0, values.host, resolve));
  const query = new URLSearchParams({ report: "/result" });
  if (values.candidates) query.set("candidates", values.candidates);
  if (values.frames) query.set("frames", values.frames);
  if (values["raf-frames"]) query.set("rafFrames", values["raf-frames"]);
  if (values.warmup) query.set("warmup", values.warmup);
  const url = `http://${values.host}:${server.address().port}/index.html?${query}`;
  const extra = values["browser-arg"];
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
    url,
  ];
  const browser = spawn(values.browser, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  browser.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  const exited = new Promise((resolve) => browser.on("exit", resolve));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, Number(values["timeout-ms"]), "timeout");
  });
  try {
    const outcome = await Promise.race([received, exited.then(() => "exit"), timeout]);
    if (outcome === "timeout" || outcome === "exit")
      throw new Error(`no result from the page (${outcome}); browser stderr:\n${stderr}`);
    return { json: outcome, browserArgs: args.slice(0, -1) };
  } finally {
    clearTimeout(timer);
    browser.kill("SIGKILL");
    server.close();
    if (profile) await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function fromDom(file) {
  const html = await readFile(file, "utf8");
  const match = /<script[^>]*id="bakeoff-result"[^>]*>([\s\S]*?)<\/script>/u.exec(html);
  if (!match?.[1]?.trim())
    throw new Error(`${file} holds no bake-off record (did the page finish?)`);
  return { json: match[1], browserArgs: null };
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

const { json, browserArgs } = values["from-dom"]
  ? await fromDom(values["from-dom"])
  : await runBrowser();
const record = JSON.parse(json);
if (record.fatal) throw new Error(`the page failed: ${record.fatal}`);
const out = path.resolve(values.out);
await mkdir(out, { recursive: true });
const bundles = JSON.parse(await readFile(path.join(dist, "bundles.json"), "utf8"));
const host = {
  label: values.label,
  platform: `${os.platform()} ${os.release()}`,
  arch: os.arch(),
  cpu: os.cpus()[0]?.model ?? "unknown",
  memoryBytes: os.totalmem(),
  measuredBy: values["from-dom"] ? "dumped DOM" : "served page",
};
for (const candidate of record.candidates) {
  const renderer = candidate.description?.rendererString ?? "";
  candidate.host = host;
  candidate.browser = { userAgent: record.device.userAgent, executable: values.browser ?? null };
  candidate.performance =
    Boolean(renderer) && !SOFTWARE.test(renderer) && !record.page.clock.suspect;
  candidate.performanceNote = candidate.performance
    ? "hardware renderer, real clock"
    : `not a performance number: ${renderer ? (SOFTWARE.test(renderer) ? "software renderer" : "suspect clock") : "no renderer"}`;
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
const mockup = path.relative(out, MOCKUP).split(path.sep).join("/");
const rows = record.candidates
  .map((c) => {
    const runs = c.runs
      .map(
        (r) =>
          `<tr><td>${r.state}</td><td>${r.tier}</td><td>${r.frameMs.p50}</td><td>${r.frameMs.p95}</td><td>${r.rafIntervalMs?.p50 ?? "none"}</td></tr>`,
      )
      .join("");
    const shots = Object.entries(c.screenshots)
      .filter(([key]) => key.endsWith("/high"))
      .map(([key, file]) => `<figure><img src="${file}"><figcaption>${key}</figcaption></figure>`)
      .join("");
    return `<section><h2>${escapeHtml(c.candidate)}</h2>
<p>${escapeHtml(c.description?.api ?? "no api")} · ${escapeHtml(c.description?.rendererString ?? c.error ?? "")} · ${escapeHtml(c.performanceNote)}</p>
<p>bundle ${c.bundle.candidate?.gzipBytes ?? "?"} B gzip · ${c.codeLines ?? "?"} code lines · est. GPU ${c.description?.estimatedGpuBytes ?? "?"} B</p>
<div class="row"><figure><img src="${mockup}"><figcaption>reference mockup</figcaption></figure>${shots}</div>
<table><tr><th>state</th><th>tier</th><th>frame p50 ms</th><th>frame p95 ms</th><th>rAF p50 ms</th></tr>${runs}</table></section>`;
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
