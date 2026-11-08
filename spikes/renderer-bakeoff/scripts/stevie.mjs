#!/usr/bin/env node
// Issue 77's comparison report (README, "3D Stevie"). Serves dist/stevie.html with the identity sheet and
// any generated model from the git-ignored media/ directory, opens it in a browser, receives the page's
// record by POST and writes, into --out (outside git):
//   <arm>-<state>-<shot>.png for every shot, atlas-*.png for the baked and cut atlases,
//   results.json (metrics, timings, renderer, and the sha256 and provenance of every generated file),
//   report.html (each arm beside the reference mockup).
// Nothing it writes is committed; the report and results.json are the record of hashes and provenance.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { SOFTWARE, spawnLauncher } from "./measure.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
const media = path.join(root, "media");
const reference = path.resolve(root, "../../docs/design/reference");
const SHEET = path.join(reference, "jimothy-sprite-sheet.png");
const MOCKUP = path.join(reference, "raccoon-world-reference.png");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".png": "image/png",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
};
/**
 * Decision: 20 minutes covers 3 arms × 2 states × 18 shots plus timing at SwiftShader's pace; each generated
 * model adds two arms, so 400 s an arm.
 */
const DEFAULT_TIMEOUT_MS = 1_200_000;
const ARM_TIMEOUT_MS = 400_000;
/** The issue's spend cap for all generation in this spike, reserved before each call. */
const SPEND_CAP_USD = 10;
/** What the generation run found about the services (plan comment, assumptions 1 and 12). */
const SERVICE_FINDINGS = [
  "Vercel AI Gateway (AI_GATEWAY_API_KEY): its /v1/models catalogue lists image models (openai/gpt-image-*, Gemini image, FLUX and others) and no image-to-3D or rigging model; the turnaround used openai/gpt-image-2 through /v1/images/edits, costed from the gateway's /v1/credits balance",
  "Anthropic: no image-to-3D, rigging or image-generation model; no key in the run",
  "OpenAI directly: not available or needed (the owner's decision: GPT-image through AI Gateway)",
  "fal.ai (FAL_KEY, the owner's choice): TRELLIS.2 image-to-3D at fal-ai/trellis-2 and fal-ai/trellis-2/multi; no quadruped rigger (its one rigging endpoint is Meshy's humanoid rig). fal.ai's web pages and billing API are outside the run's egress allowance, so its price is the listed per-call price and its licence terms are a maintainer check",
  "Meshy (MESHY_API_KEY, the owner's choice): multi-image-to-3D and rigging; credits measured exactly from /openapi/v1/balance. Its auto-rig is a humanoid skeleton and its walk a human walk",
  "Tripo (TRIPO_API_KEY, the owner's third route): multiview-to-model with smart_low_poly, the free rig-check (riggable, quadruped), the quadruped rig and its preset quadruped walk; credits are each task's credits_consumed. Files come from openapi-dl.data.tripo3d.com, a host its docs do not name; the sandbox refused it until the owner allowed it",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"]/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

async function serve(options, launch) {
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
    const pathname = new URL(request.url ?? "/", "http://x").pathname;
    const file =
      pathname === "/sheet.png"
        ? SHEET
        : pathname.startsWith("/media/")
          ? path.join(media, path.basename(pathname))
          : path.join(dist, path.basename(pathname) || "stevie.html");
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise((resolve) => server.listen(0, host, resolve));
  const query = new URLSearchParams({ report: "/result" });
  if (options.timedFrames) query.set("timedFrames", String(options.timedFrames));
  const models = options.models ?? [];
  if (models.length) query.set("models", JSON.stringify(models));
  let timer;
  let launched;
  try {
    launched = await launch(`http://${host}:${server.address().port}/stevie.html?${query}`);
    const timeout = new Promise((resolve) => {
      timer = setTimeout(
        resolve,
        Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS + models.length * 2 * ARM_TIMEOUT_MS),
      );
    });
    const outcome = await Promise.race([
      received.then((json) => ({ json })),
      launched.failed.then((error) => ({ error })),
      timeout.then(() => ({ error: "timed out" })),
    ]);
    if (outcome.error !== undefined) throw new Error(`no result from the page: ${outcome.error}`);
    return {
      json: outcome.json,
      executable: launched.executable,
      browserArgs: launched.browserArgs,
    };
  } finally {
    clearTimeout(timer);
    await launched?.close();
    server.close();
  }
}

/** media/provenance.json, written by generate.mjs: calls, files and the models kept for the report. */
async function ledger() {
  return JSON.parse(
    await readFile(path.join(media, "provenance.json"), "utf8").catch(
      () => '{"files":{},"calls":[]}',
    ),
  );
}

/** media/ship.json, written by ship.mjs: raw and shipped counts, validator and guideline results. */
async function shipReport() {
  return JSON.parse(await readFile(path.join(media, "ship.json"), "utf8").catch(() => "{}"));
}

/**
 * The kept generated models, as the page's `models` parameter (GeneratedModel in src/stevie/model.ts): the
 * shipped, reduced GLB from ship.mjs where it exists (the owner compares likeness at the reduced count), else
 * the provider's file.
 */
async function keptModels() {
  const book = await ledger();
  const ship = await shipReport();
  return Object.entries(book.models ?? {}).map(([name, m]) => {
    const shipped = ship.models?.[name]?.files ?? {};
    const glb = shipped.model?.shipped.file ?? m.glb;
    const walk = shipped.walk?.shipped.file ?? m.walk;
    return { name, rig: m.rig, url: `media/${glb}`, ...(walk ? { walkUrl: `media/${walk}` } : {}) };
  });
}

/** Every file in media/ with its hash, joined to media/provenance.json's entry for it. */
async function generatedFiles() {
  const names = await readdir(media).catch(() => []);
  const provenance = await ledger();
  const files = [];
  for (const name of names
    .filter((n) => !["provenance.json", "ship.json", ".tools"].includes(n))
    .sort()) {
    const bytes = await readFile(path.join(media, name));
    files.push({
      file: `media/${name}`,
      sha256: sha256(bytes),
      bytes: bytes.length,
      provenance: provenance.files?.[name] ?? null,
    });
  }
  return files;
}

async function writePng(out, file, dataUrl) {
  const bytes = Buffer.from(String(dataUrl).split(",")[1] ?? "", "base64");
  await writeFile(path.join(out, file), bytes);
  return { file, sha256: sha256(bytes), bytes: bytes.length };
}

/**
 * One run: serve the page, open it with `launch(url)`, then write the shots, results.json and report.html
 * into `out`. Resolves with the record.
 * @param {{ out: string, label?: string, launch: (url: string) => Promise<any>, host?: string,
 *   timeoutMs?: number | string, timedFrames?: number | string }} options
 */
export async function stevieReport(options) {
  const models = options.models ?? (await keptModels());
  const { json, executable, browserArgs } = await serve({ ...options, models }, options.launch);
  const record = JSON.parse(json);
  if (record.fatal) throw new Error(`the page failed: ${record.fatal}`);
  const out = path.resolve(options.out);
  await mkdir(out, { recursive: true });
  record.host = {
    label: options.label ?? "",
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? "unknown",
  };
  record.browser = { executable, browserArgs };
  for (const arm of record.arms) {
    const renderer = arm.description?.rendererString ?? "";
    arm.performance = Boolean(renderer) && !SOFTWARE.test(renderer);
    arm.performanceNote = arm.performance
      ? `hardware renderer on ${record.host.label || "this host"}`
      : `not a performance number: ${renderer ? "software renderer" : "no renderer"}`;
    for (const [key, dataUrl] of Object.entries(arm.shots))
      arm.shots[key] = await writePng(out, `${arm.arm}-${key.replace("/", "-")}.png`, dataUrl);
  }
  for (const [name, dataUrl] of Object.entries(record.atlases ?? {}))
    record.atlases[name] = await writePng(out, `atlas-${name}.png`, dataUrl);
  const sheet = await readFile(SHEET);
  const mockup = await readFile(MOCKUP);
  const generated = await generatedFiles();
  const book = await ledger();
  record.provenance = {
    inputs: [
      {
        file: "docs/design/reference/jimothy-sprite-sheet.png",
        sha256: sha256(sheet),
        bytes: sheet.length,
      },
      {
        file: "docs/design/reference/raccoon-world-reference.png",
        sha256: sha256(mockup),
        bytes: mockup.length,
      },
    ],
    models: [
      {
        name: "stand-in",
        file: "src/stevie/model.ts",
        model: "procedural stand-in (code)",
        provider: "none",
        parameters: "none",
        costUsd: 0,
      },
      ...Object.entries(book.models ?? {}).map(([name, m]) => ({
        name,
        ...m,
        files: generated.filter((f) =>
          [m.glb, m.walk, `ship-${name}.glb`, `ship-${name}-walk.glb`].includes(
            path.basename(f.file),
          ),
        ),
      })),
    ],
    generated,
    ship: await shipReport(),
    calls: book.calls ?? [],
    spend: {
      capUsd: SPEND_CAP_USD,
      spentUsd:
        Math.round(
          (book.calls ?? []).reduce((sum, c) => sum + Number(c.costUsd ?? c.reservedUsd ?? 0), 0) *
            1e4,
        ) / 1e4,
    },
    services: SERVICE_FINDINGS,
    outputs: "every PNG in this directory, with its sha256 in arms[].shots and atlases",
  };
  await writeFile(path.join(out, "results.json"), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(path.join(out, "report.html"), reportHtml(record, out));
  console.log(
    JSON.stringify(
      record.arms.map((a) => ({
        arm: a.arm,
        error: a.error,
        renderer: a.description?.rendererString,
        performance: a.performance,
      })),
    ),
  );
  console.log(`wrote ${path.join(out, "report.html")}`);
  return record;
}

function reportHtml(record, out) {
  const mockup = path.relative(out, MOCKUP).split(path.sep).join("/");
  const img = (shot, caption) =>
    shot
      ? `<figure><img src="${shot.file}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`
      : "";
  const sections = record.states
    .map((state) => {
      const rows = record.arms
        .map((arm) => {
          const stills = record.shots
            .filter((s) => s.startsWith("still-"))
            .map((s) => img(arm.shots[`${state}/${s}`], s));
          const walk = record.shots
            .filter((s) => s.startsWith("walk-"))
            .map((s) => img(arm.shots[`${state}/${s}`], s));
          return `<h3>${escapeHtml(arm.arm)}</h3><div class="row">${stills.join("")}</div><div class="row small">${walk.join("")}</div>`;
        })
        .join("");
      const cohesion = record.arms
        .map((arm) => img(arm.shots[`${state}/cohesion`], `${arm.arm}: Stevie, Juniper, kit`))
        .join("");
      return `<section><h2>${escapeHtml(state)}</h2>
<div class="row"><figure><img class="wide" src="${mockup}"><figcaption>reference mockup</figcaption></figure></div>
<h3>Cohesion shot</h3><div class="row wide">${cohesion}</div>${rows}</section>`;
    })
    .join("\n");
  const rel = (file) => path.relative(out, file).split(path.sep).join("/");
  const turnaround = record.provenance.generated.some((g) => g.file === "media/turnaround.png")
    ? `<figure><img class="wide" src="${rel(path.join(media, "turnaround.png"))}"><figcaption>Stevie's approved reference: the GPT-image turnaround (media/turnaround.png); every 3D route starts from it and is judged against it</figcaption></figure>`
    : "<p>no turnaround generated</p>";
  const identity = `<p>The 2D arm uses Jimothy's sheet because no Stevie sprite sheet exists yet, so the 2D and 3D arms show different characters. Judge each arm on technique (lighting, cohesion, animation), not on matching each other; judge 3D likeness against the turnaround.</p>
<div class="row">${turnaround}<figure><img class="wide" src="${rel(SHEET)}"><figcaption>Jimothy's sheet (the 2D arm's frames)</figcaption></figure></div>`;
  const ship = record.provenance.ship?.models ?? {};
  const g = (f) => f.guidelines.map((x) => `${x.item}: ${x.pass ? "pass" : "FAIL"}`).join("; ");
  const v = (x) => `${x.errors} errors, ${x.warnings} warnings`;
  const candidates = Object.entries(record.provenance.ship?.candidates ?? {}).map(([n, e]) => [
    `candidate ${n}`,
    e,
  ]);
  const shipRows = [...Object.entries(ship), ...candidates]
    .flatMap(([name, entry]) =>
      Object.entries(entry.files).map(([kind, f]) => [
        `${name} (${kind})`,
        `${f.raw.triangles} → ${f.shipped.triangles}`,
        `${f.raw.bytes} → ${f.shipped.bytes}`,
        f.shipped.textures.map((t) => `${t.slot} ${t.width}×${t.height}`).join(", "),
        `${f.raw.joints} / ${f.shipped.joints}`,
        `raw: ${v(f.raw.validator)}; prepared geometry (before KTX2 and meshopt): ${f.prepared ? v(f.prepared.validator) : "not run"}; shipped: ${v(f.shipped.validator)}`,
        `as delivered: ${f.raw.guidelines ? g({ guidelines: f.raw.guidelines }) : "not run"}. Shipped: ${g(f)}`,
        JSON.stringify(f.shipped.minutes),
      ]),
    )
    .map((cells) => `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  const kept = Object.fromEntries(record.provenance.models.map((m) => [m.name, m]));
  const modelRows = (record.models ?? [])
    .map((model) => {
      const m = model.metrics ?? {};
      const files = kept[model.name]?.files ?? [];
      const cost = files.map((f) => Number(f.provenance?.costUsd ?? 0));
      const cells = [
        model.name,
        model.rig ?? "stand-in",
        `${m.triangles ?? "?"} / ${m.vertices ?? "?"}`,
        `${m.joints ?? "?"} (${m.maxInfluencesPerVertex ?? "?"} per vertex)`,
        JSON.stringify(m.textures ?? []),
        m.fur ?? "",
        `${m.rigNotes ?? ""}; clips ${JSON.stringify(m.clips ?? [])}`,
        JSON.stringify(model.stepMs ?? {}),
        cost.length ? `$${Math.max(...cost)} (the generation call)` : "$0",
        `${kept[model.name]?.why ?? ""}${model.error ?? ""}`,
      ];
      return `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`;
    })
    .join("");
  const armRows = record.arms
    .map(
      (a) =>
        `<tr><td>${escapeHtml(a.arm)}</td><td>${escapeHtml(JSON.stringify(a.stepMs))}</td><td>${a.frameMs?.["dusk-rain"]?.p50 ?? "?"} / ${a.frameMs?.night?.p50 ?? "?"}</td><td>${escapeHtml(a.performanceNote)}</td><td>${escapeHtml(a.error ?? "")}</td><td>${a.notes.map(escapeHtml).join("<br>")}</td></tr>`,
    )
    .join("");
  const atlases = Object.values(record.atlases ?? {})
    .map((a) => img(a, a.file))
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>3D Stevie spike</title>
<style>body{font:14px system-ui;margin:1rem}img{width:240px}img.wide,.wide img{width:480px}.small img{width:120px}.row{display:flex;gap:6px;flex-wrap:wrap}td,th{padding:2px 8px;vertical-align:top;text-align:left}figure{margin:0}</style>
<h1>3D Stevie spike (issue 77)</h1>
<p>${escapeHtml(record.host.label)} · ${escapeHtml(record.host.platform)} · ${escapeHtml(record.host.cpu)} · ${escapeHtml(record.device.userAgent)} · renderer ${escapeHtml(record.arms[0]?.description?.rendererString ?? "?")}</p>
<h2>Identity check</h2>${identity}
<h2>Models</h2><p>Generation spend: $${record.provenance.spend.spentUsd} of $${record.provenance.spend.capUsd}; every call is in Provenance below.</p>
<table><tr><th>model</th><th>rig</th><th>triangles / vertices</th><th>joints</th><th>textures</th><th>fur</th><th>rig and clips</th><th>steps on this page (ms)</th><th>generation cost</th><th>why kept</th></tr>${modelRows}</table>
<h2>Ship form (glTF 2.0: KTX2, meshopt, XMP provenance)</h2><p>Budget ${escapeHtml(record.provenance.ship?.budgetTriangles ?? "?")} triangles; the page renders the shipped files. The Khronos validator does not decode EXT_meshopt_compression or KHR_texture_basisu, so the geometry the ship step rewrote (simplified, smooth normals, scaled, named) is validated as a prepared GLB before those two transforms; the shipped column only checks the container. The guidelines run on each file as the provider delivered it and on the shipped file; scale and naming pass on the shipped file by construction. Candidates are the generated meshes not kept for the arms.</p>
<table><tr><th>file</th><th>triangles raw → shipped</th><th>bytes</th><th>textures</th><th>joints raw / shipped</th><th>Khronos glTF Validator</th><th>Asset Creation Guidelines items</th><th>ship minutes</th></tr>${shipRows}</table>
<table><tr><th>arm</th><th>preparation steps (ms)</th><th>frame p50 ms dusk / night</th><th>timing</th><th>error</th><th>notes</th></tr>${armRows}</table>
<h2>Provenance</h2><pre>${escapeHtml(JSON.stringify(record.provenance, null, 2))}</pre>
${sections}
<h2>Atlases</h2><div class="row wide">${atlases}</div>\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      browser: { type: "string" },
      "browser-arg": { type: "string", multiple: true, default: [] },
      out: { type: "string" },
      label: { type: "string", default: "" },
      host: { type: "string", default: "127.0.0.1" },
      "timed-frames": { type: "string" },
      "timeout-ms": { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
    },
  });
  if (!values.out || !values.browser) {
    console.error(
      "usage: stevie.mjs --browser <exe> [--browser-arg <flag>]... --out <dir> [--label text]",
    );
    process.exit(2);
  }
  await stevieReport({
    out: values.out,
    label: values.label,
    launch: spawnLauncher(values.browser, values["browser-arg"]),
    host: values.host,
    timedFrames: values["timed-frames"],
    timeoutMs: values["timeout-ms"],
  });
}
