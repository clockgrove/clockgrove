#!/usr/bin/env node
// Issue 77's generation step (README, "Generating the models"). Every output goes to the git-ignored
// media/ directory, and media/provenance.json records each call: provider, model, endpoint, parameters,
// the cost reserved before the call against the $10 cap, the cost after it and how it was measured,
// minutes, and the sha256 of every file written. Keys come from the environment and are never printed.
//
//   node scripts/generate.mjs turnaround            GPT-image edit through Vercel AI Gateway
//   node scripts/generate.mjs fal <candidate>       TRELLIS.2 on fal.ai (candidates below)
//   node scripts/generate.mjs meshy                 Meshy multi-image-to-3D, then Meshy's auto-rig
//   node scripts/generate.mjs keep <name> <provider|fit> <glb> [walk=<glb>] <why…>
//                                                   names a generated model for the report to render
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cropRgba, decodePng, encodePng } from "./png.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const media = path.join(root, "media");
const LEDGER = path.join(media, "provenance.json");
const SHEET = path.resolve(root, "../../docs/design/reference/stevie-sprite-sheet.png");
/** The issue's cap for all generation in this spike; each call reserves its cost first. */
const CAP_USD = 10;
/** Decision: polls every 5 s and gives up after 20 minutes per job (TRELLIS.2 and Meshy take minutes). */
const POLL_MS = 5_000;
const JOB_LIMIT_MS = 1_200_000;

const GATEWAY = "https://ai-gateway.vercel.sh/v1";
const TURNAROUND_MODEL = "openai/gpt-image-2";
/** The turnaround's 2×2 layout; generate.mjs crops each view from its quadrant. */
export const VIEWS = ["front", "three-quarter", "side", "back"];
const TURNAROUND_PROMPT = [
  "The attached sprite sheet is the identity reference for Stevie, a raccoon character.",
  "Draw a clean character turnaround of the same raccoon for 3D modelling: four full-body views of him in one",
  "2x2 grid, each view centred in its own quarter of the image with a wide margin: top-left FRONT view (facing the viewer),",
  "top-right THREE-QUARTER front view (facing front-left), bottom-left SIDE profile (facing left), bottom-right BACK view.",
  "Neutral standing pose on all four legs, legs straight and apart, all four paws visible on one ground line,",
  "tail held out behind and slightly down, not crossing the body. Same size and scale in every view.",
  "Flat, even, shadowless studio light: no cast shadows, no ground shadow, no rim light, no orange fringe.",
  "Plain uniform light grey background. No text, no numbers, no labels, no grid lines.",
  "Keep his identity exactly: the black eye mask with white brows and muzzle, the ringed tail with dark brown and tan",
  "bands, grey-brown fur with a lighter tan underside, dark brown legs and paws, his round chubby proportions and",
  "rounded ears. Soft painterly storybook illustration style with fine fur texture.",
].join(" ");

/** fal.ai TRELLIS.2 candidates (the owner asked for a few, keeping the best). */
const FAL_CANDIDATES = {
  multi: {
    endpoint: "fal-ai/trellis-2/multi",
    views: VIEWS,
    parameters: { resolution: 1024, texture_size: 2048, decimation_target: 50_000, seed: 1 },
  },
  "three-quarter": {
    endpoint: "fal-ai/trellis-2",
    views: ["three-quarter"],
    parameters: { resolution: 1024, texture_size: 2048, decimation_target: 50_000, seed: 1 },
  },
  "three-quarter-1536": {
    endpoint: "fal-ai/trellis-2",
    views: ["three-quarter"],
    parameters: { resolution: 1536, texture_size: 2048, decimation_target: 50_000, seed: 2 },
  },
};
/**
 * fal's listed TRELLIS.2 price per generation by resolution, reserved before each call. fal's pricing
 * page and billing API are not reachable from the sandbox, so this is the reservation, not a measurement.
 */
const FAL_PRICE_USD = { 512: 0.25, 1024: 0.3, 1536: 0.35 };
const MESHY = "https://api.meshy.ai/openapi/v1";
/** Meshy credits valued at its Pro plan's $20 per 1,000 (an estimate; credits are measured exactly). */
const MESHY_USD_PER_CREDIT = 0.02;
/** Reserved credits: multi-image-to-3D with texture plus the rig (the owner's "about 35"), with margin. */
const MESHY_RESERVE_CREDITS = 45;
/** The stand-in's height, so the provider's rig is built at the scene's scale. */
const STEVIE_HEIGHT_M = 0.53;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const minutesSince = (start) => Math.round((Date.now() - start) / 600) / 100;
const dataUrl = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
function key(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function ledger() {
  const text = await readFile(LEDGER, "utf8").catch(() => null);
  return text ? JSON.parse(text) : { capUsd: CAP_USD, calls: [], files: {} };
}
const saveLedger = (book) => writeFile(LEDGER, `${JSON.stringify(book, null, 2)}\n`);
const committed = (book) =>
  book.calls.reduce((sum, c) => sum + Number(c.costUsd ?? c.reservedUsd ?? 0), 0);

/** Reserves `usd` against the cap (refusing past it), runs `work`, then records cost and files. */
async function call(entry, work) {
  await mkdir(media, { recursive: true });
  const book = await ledger();
  const after = committed(book) + entry.reservedUsd;
  if (after > CAP_USD + 1e-9)
    throw new Error(
      `refused: reserving $${entry.reservedUsd} would commit $${after.toFixed(2)} of $${CAP_USD}`,
    );
  const record = { ...entry, startedAt: new Date().toISOString(), status: "reserved" };
  book.calls.push(record);
  await saveLedger(book);
  console.log(
    `${entry.id}: reserved $${entry.reservedUsd}; $${after.toFixed(2)} of $${CAP_USD} committed`,
  );
  const start = Date.now();
  try {
    const result = await work();
    Object.assign(record, result.record, { status: "done", minutes: minutesSince(start) });
    for (const [name, bytes] of Object.entries(result.files)) {
      await writeFile(path.join(media, name), bytes);
      book.files[name] = {
        call: entry.id,
        provider: entry.provider,
        model: entry.model,
        parameters: entry.parameters,
        costUsd: record.costUsd,
        sha256: sha256(bytes),
        bytes: bytes.length,
        steps: [{ step: entry.step, minutes: record.minutes }],
        ...(result.fileNotes?.[name] ?? {}),
      };
      console.log(`${entry.id}: wrote media/${name} (${bytes.length} bytes)`);
    }
  } catch (error) {
    // A failed call keeps its reservation: the provider may still have charged it.
    Object.assign(record, {
      status: "failed",
      minutes: minutesSince(start),
      error: String(error.message ?? error).slice(0, 500),
    });
    throw error;
  } finally {
    await saveLedger(book);
  }
  return record;
}

async function json(response, what) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}
async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${new URL(url).host}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
async function viewBytes(view) {
  return readFile(path.join(media, `turnaround-${view}.png`)).catch(() => {
    throw new Error(`media/turnaround-${view}.png is missing: run the turnaround step first`);
  });
}

async function gatewayBalance(token) {
  const body = await json(
    await fetch(`${GATEWAY}/credits`, { headers: { authorization: `Bearer ${token}` } }),
    "gateway credits",
  );
  return Number(body.balance);
}

async function turnaround() {
  const token = key("AI_GATEWAY_API_KEY");
  const sheet = await readFile(SHEET);
  const parameters = { size: "1536x1024", quality: "high", n: 1, prompt: TURNAROUND_PROMPT };
  return call(
    {
      id: `turnaround-${Date.now()}`,
      step: "turnaround (image generation)",
      provider: "Vercel AI Gateway",
      model: TURNAROUND_MODEL,
      endpoint: `${GATEWAY}/images/edits`,
      parameters: {
        ...parameters,
        image: `docs/design/reference/stevie-sprite-sheet.png sha256 ${sha256(sheet)}`,
      },
      reservedUsd: 0.5,
    },
    async () => {
      const before = await gatewayBalance(token);
      const body = await json(
        await fetch(`${GATEWAY}/images/edits`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: TURNAROUND_MODEL,
            images: [{ image_url: dataUrl(sheet) }],
            ...parameters,
          }),
        }),
        "images/edits",
      );
      const b64 = body.data?.[0]?.b64_json;
      const png = b64 ? Buffer.from(b64, "base64") : await download(body.data?.[0]?.url);
      // The gateway's balance can lag the call by a few seconds.
      await sleep(10_000);
      const spent = Math.max(0, before - (await gatewayBalance(token)));
      const image = decodePng(png);
      const files = { "turnaround.png": png };
      const w = Math.floor(image.width / 2);
      const h = Math.floor(image.height / 2);
      VIEWS.forEach((view, i) => {
        files[`turnaround-${view}.png`] = encodePng(
          cropRgba(image, (i % 2) * w, Math.floor(i / 2) * h, w, h),
        );
      });
      return {
        record: {
          costUsd: Math.round(spent * 1e6) / 1e6,
          costBasis: "AI Gateway credit balance before and after the call",
          usage: body.usage ?? null,
        },
        files,
        fileNotes: Object.fromEntries(
          VIEWS.map((view, i) => [
            `turnaround-${view}.png`,
            { derivedFrom: "turnaround.png", quadrant: i },
          ]),
        ),
      };
    },
  );
}

/** Submits to fal's queue, polls until done, and returns the result body. */
async function falQueue(endpoint, input) {
  const headers = { authorization: `Key ${key("FAL_KEY")}`, "content-type": "application/json" };
  const submitted = await json(
    await fetch(`https://queue.fal.run/${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    }),
    "fal submit",
  );
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > JOB_LIMIT_MS)
      throw new Error(`fal ${submitted.request_id}: no result in time`);
    await sleep(POLL_MS);
    const status = await json(await fetch(submitted.status_url, { headers }), "fal status");
    console.log(`fal ${endpoint}: ${status.status} after ${minutesSince(start)} min`);
    if (status.status === "COMPLETED")
      return {
        requestId: submitted.request_id,
        result: await json(await fetch(submitted.response_url, { headers }), "fal result"),
      };
  }
}

/** Every `{ url }` file object in a provider's result, with a JSON path for its name. */
function fileUrls(value, at = []) {
  if (!value || typeof value !== "object") return [];
  if (typeof value.url === "string" && /^https:/u.test(value.url))
    return [{ at: at.join("."), url: value.url, name: value.file_name }];
  return Object.entries(value).flatMap(([k, v]) =>
    typeof v === "string" && /^https:.*\.(glb|fbx|png|jpg|jpeg|obj|usdz)(\?|$)/iu.test(v)
      ? [{ at: [...at, k].join("."), url: v }]
      : fileUrls(v, [...at, k]),
  );
}

async function fal(candidate) {
  const spec = FAL_CANDIDATES[candidate];
  if (!spec) throw new Error(`fal candidate is one of ${Object.keys(FAL_CANDIDATES).join(", ")}`);
  const images = await Promise.all(spec.views.map(viewBytes));
  const input = {
    ...spec.parameters,
    ...(spec.views.length > 1
      ? { image_urls: images.map(dataUrl) }
      : { image_url: dataUrl(images[0]) }),
  };
  return call(
    {
      id: `fal-${candidate}-${Date.now()}`,
      step: "image to 3D (fal.ai TRELLIS.2)",
      provider: "fal.ai",
      model: "TRELLIS.2 (microsoft/TRELLIS.2; MIT weights per its release)",
      endpoint: spec.endpoint,
      parameters: { ...spec.parameters, views: spec.views.map((v) => `media/turnaround-${v}.png`) },
      reservedUsd: FAL_PRICE_USD[spec.parameters.resolution],
      licence:
        "fal.ai's model page and terms are not reachable from the sandbox (egress allows only fal's API and media hosts); the maintainer re-checks them before relying on the licence",
    },
    async () => {
      const { requestId, result } = await falQueue(spec.endpoint, input);
      const files = {};
      for (const f of fileUrls(result)) {
        const ext = path.extname(new URL(f.url).pathname) || ".bin";
        files[`fal-${candidate}-${f.at.replace(/\W+/gu, "-")}${ext}`] = await download(f.url);
      }
      return {
        record: {
          requestId,
          costUsd: FAL_PRICE_USD[spec.parameters.resolution],
          costBasis:
            "fal's listed per-generation price (billing API not reachable from the sandbox)",
          result: JSON.parse(JSON.stringify(result, (k, v) => (k === "url" ? "(downloaded)" : v))),
        },
        files,
      };
    },
  );
}

async function meshyJob(kind, body) {
  const headers = {
    authorization: `Bearer ${key("MESHY_API_KEY")}`,
    "content-type": "application/json",
  };
  const created = await json(
    await fetch(`${MESHY}/${kind}`, { method: "POST", headers, body: JSON.stringify(body) }),
    `meshy ${kind}`,
  );
  const id = created.result;
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > JOB_LIMIT_MS)
      throw new Error(`meshy ${kind} ${id}: no result in time`);
    await sleep(POLL_MS);
    const task = await json(
      await fetch(`${MESHY}/${kind}/${id}`, { headers }),
      `meshy ${kind} status`,
    );
    console.log(
      `meshy ${kind}: ${task.status} ${task.progress ?? ""}% after ${minutesSince(start)} min`,
    );
    if (task.status === "SUCCEEDED") return { id, task, minutes: minutesSince(start) };
    if (task.status === "FAILED" || task.status === "CANCELED")
      throw new Error(
        `meshy ${kind} ${id}: ${task.status} ${JSON.stringify(task.task_error ?? {}).slice(0, 300)}`,
      );
  }
}
async function meshyBalance() {
  const body = await json(
    await fetch(`${MESHY}/balance`, {
      headers: { authorization: `Bearer ${key("MESHY_API_KEY")}` },
    }),
    "meshy balance",
  );
  return Number(body.balance);
}

async function meshy() {
  const images = await Promise.all(VIEWS.map(viewBytes));
  const modelParameters = {
    should_texture: true,
    should_remesh: true,
    topology: "triangle",
    target_polycount: 30_000,
  };
  return call(
    {
      id: `meshy-${Date.now()}`,
      step: "image to 3D and auto-rig (Meshy)",
      provider: "Meshy",
      model: "Meshy multi-image-to-3D (latest) + Meshy rigging",
      endpoint: `${MESHY}/multi-image-to-3d, ${MESHY}/rigging`,
      parameters: {
        ...modelParameters,
        views: VIEWS.map((v) => `media/turnaround-${v}.png`),
        rig: { height_meters: STEVIE_HEIGHT_M },
      },
      reservedUsd: MESHY_RESERVE_CREDITS * MESHY_USD_PER_CREDIT,
    },
    async () => {
      const before = await meshyBalance();
      const files = {};
      const steps = [];
      const model = await meshyJob("multi-image-to-3d", {
        image_urls: images.map(dataUrl),
        ...modelParameters,
      });
      steps.push({ step: "multi-image-to-3d", minutes: model.minutes, taskId: model.id });
      if (model.task.model_urls?.glb)
        files["meshy-model.glb"] = await download(model.task.model_urls.glb);
      let rig = null;
      try {
        rig = await meshyJob("rigging", {
          input_task_id: model.id,
          height_meters: STEVIE_HEIGHT_M,
        });
        steps.push({ step: "rigging", minutes: rig.minutes, taskId: rig.id });
        for (const f of fileUrls(rig.task.result ?? {})) {
          if (!/glb/iu.test(f.at)) continue;
          files[`meshy-rig-${f.at.replace(/_glb_url$/u, "").replace(/\W+/gu, "-")}.glb`] =
            await download(f.url);
        }
      } catch (error) {
        steps.push({ step: "rigging", error: String(error.message ?? error).slice(0, 400) });
      }
      const credits = before - (await meshyBalance());
      return {
        record: {
          credits,
          costUsd: Math.round(credits * MESHY_USD_PER_CREDIT * 100) / 100,
          costBasis: `Meshy credit balance before and after (exact credits), valued at $${MESHY_USD_PER_CREDIT} per credit (estimate)`,
          steps,
          textureUrls: model.task.texture_urls ? "(see the GLB)" : null,
        },
        files,
      };
    },
  );
}

/** Records which generated file the report renders as model `name`, how it is rigged, and why. */
async function keep(name, rig, glb, ...rest) {
  if (!name || !["provider", "fit"].includes(rig) || !glb)
    throw new Error("usage: keep <name> <provider|fit> <glb> [walk=<glb>] <why…>");
  const walk = rest[0]?.startsWith("walk=") ? rest.shift().slice(5) : undefined;
  const book = await ledger();
  for (const file of [glb, walk].filter(Boolean))
    if (!book.files[file]) throw new Error(`media/${file} is not a recorded generated file`);
  book.models = {
    ...book.models,
    [name]: { glb, rig, ...(walk ? { walk } : {}), why: rest.join(" ") },
  };
  await saveLedger(book);
  return { id: `keep ${name}`, status: "done", costUsd: 0, minutes: 0 };
}

const [step, arg, ...more] = process.argv.slice(2);
const steps = { turnaround, fal: () => fal(arg), meshy, keep: () => keep(arg, ...more) };
if (!steps[step]) {
  console.error(
    "usage: generate.mjs turnaround | fal <multi|three-quarter|three-quarter-1536> | meshy | keep …",
  );
  process.exit(2);
}
const record = await steps[step]();
console.log(
  JSON.stringify({
    id: record.id,
    status: record.status,
    costUsd: record.costUsd,
    minutes: record.minutes,
  }),
);
