#!/usr/bin/env node
// Issue 77's ship step (docs/stevie-3d.md, "Shipping the models"). The owner's standard for 3D outputs is glTF 2.0 / .glb
// with KHR_texture_basisu (KTX2: UASTC for normal maps, ETC1S for every other texture), EXT_meshopt_compression and
// KHR_xmp_json_ld provenance carrying IPTC digitalSourceType trainedAlgorithmicMedia. Whatever a 3D service returned is
// converted to that form here. The Khronos glTF Validator and the four Asset Creation Guidelines 2.0 items scripted
// below run three times per file: on the provider's raw file, on the prepared geometry (after simplify, smooth normals,
// scale and naming, before KTX2 and meshopt, which the validator cannot decode) and on the shipped file. Every output
// goes to the git-ignored media/ directory: media/ship-<name>.glb (and ship-<name>-walk.glb), plus media/ship.json.
//
//   node scripts/ship.mjs              ship every model in media/provenance.json "models", and every other
//                                      generated .glb as a candidate (media/ship-candidate-<file>)
//   node scripts/ship.mjs <name>...    ship only the named models
//
// The tools are devDependencies of this workspace package, pinned in package.json and the lockfile.
// Triangle, vertex, joint and texture counts are read from the GLB's own JSON and KTX2 headers, independent of
// glTF-Transform, so they are evidence rather than a restatement of the tool's inspect.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@gltf-transform/core";
import * as extensions from "@gltf-transform/extensions";
import * as functions from "@gltf-transform/functions";
import validator from "gltf-validator";
import { ktx2 } from "ktx2-encoder/gltf-transform";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const media = path.join(root, "media");
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
const TOOLS = [
  "@gltf-transform/core",
  "@gltf-transform/extensions",
  "@gltf-transform/functions",
  "meshoptimizer",
  "gltf-validator",
  "ktx2-encoder",
  "sharp",
];
const PINNED = Object.fromEntries(
  TOOLS.map((name) => [
    name,
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).devDependencies[name],
  ]),
);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const minutes = (since) => Math.round(((performance.now() - since) / 60_000) * 100) / 100;

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

async function imageSize(image, mime) {
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

async function measure(bytes) {
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
      ...(await imageSize(data, image.mimeType)),
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

async function validate(bytes) {
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
function checkGuidelines(document) {
  const root = document.getRoot();
  const height = Math.round(bindPoseHeight(document) * 1000) / 1000;
  const guidelines = [];
  const note = "glTF is metres by definition; the file is taken as metres";
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
  await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready, MeshoptDecoder.ready]);

  const ledger = JSON.parse(await readFile(LEDGER, "utf8"));
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(ledger.models ?? {});
  for (const name of names)
    if (!ledger.models?.[name]) throw new Error(`no model "${name}" in media/provenance.json`);
  // Candidates: every other generated mesh (the dropped fal outputs, Tripo's unrigged model), shipped the same way
  // so the ranking in the ADR rests on validated files too. Armature-only and extra clips are not meshes to rank.
  const used = new Set(Object.values(ledger.models ?? {}).flatMap((m) => [m.glb, m.walk]));
  const candidates = wanted.length
    ? []
    : Object.keys(ledger.files).filter(
        (file) =>
          file.endsWith(".glb") &&
          !used.has(file) &&
          !/_armature|running|walking/u.test(file) &&
          existsSync(path.join(media, file)),
      );

  const report = existsSync(path.join(media, "ship.json"))
    ? JSON.parse(await readFile(path.join(media, "ship.json"), "utf8"))
    : {};
  report.budgetTriangles = BUDGET_TRIANGLES;
  report.tools = PINNED;
  report.models ??= {};
  report.candidates ??= {};

  const io = new core.NodeIO()
    .registerExtensions(extensions.ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

  /** UASTC for normal maps only (the owner's standard); ETC1S for every other texture, sRGB only for colour. */
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
      isUASTC: false,
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
    const raw = await measure(rawBytes);
    const rawValidator = await validate(rawBytes);
    // The guidelines on the provider's file as delivered, before this script scales or names anything.
    const rawGuidelines = checkGuidelines(await io.readBinary(rawBytes));

    // Simplify: reload the input each time and tighten the ratio until the total is within budget.
    const steps = {};
    let started = performance.now();
    let document = await io.readBinary(rawBytes);
    let ratio = 1;
    let error = SIMPLIFY_ERROR;
    let normalsRecomputed = false;
    if (raw.triangles > BUDGET_TRIANGLES) {
      // Hard-edged (split) normals lock the simplifier at their seams (Meshy's mesh stalls at 22.5K this way).
      // The second pass drops the normals, welds and simplifies, then computes smooth area-weighted vertex normals
      // on the indexed result (smoothNormals below), so the mesh stays indexed and shared corners share a normal.
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
            functions.prune(),
          );
          const total = countTriangles(document);
          console.log(`${outName}: simplify ratio ${ratio.toFixed(4)} -> ${total} triangles`);
          if (total <= BUDGET_TRIANGLES) break;
          ratio *= 0.9;
          error = Math.min(1, error * 2);
        }
        normalsRecomputed = dropNormals;
        if (dropNormals) smoothNormals(document);
        if (countTriangles(document) <= BUDGET_TRIANGLES) break;
      }
    }
    steps.simplify = minutes(started);
    const rawHeight = scaleToHeight(document);
    const named = nameUnnamed(document, modelName);

    // The geometry this script rewrote, validated before KTX2 and meshopt hide it from the validator.
    const preparedBytes = new Uint8Array(await io.writeBinary(document));
    const prepared = {
      ...(await measure(preparedBytes)),
      validator: await validate(preparedBytes),
      guidelines: checkGuidelines(document),
    };
    if (normalsRecomputed) prepared.normals = normalReport(document);

    started = performance.now();
    await document.transform(...encodings);
    steps.ktx2 = minutes(started);

    document.createExtension(extensions.KHRXMP);
    started = performance.now();
    await document.transform(functions.meshopt({ encoder: MeshoptEncoder, level: "medium" }));
    steps.meshopt = minutes(started);

    addProvenance(document, { file, rawSha, input, ratio, steps, raw, rawHeight });
    const shipped = new Uint8Array(await io.writeBinary(document));
    await writeFile(path.join(media, outName), shipped);

    console.log(`${outName}: validating the shipped file`);
    const result = await measure(shipped);
    const shippedValidator = await validate(shipped);
    const readBack = await io.readBinary(shipped);
    const { json } = readGlb(shipped);
    const guidelines = checkGuidelines(readBack);
    const kept = [];
    if (raw.skins && !result.skins) kept.push("skins lost");
    if (raw.animations && !result.animations) kept.push("animations lost");
    if (kept.length) throw new Error(`${outName}: ${kept.join(", ")}`);
    return {
      input: file,
      inputSha256: rawSha,
      raw: { ...raw, validator: rawValidator, guidelines: rawGuidelines },
      prepared,
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

  const entries = [];
  for (const name of names) {
    const model = ledger.models[name];
    report.models[name] = { rig: model.rig, files: {} };
    report.models[name].files.model = await shipFile(name, model.glb, `ship-${name}.glb`);
    if (model.walk)
      report.models[name].files.walk = await shipFile(name, model.walk, `ship-${name}-walk.glb`);
    entries.push([name, report.models[name].files]);
  }
  for (const file of candidates) {
    const name = file.replace(/(-model_glb|-model_url|-model)?\.glb$/u, "");
    report.candidates[name] = {
      files: { model: await shipFile(name, file, `ship-candidate-${name}.glb`) },
    };
    entries.push([`candidate ${name}`, report.candidates[name].files]);
  }
  await writeFile(path.join(media, "ship.json"), `${JSON.stringify(report, null, 2)}\n`);
  summarize(entries);
  const failed = entries.flatMap(([, files]) =>
    Object.values(files)
      .filter((f) => f.shipped.validator.errors > 0 || f.prepared.validator.errors > 0)
      .map((f) => f.shipped.file),
  );
  if (failed.length) {
    console.error(`validator errors in: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

/**
 * Smooth, area-weighted vertex normals on an indexed mesh. Each triangle adds its unnormalised face normal (whose
 * length is twice its area) to its three corners; corners at the same position (UV or skin seams the weld kept apart)
 * pool their sums, so the normal is continuous across seams and the inverted-hull outline stays closed.
 */
function smoothNormals(document) {
  const buffer = document.getRoot().listBuffers()[0];
  for (const mesh of document.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      const indices = primitive.getIndices();
      if (!position || !indices) throw new Error(`${mesh.getName()}: smooth normals need indices`);
      const count = position.getCount();
      const points = new Float64Array(count * 3);
      const p = [];
      const group = new Int32Array(count);
      const keys = new Map();
      for (let i = 0; i < count; i++) {
        position.getElement(i, p);
        points.set(p, i * 3);
        const key = p.map((v) => Math.round(v * 1e5)).join(",");
        if (!keys.has(key)) keys.set(key, keys.size);
        group[i] = keys.get(key);
      }
      const sums = new Float64Array(keys.size * 3);
      const index = indices.getArray();
      for (let t = 0; t + 2 < index.length; t += 3) {
        const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
        const e1 = [0, 1, 2].map((k) => points[b * 3 + k] - points[a * 3 + k]);
        const e2 = [0, 1, 2].map((k) => points[c * 3 + k] - points[a * 3 + k]);
        const n = [
          e1[1] * e2[2] - e1[2] * e2[1],
          e1[2] * e2[0] - e1[0] * e2[2],
          e1[0] * e2[1] - e1[1] * e2[0],
        ];
        for (const v of [a, b, c]) for (let k = 0; k < 3; k++) sums[group[v] * 3 + k] += n[k];
      }
      const normals = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const g = group[i] * 3;
        const length = Math.hypot(sums[g], sums[g + 1], sums[g + 2]);
        // A corner whose triangles all collapsed to zero area has no direction; give it up (glTF needs unit length).
        if (length < 1e-12) normals[i * 3 + 1] = 1;
        else for (let k = 0; k < 3; k++) normals[i * 3 + k] = sums[g + k] / length;
      }
      primitive.setAttribute(
        "NORMAL",
        document.createAccessor().setType("VEC3").setArray(normals).setBuffer(buffer),
      );
    }
}

/** Evidence that the prepared mesh is indexed and smooth: the share of triangles whose three corner normals differ. */
function normalReport(document) {
  let triangles = 0;
  let flat = 0;
  let indexed = true;
  const [a, b, c] = [[], [], []];
  for (const mesh of document.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      const normal = primitive.getAttribute("NORMAL");
      const indices = primitive.getIndices();
      if (!indices) {
        indexed = false;
        continue;
      }
      const index = indices.getArray();
      for (let t = 0; t + 2 < index.length; t += 3) {
        triangles++;
        normal.getElement(index[t], a);
        normal.getElement(index[t + 1], b);
        normal.getElement(index[t + 2], c);
        const same = (x, y) =>
          Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) < 1e-4;
        if (same(a, b) && same(b, c)) flat++;
      }
    }
  return { indexed, triangles, flatShadedTriangles: flat };
}

/**
 * Asset Creation Guidelines, scale and units: providers return normalised sizes (about 1-2 units), so the units are
 * converted to Stevie's real height in metres. A uniform scale s is baked in rather than added as a node: vertex
 * positions, every node translation, the translation part of inverse bind matrices and translation animation outputs
 * are multiplied by s (conjugating every transform by a uniform scale), so skins and clips stay exact and no node
 * carries a scale. Returns the height before conversion.
 */
function scaleToHeight(document) {
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

function addProvenance(document, { file, rawSha, input, ratio, steps, raw, rawHeight }) {
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
    "textures encoded to KTX2 (UASTC normal maps; ETC1S for colour, with sRGB transfer, and for metallic-roughness and occlusion)",
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

function summarize(entries) {
  const g = (list) => list.map((x) => `${x.item}:${x.pass ? "pass" : "FAIL"}`).join(" ");
  for (const [name, files] of entries) {
    for (const [kind, f] of Object.entries(files)) {
      const s = f.shipped;
      const v = (x) => `${x.errors}E/${x.warnings}W`;
      console.log(
        `${name}/${kind}: ${f.raw.triangles} -> ${s.triangles} tris, ${f.raw.vertices} -> ${s.vertices} verts, ${f.raw.bytes} -> ${s.bytes} bytes; validator raw ${v(f.raw.validator)} prepared ${v(f.prepared.validator)} shipped ${v(s.validator)}; raw ${g(f.raw.guidelines)}; shipped ${g(f.guidelines)}`,
      );
    }
  }
}

await main();
