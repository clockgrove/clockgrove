#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Issue 77's ship step (README, "Shipping the models"). The owner's standard for 3D outputs is glTF 2.0 / .glb with
// KHR_texture_basisu (KTX2: ETC1S for colour, UASTC for normal/ORM), EXT_meshopt_compression and KHR_xmp_json_ld
// provenance carrying IPTC digitalSourceType trainedAlgorithmicMedia. Whatever a 3D service returned is converted to that
// form here, validated with the Khronos glTF Validator before and after, and checked against the four Asset Creation
// Guidelines 2.0 items scripted below. Every output goes to the git-ignored media/ directory:
// media/ship-<name>.glb (and ship-<name>-walk.glb), plus media/ship.json with the evidence.
//
//   node scripts/ship.mjs              ship every model in media/provenance.json "models"
//   node scripts/ship.mjs <name>...    ship only the named models
//
// The tools are pinned below and installed into media/.tools on first use; they are not workspace dependencies.
// Triangle, vertex, joint and texture counts are read from the GLB's own JSON and KTX2 headers, independent of
// glTF-Transform, so they are evidence rather than a restatement of the tool's inspect.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const media = path.join(root, "media");
const tools = path.join(media, ".tools");
const LEDGER = path.join(media, "provenance.json");

/** Decision: one triangle budget for every model; the owner's range is roughly 5-20K. */
const BUDGET_TRIANGLES = 10_000;
/** Decision: textures above this are resized before encoding (Asset Creation Guidelines: at most 2048). */
const MAX_TEXTURE = 2048;
/** Decision: simplifier error is a fraction of mesh radius; generous so the triangle budget, not the error, binds. */
const SIMPLIFY_ERROR = 0.05;
/** The scene's Stevie is 0.53 m tall; guideline scale check accepts 0.2-1.0 m. */
const HEIGHT_RANGE_M = [0.2, 1.0];
/** Every shipped model is converted to this real height in metres (the scene's Stevie). */
const STEVIE_HEIGHT_M = 0.53;
const DIGITAL_SOURCE_TYPE =
  "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
const PINNED = {
  "@gltf-transform/core": "4.5.1",
  "@gltf-transform/extensions": "4.5.1",
  "@gltf-transform/functions": "4.5.1",
  meshoptimizer: "1.3.0",
  "gltf-validator": "2.0.0-dev.3.10",
  "ktx2-encoder": "0.6.0",
  sharp: "0.35.5",
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const minutes = (since) => Math.round(((performance.now() - since) / 60_000) * 100) / 100;

function installedVersion(name) {
  try {
    return JSON.parse(readFileSync(path.join(tools, "node_modules", name, "package.json"), "utf8"))
      .version;
  } catch {
    return undefined;
  }
}

async function installTools() {
  if (Object.entries(PINNED).every(([name, version]) => installedVersion(name) === version)) return;
  await mkdir(tools, { recursive: true });
  await writeFile(path.join(tools, "package.json"), '{"private":true}\n');
  const specs = Object.entries(PINNED).map(([name, version]) => `${name}@${version}`);
  const args = [
    "install",
    "--prefix",
    tools,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    ...specs,
  ];
  if (spawnSync("npm", args, { stdio: "inherit" }).status !== 0)
    throw new Error("npm install of the pinned tools failed");
}

/** Imports a pinned tool from media/.tools by resolving its ESM entry from there. */
async function importTool(specifier) {
  const resolved = createRequire(path.join(tools, "package.json")).resolve(specifier);
  return import(pathToFileURL(resolved).href);
}

async function importEsmTool(name, subpath = ".") {
  const dir = path.join(tools, "node_modules", name);
  const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  let entry = pkg.exports?.[subpath];
  if (entry && typeof entry === "object") {
    entry = entry.node?.import ?? entry.import ?? entry.default ?? entry.node;
    if (entry && typeof entry === "object") entry = entry.import ?? entry.default;
  }
  entry ??= pkg.module ?? pkg.main;
  return import(pathToFileURL(path.join(dir, entry)).href);
}

// ---------------------------------------------------------------------------------------------------------------
// Independent GLB reading: counts come from the file's JSON chunk and image headers, not from glTF-Transform.

function readGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binStart = 20 + jsonLength + 8;
  const binLength = view.getUint32(20 + jsonLength, true);
  return { json, bin: bytes.subarray(binStart, binStart + binLength) };
}

async function imageSize(image, mime, sharp) {
  if (mime === "image/ktx2") {
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    return { width: view.getUint32(20, true), height: view.getUint32(24, true) };
  }
  const meta = await sharp(image).metadata();
  return { width: meta.width, height: meta.height };
}

/** Maps each image index to the material slot names that use it, from the JSON alone. */
function textureSlots(json) {
  const slots = new Map();
  const use = (info, slot) => {
    if (!info) return;
    const texture = json.textures?.[info.index];
    const source = texture?.source ?? texture?.extensions?.KHR_texture_basisu?.source;
    if (source === undefined) return;
    slots.set(source, [...new Set([...(slots.get(source) ?? []), slot])]);
  };
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    use(pbr.baseColorTexture, "baseColor");
    use(pbr.metallicRoughnessTexture, "metallicRoughness");
    use(material.normalTexture, "normal");
    use(material.occlusionTexture, "occlusion");
    use(material.emissiveTexture, "emissive");
  }
  return slots;
}

async function measure(bytes, sharp) {
  const { json, bin } = readGlb(bytes);
  let triangles = 0;
  let vertices = 0;
  const positionAccessors = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const position = primitive.attributes.POSITION;
      positionAccessors.add(position);
      const count =
        primitive.indices === undefined
          ? json.accessors[position].count
          : json.accessors[primitive.indices].count;
      triangles += Math.floor(count / 3);
    }
  }
  for (const index of positionAccessors) vertices += json.accessors[index].count;
  const slots = textureSlots(json);
  const textures = [];
  for (const [index, image] of (json.images ?? []).entries()) {
    const view = json.bufferViews[image.bufferView];
    const data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    textures.push({
      slot: (slots.get(index) ?? ["unused"]).join("+"),
      mime: image.mimeType,
      ...(await imageSize(data, image.mimeType, sharp)),
    });
  }
  return {
    triangles,
    vertices,
    bytes: bytes.byteLength,
    textures,
    skins: json.skins?.length ?? 0,
    joints: (json.skins ?? []).reduce((sum, skin) => sum + skin.joints.length, 0),
    animations: json.animations?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Validation and guidelines.

async function validate(bytes, validator) {
  const report = await validator.validateBytes(new Uint8Array(bytes), {
    maxIssues: 50,
    externalResourceFunction: (uri) =>
      Promise.reject(new Error(`external resource ${uri} is not allowed in a GLB`)),
  });
  const { numErrors, numWarnings, numInfos, numHints } = report.issues;
  return {
    errors: numErrors,
    warnings: numWarnings,
    infos: numInfos,
    hints: numHints,
    first: report.issues.messages
      .slice(0, 5)
      .map(
        (m) =>
          `${m.severity === 0 ? "error" : m.severity === 1 ? "warning" : m.severity === 2 ? "info" : "hint"} ${m.code} ${m.pointer ?? ""}: ${m.message}`,
      ),
  };
}

const isPowerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0;

/** The four scripted Asset Creation Guidelines 2.0 items, evaluated on a glTF-Transform document read from the GLB. */
function checkGuidelines(document, core, functions, source) {
  const root = document.getRoot();
  const height = Math.round(bindPoseHeight(document) * 1000) / 1000;
  const guidelines = [];
  const note = source.metersAssumed
    ? "glTF is metres by definition; the source is taken as metres"
    : "";
  guidelines.push({
    item: "scale and units",
    pass: height >= HEIGHT_RANGE_M[0] && height <= HEIGHT_RANGE_M[1],
    detail: `bounding box height ${height} m (accept ${HEIGHT_RANGE_M.join("-")} m, the scene's Stevie is 0.53 m); ${note}`,
  });

  const unnamed = [];
  for (const [kind, list] of [
    ["node", root.listNodes()],
    ["mesh", root.listMeshes()],
    ["material", root.listMaterials()],
  ]) {
    for (const [i, item] of list.entries()) if (!item.getName()) unnamed.push(`${kind} ${i}`);
  }
  guidelines.push({
    item: "naming",
    pass: unnamed.length === 0,
    detail:
      unnamed.length === 0
        ? "every node, mesh and material is named"
        : `unnamed: ${unnamed.slice(0, 8).join(", ")}${unnamed.length > 8 ? ` (+${unnamed.length - 8})` : ""}`,
  });

  const uvProblems = [];
  let primitives = 0;
  let lo = [Infinity, Infinity];
  let hi = [-Infinity, -Infinity];
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitives++;
      const material = primitive.getMaterial();
      const textured =
        material &&
        (material.getBaseColorTexture() ||
          material.getNormalTexture() ||
          material.getEmissiveTexture() ||
          material.getOcclusionTexture() ||
          material.getMetallicRoughnessTexture());
      const uv = primitive.getAttribute("TEXCOORD_0");
      if (!uv) {
        if (textured) uvProblems.push(`${mesh.getName() || "mesh"} lacks TEXCOORD_0`);
        continue;
      }
      const min = uv.getMinNormalized([]);
      const max = uv.getMaxNormalized([]);
      lo = [Math.min(lo[0], min[0]), Math.min(lo[1], min[1])];
      hi = [Math.max(hi[0], max[0]), Math.max(hi[1], max[1])];
    }
  }
  const eps = 1e-3;
  if (lo[0] < -eps || lo[1] < -eps || hi[0] > 1 + eps || hi[1] > 1 + eps)
    uvProblems.push("UVs leave [0,1]");
  guidelines.push({
    item: "UVs",
    pass: uvProblems.length === 0,
    detail: `${primitives} primitives, TEXCOORD_0 range [${lo.map((n) => n.toFixed(3))}]-[${hi.map((n) => n.toFixed(3))}]${uvProblems.length ? `; ${uvProblems.join("; ")}` : ""}`,
  });

  const sizes = root.listTextures().map((texture) => ({
    name: texture.getName() || texture.getURI() || "texture",
    size: texture.getSize(),
  }));
  const badSizes = sizes.filter(
    ({ size }) =>
      !size || !isPowerOfTwo(size[0]) || !isPowerOfTwo(size[1]) || Math.max(...size) > MAX_TEXTURE,
  );
  guidelines.push({
    item: "texture sizes",
    pass: badSizes.length === 0,
    detail: `${sizes.map(({ size }) => (size ? size.join("x") : "unknown")).join(", ") || "no textures"} (power of two, at most ${MAX_TEXTURE})${badSizes.length ? `; failing: ${badSizes.map(({ name, size }) => `${name} ${size?.join("x")}`).join(", ")}` : ""}`,
  });
  return guidelines;
}

// ---------------------------------------------------------------------------------------------------------------
// The ship pipeline.

async function main() {
  await installTools();
  const core = await importEsmTool("@gltf-transform/core");
  const extensions = await importEsmTool("@gltf-transform/extensions");
  const functions = await importEsmTool("@gltf-transform/functions");
  const { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } =
    await importEsmTool("meshoptimizer");
  const validator = await importTool("gltf-validator");
  const { ktx2 } = await importEsmTool("ktx2-encoder", "./gltf-transform");
  const sharp = (await importEsmTool("sharp")).default;
  await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready, MeshoptDecoder.ready]);

  const ledger = JSON.parse(await readFile(LEDGER, "utf8"));
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(ledger.models ?? {});
  for (const name of names)
    if (!ledger.models?.[name]) throw new Error(`no model "${name}" in media/provenance.json`);

  const report = existsSync(path.join(media, "ship.json"))
    ? JSON.parse(await readFile(path.join(media, "ship.json"), "utf8"))
    : {};
  report.budgetTriangles = BUDGET_TRIANGLES;
  report.tools = PINNED;
  report.models ??= {};

  const io = new core.NodeIO()
    .registerExtensions(extensions.ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

  /** UASTC for data textures (normal in normal-map mode), ETC1S with sRGB transfer for colour. */
  const decode = async (buffer) => {
    let image = sharp(buffer);
    const { width, height } = await image.metadata();
    if (Math.max(width, height) > MAX_TEXTURE)
      image = image.resize({ width: MAX_TEXTURE, height: MAX_TEXTURE, fit: "inside" });
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8Array(data) };
  };
  const encodings = [
    {
      slots: /^normalTexture$/,
      isUASTC: true,
      isNormalMap: true,
      isPerceptual: false,
      isSetKTX2SRGBTransferFunc: false,
    },
    {
      slots: /^(metallicRoughnessTexture|occlusionTexture)$/,
      isUASTC: true,
      isPerceptual: false,
      isSetKTX2SRGBTransferFunc: false,
    },
    {
      slots: /^(baseColorTexture|emissiveTexture)$/,
      isUASTC: false,
      isPerceptual: true,
      isSetKTX2SRGBTransferFunc: true,
    },
  ].map((options) => ktx2({ ...options, generateMipmap: true, imageDecoder: decode }));

  async function shipFile(modelName, file, outName) {
    const input = ledger.files[file];
    if (!input) throw new Error(`media/provenance.json has no entry for ${file}`);
    const rawBytes = new Uint8Array(await readFile(path.join(media, file)));
    const rawSha = sha256(rawBytes);
    if (input.sha256 && input.sha256 !== rawSha)
      throw new Error(`${file} differs from its recorded sha256`);
    console.log(`${outName}: measuring and validating ${file}`);
    const raw = await measure(rawBytes, sharp);
    const rawValidator = await validate(rawBytes, validator);

    // Simplify: reload the input each time and tighten the ratio until the total is within budget.
    const steps = {};
    let started = performance.now();
    let document = await io.readBinary(rawBytes);
    let ratio = 1;
    let error = SIMPLIFY_ERROR;
    let normalsRecomputed = false;
    if (raw.triangles > BUDGET_TRIANGLES) {
      // Hard-edged (split) normals lock the simplifier at their seams (Meshy's mesh stalls at 22.5K this way).
      // The second pass drops the normals, welds, simplifies and recomputes smooth normals afterwards.
      for (const dropNormals of [false, true]) {
        ratio = (BUDGET_TRIANGLES / raw.triangles) * 0.98;
        error = SIMPLIFY_ERROR;
        for (let attempt = 0; attempt < 6; attempt++) {
          document = await io.readBinary(rawBytes);
          if (dropNormals)
            for (const mesh of document.getRoot().listMeshes())
              for (const primitive of mesh.listPrimitives()) primitive.setAttribute("NORMAL", null);
          await document.transform(
            functions.weld(),
            functions.simplify({ simplifier: MeshoptSimplifier, ratio, error }),
            ...(dropNormals ? [functions.normals({ overwrite: true })] : []),
            functions.prune(),
          );
          const total = countTriangles(document);
          console.log(`${outName}: simplify ratio ${ratio.toFixed(4)} -> ${total} triangles`);
          if (total <= BUDGET_TRIANGLES) break;
          ratio *= 0.9;
          error = Math.min(1, error * 2);
        }
        normalsRecomputed = dropNormals;
        if (countTriangles(document) <= BUDGET_TRIANGLES) break;
      }
    }
    steps.simplify = minutes(started);
    const rawHeight = scaleToHeight(document, functions);
    const named = nameUnnamed(document, modelName);

    started = performance.now();
    await document.transform(...encodings);
    steps.ktx2 = minutes(started);

    document.createExtension(extensions.KHRXMP);
    started = performance.now();
    await document.transform(functions.meshopt({ encoder: MeshoptEncoder, level: "medium" }));
    steps.meshopt = minutes(started);

    addProvenance(document, extensions, { file, rawSha, input, ratio, steps, raw, rawHeight });
    const shipped = new Uint8Array(await io.writeBinary(document));
    await writeFile(path.join(media, outName), shipped);

    console.log(`${outName}: validating the shipped file`);
    const result = await measure(shipped, sharp);
    const shippedValidator = await validate(shipped, validator);
    const readBack = await io.readBinary(shipped);
    const { json } = readGlb(shipped);
    const guidelines = checkGuidelines(readBack, core, functions, { metersAssumed: true });
    const kept = [];
    if (raw.skins && !result.skins) kept.push("skins lost");
    if (raw.animations && !result.animations) kept.push("animations lost");
    if (kept.length) throw new Error(`${outName}: ${kept.join(", ")}`);
    return {
      input: file,
      inputSha256: rawSha,
      raw: { ...raw, validator: rawValidator },
      shipped: {
        ...result,
        file: outName,
        sha256: sha256(shipped),
        extensionsUsed: json.extensionsUsed ?? [],
        extensionsRequired: json.extensionsRequired ?? [],
        budgetTriangles: BUDGET_TRIANGLES,
        simplifyRatio: Math.round(ratio * 10_000) / 10_000,
        rawHeightUnits: rawHeight,
        simplifyError: error,
        normalsRecomputed,
        namedByShip: named,
        heightMetres: STEVIE_HEIGHT_M,
        minutes: steps,
        validator: shippedValidator,
      },
      guidelines,
    };
  }

  for (const name of names) {
    const model = ledger.models[name];
    report.models[name] = { rig: model.rig, files: {} };
    report.models[name].files.model = await shipFile(name, model.glb, `ship-${name}.glb`);
    if (model.walk)
      report.models[name].files.walk = await shipFile(name, model.walk, `ship-${name}-walk.glb`);
  }
  await writeFile(path.join(media, "ship.json"), `${JSON.stringify(report, null, 2)}\n`);
  summarize(report, names);
  const failed = names.flatMap((name) =>
    Object.values(report.models[name].files)
      .filter((f) => f.shipped.validator.errors > 0)
      .map((f) => f.shipped.file),
  );
  if (failed.length) {
    console.error(`validator errors in: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

/**
 * Asset Creation Guidelines, scale and units: providers return normalised sizes (about 1-2 units), so the units are
 * converted to Stevie's real height in metres. A uniform scale s is baked in rather than added as a node: vertex
 * positions, every node translation, the translation part of inverse bind matrices and translation animation outputs
 * are multiplied by s (conjugating every transform by a uniform scale), so skins and clips stay exact and no node
 * carries a scale. Returns the height before conversion.
 */
function scaleToHeight(document, functions) {
  const root = document.getRoot();
  const height = bindPoseHeight(document);
  const s = STEVIE_HEIGHT_M / height;
  const done = new Set();
  const scaleAccessor = (accessor, pick) => {
    if (!accessor || done.has(accessor)) return;
    done.add(accessor);
    const array = accessor.getArray().slice();
    const size = accessor.getElementSize();
    for (let i = 0; i < array.length; i++) if (pick(i % size)) array[i] *= s;
    accessor.setArray(array);
  };
  for (const mesh of root.listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      scaleAccessor(primitive.getAttribute("POSITION"), () => true);
      for (const target of primitive.listTargets())
        scaleAccessor(target.getAttribute("POSITION"), () => true);
    }
  for (const node of root.listNodes()) node.setTranslation(node.getTranslation().map((t) => t * s));
  for (const skin of root.listSkins())
    scaleAccessor(skin.getInverseBindMatrices(), (i) => i >= 12 && i <= 14);
  for (const animation of root.listAnimations())
    for (const channel of animation.listChannels())
      if (channel.getTargetPath() === "translation")
        scaleAccessor(channel.getSampler()?.getOutput(), () => true);
  return Math.round(height * 1000) / 1000;
}

const mat4 = {
  multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
        for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
  },
  apply(m, [x, y, z]) {
    return [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
  },
};

/**
 * Height of the model as it renders at rest: unskinned meshes through their node's world matrix, skinned meshes
 * through their joints (joint world matrix times inverse bind matrix, weighted), as glTF and three.js both do.
 * glTF-Transform's getBounds ignores skins, which misreads rigs whose armature carries a scale.
 */
function bindPoseHeight(document) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const skin = node.getSkin();
    const jointMatrices = skin?.listJoints().map((joint, j) => {
      const ibm = skin.getInverseBindMatrices()?.getElement(j, []) ?? [
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ];
      return mat4.multiply(joint.getWorldMatrix(), ibm);
    });
    const world = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      const joints = primitive.getAttribute("JOINTS_0");
      const weights = primitive.getAttribute("WEIGHTS_0");
      const p = [];
      const jw = [];
      const ww = [];
      for (let i = 0; i < position.getCount(); i++) {
        position.getElement(i, p);
        let y;
        if (jointMatrices && joints && weights) {
          joints.getElement(i, jw);
          weights.getElement(i, ww);
          y = 0;
          for (let k = 0; k < 4; k++)
            if (ww[k]) y += ww[k] * mat4.apply(jointMatrices[jw[k]], p)[1];
        } else y = mat4.apply(world, p)[1];
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
    }
  }
  return hi - lo;
}

/** Asset Creation Guidelines, naming: names unnamed nodes, meshes and materials after the model. Returns how many. */
function nameUnnamed(document, modelName) {
  const root = document.getRoot();
  let count = 0;
  for (const [kind, list] of [
    ["node", root.listNodes()],
    ["mesh", root.listMeshes()],
    ["material", root.listMaterials()],
  ])
    for (const [i, item] of list.entries())
      if (!item.getName()) {
        item.setName(`stevie_${modelName.replace(/\W+/gu, "_")}_${kind}_${i}`);
        count++;
      }
  return count;
}

function countTriangles(document) {
  let total = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      total += Math.floor((indices ?? primitive.getAttribute("POSITION")).getCount() / 3);
    }
  }
  return total;
}

function addProvenance(
  document,
  extensions,
  { file, rawSha, input, ratio, steps, raw, rawHeight },
) {
  const packet = document.createExtension(extensions.KHRXMP).createPacket();
  packet.setContext({
    dc: "http://purl.org/dc/elements/1.1/",
    xmp: "http://ns.adobe.com/xap/1.0/",
    Iptc4xmpExt: "http://iptc.org/std/Iptc4xmpExt/2008-02-29/",
    clockgrove: "https://clockgrove.invalid/ns/provenance/1.0/",
  });
  const description = [
    raw.triangles > BUDGET_TRIANGLES
      ? `simplified from ${raw.triangles} to at most ${BUDGET_TRIANGLES} triangles (meshoptimizer, ratio ${ratio.toFixed(4)})`
      : `kept at ${raw.triangles} triangles (within the ${BUDGET_TRIANGLES} budget)`,
    `units converted from a ${rawHeight}-unit height to ${STEVIE_HEIGHT_M} m`,
    "textures encoded to KTX2 (ETC1S colour with sRGB transfer; UASTC normal and ORM)",
    "geometry compressed with EXT_meshopt_compression",
  ].join("; ");
  packet.setProperty("Iptc4xmpExt:DigitalSourceType", DIGITAL_SOURCE_TYPE);
  packet.setProperty("dc:creator", [`${input.provider}: ${input.model}`]);
  packet.setProperty("dc:source", `${file} (sha256 ${rawSha})`);
  packet.setProperty("dc:description", description);
  packet.setProperty("xmp:CreatorTool", "Clockgrove renderer-bakeoff ship.mjs");
  packet.setProperty("clockgrove:call", input.call);
  packet.setProperty("clockgrove:provider", input.provider);
  packet.setProperty("clockgrove:model", input.model);
  packet.setProperty("clockgrove:costUsd", input.costUsd);
  packet.setProperty("clockgrove:parameters", JSON.stringify(input.parameters));
  packet.setProperty("clockgrove:processingMinutes", JSON.stringify(steps));
  document.getRoot().setExtension("KHR_xmp_json_ld", packet);
}

function summarize(report, names) {
  for (const name of names) {
    for (const [kind, f] of Object.entries(report.models[name].files)) {
      const s = f.shipped;
      const g = f.guidelines.map((x) => `${x.item}:${x.pass ? "pass" : "FAIL"}`).join(" ");
      console.log(
        `${name}/${kind}: ${f.raw.triangles} -> ${s.triangles} tris, ${f.raw.bytes} -> ${s.bytes} bytes, validator raw ${f.raw.validator.errors}E/${f.raw.validator.warnings}W shipped ${s.validator.errors}E/${s.validator.warnings}W, ${g}`,
      );
    }
  }
}

await main();
