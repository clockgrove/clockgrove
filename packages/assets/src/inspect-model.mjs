import { readFileSync } from "node:fs";
import { Extension, getBounds, Logger, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

// LOD references are inspected from the original JSON below, independently of geometry decoding.
class ModelLod extends Extension {
  static EXTENSION_NAME = "MSFT_lod";
  extensionName = "MSFT_lod";
  read() {
    return this;
  }
  write() {
    return this;
  }
}

try {
  const bytes = new Uint8Array(readFileSync(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 20 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.length
  )
    throw new Error("expected a glTF 2.0 binary with an exact file length");
  // GLB 2.0 chunks are four-byte aligned; JSON comes first, followed by optional BIN.
  let offset = 12;
  const chunks = [];
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("truncated GLB chunk header");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > bytes.length)
      throw new Error("invalid GLB chunk length");
    chunks.push({ type, start: offset + 8, length });
    offset += 8 + length;
  }
  if (chunks[0]?.type !== 0x4e4f534a) throw new Error("first GLB chunk must be JSON");
  if (chunks.slice(1).some((chunk) => chunk.type === 0x4e4f534a))
    throw new Error("GLB must contain only one JSON chunk");
  const binaryChunks = chunks.filter((chunk) => chunk.type === 0x004e4942);
  if (binaryChunks.length > 1 || (binaryChunks.length && chunks[1] !== binaryChunks[0]))
    throw new Error("GLB BIN chunk must occur once after JSON");
  const first = chunks[0];
  const json = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(first.start, first.start + first.length),
    ),
  );
  if (json.asset?.version !== "2.0") throw new Error("expected glTF asset version 2.0");
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])])
    if (resource.uri !== undefined && !resource.uri.startsWith("data:"))
      throw new Error("GLB resources must be embedded buffer views or data URIs");
  const reference = (items, index) => Number.isInteger(index) && index >= 0 && items?.[index];
  for (const animation of json.animations ?? []) {
    if (!animation.channels?.length || !animation.samplers?.length)
      throw new Error("animation requires channels and samplers");
    for (const sampler of animation.samplers) {
      if (
        !reference(json.accessors, sampler.input) ||
        !reference(json.accessors, sampler.output) ||
        !["LINEAR", "STEP", "CUBICSPLINE"].includes(sampler.interpolation ?? "LINEAR")
      )
        throw new Error("invalid animation sampler");
    }
    const targets = new Set();
    for (const channel of animation.channels) {
      const target = channel.target;
      if (
        !reference(animation.samplers, channel.sampler) ||
        !["translation", "rotation", "scale", "weights"].includes(target?.path) ||
        (target.node !== undefined && !reference(json.nodes, target.node))
      )
        throw new Error("invalid animation channel target or sampler");
      // Core glTF permits channels without a node; the renderer ignores those channels.
      if (target.node === undefined) continue;
      const key = `${target.node}/${target.path}`;
      if (targets.has(key)) throw new Error("duplicate animation channel target");
      targets.add(key);
      if (target.path !== "weights" && json.nodes[target.node].matrix !== undefined)
        throw new Error("animated transform node must use TRS properties");
    }
  }
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions([...ALL_EXTENSIONS, ModelLod])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder })
    .setLogger(new Logger(Logger.Verbosity.SILENT));
  const document = await io.readBinary(bytes);
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error("a model requires a scene");
  const bounds = getBounds(scene);
  if (![...bounds.min, ...bounds.max].every(Number.isFinite))
    throw new Error("scene has no finite geometry bounds");
  const meshTriangles = root.listMeshes().map((mesh) => {
    let triangles = 0;
    for (const primitive of mesh.listPrimitives()) {
      const count = (primitive.getIndices() ?? primitive.getAttribute("POSITION"))?.getCount();
      if (count === undefined) throw new Error("primitive has no positions");
      const mode = primitive.getMode();
      if (mode === 4) triangles += count / 3;
      else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
      else throw new Error("model primitives must contain triangles");
    }
    if (!Number.isInteger(triangles))
      throw new Error("triangle index count is not divisible by three");
    return triangles;
  });
  let textureMaxPx = 0;
  for (const texture of root.listTextures()) {
    if (!["image/png", "image/jpeg", "image/ktx2"].includes(texture.getMimeType()))
      throw new Error("texture encoding must be PNG, JPEG or KTX2");
    const size = texture.getSize();
    if (!size || size.some((n) => !Number.isInteger(n) || n <= 0))
      throw new Error("invalid texture dimensions");
    textureMaxPx = Math.max(textureMaxPx, ...size);
  }
  const joints = new Set(root.listSkins().flatMap((skin) => skin.listJoints()));
  let lods = 1;
  for (const [index, node] of (json.nodes ?? []).entries()) {
    const ids = node.extensions?.MSFT_lod?.ids;
    if (ids === undefined) continue;
    if (
      !Array.isArray(ids) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !Number.isInteger(id) || !json.nodes[id] || id === index)
    )
      throw new Error("invalid MSFT_lod node references");
    lods = Math.max(lods, ids.length + 1);
  }
  const visiting = new Set(),
    visited = new Set();
  const visitLod = (index) => {
    if (visiting.has(index)) throw new Error("cyclic MSFT_lod node references");
    if (visited.has(index)) return;
    visiting.add(index);
    for (const id of json.nodes[index].extensions?.MSFT_lod?.ids ?? []) visitLod(id);
    visiting.delete(index);
    visited.add(index);
  };
  for (let index = 0; index < (json.nodes?.length ?? 0); index++) visitLod(index);
  const chains = new Map();
  const chainFor = (index) => {
    if (!chains.has(index)) {
      const chain = [index];
      for (const id of json.nodes[index].extensions?.MSFT_lod?.ids ?? [])
        for (const alternate of chainFor(id)) if (!chain.includes(alternate)) chain.push(alternate);
      chains.set(index, chain);
    }
    return chains.get(index);
  };
  for (let index = 0; index < (json.nodes?.length ?? 0); index++)
    lods = Math.max(lods, chainFor(index).length);
  const alternateNodes = new Set(
    (json.nodes ?? []).flatMap((node) => node.extensions?.MSFT_lod?.ids ?? []),
  );
  const levelTriangles = Array.from({ length: lods }, (_, level) => {
    // Preserve the historical mesh-definition metric for models without a chain.
    if (lods === 1) return meshTriangles.reduce((sum, count) => sum + count, 0);
    const meshes = new Set();
    const active = new Set();
    const visit = (index, replace = true) => {
      if (!reference(json.nodes, index) || active.has(index))
        throw new Error("invalid or cyclic scene node references");
      active.add(index);
      const node = json.nodes[index];
      const chain = chainFor(index);
      if (replace && level > 0 && chain.length > 1)
        visit(chain[Math.min(level, chain.length - 1)], false);
      else {
        if (node.mesh !== undefined) {
          if (!reference(json.meshes, node.mesh)) throw new Error("invalid mesh reference");
          meshes.add(node.mesh);
        }
        for (const child of node.children ?? []) visit(child);
      }
      active.delete(index);
    };
    const sourceScene = json.scenes[json.scene ?? 0];
    for (const index of sourceScene.nodes ?? []) if (!alternateNodes.has(index)) visit(index);
    return [...meshes].reduce((sum, index) => sum + meshTriangles[index], 0);
  });
  const triangles = levelTriangles[0];
  const clips = root.listAnimations().map((animation) => {
    for (const sampler of animation.listSamplers()) {
      const input = sampler.getInput();
      const times = input?.getArray();
      if (
        input?.getType() !== "SCALAR" ||
        input.getComponentType() !== 5126 ||
        input.getNormalized() ||
        !times?.length ||
        times.some(
          (time, index) =>
            !Number.isFinite(time) || time < 0 || (index > 0 && time <= times[index - 1]),
        )
      )
        throw new Error(
          "animation input must contain strictly increasing finite nonnegative float times",
        );
      if (!sampler.getOutput()?.getArray()?.every(Number.isFinite))
        throw new Error("animation output must contain finite samples");
    }
    let duration = 0;
    for (const channel of animation.listChannels()) {
      const node = channel.getTargetNode();
      if (!node) continue;
      const path = channel.getTargetPath();
      const sampler = channel.getSampler();
      const input = sampler.getInput();
      const output = sampler.getOutput();
      const cubic = sampler.getInterpolation() === "CUBICSPLINE" ? 3 : 1;
      let components = 1;
      if (path === "weights") {
        const counts = node
          .getMesh()
          ?.listPrimitives()
          .map((primitive) => primitive.listTargets().length);
        if (!counts?.length || !counts[0] || counts.some((count) => count !== counts[0]))
          throw new Error("weight animation requires consistent mesh morph targets");
        components = counts[0];
      }
      const type = path === "weights" ? "SCALAR" : path === "rotation" ? "VEC4" : "VEC3";
      const componentType = output.getComponentType();
      const allowed = path === "weights" || path === "rotation" ? [5120, 5121, 5122, 5123] : [];
      if (
        output.getType() !== type ||
        output.getCount() !== input.getCount() * cubic * components ||
        (componentType !== 5126 && (!allowed.includes(componentType) || !output.getNormalized()))
      )
        throw new Error("animation output does not match target shape and input sample count");
      const times = input.getArray();
      duration = Math.max(duration, times[times.length - 1]);
    }
    const extras = animation.getExtras();
    if (typeof extras.loop !== "boolean")
      throw new Error(`animation ${animation.getName()} requires extras.loop`);
    if (extras.generated !== undefined && typeof extras.generated !== "boolean")
      throw new Error("animation extras.generated must be boolean");
    return {
      name: animation.getName(),
      durationMs: duration * 1000,
      loop: extras.loop,
      ...(extras.generated === undefined ? {} : { generated: extras.generated }),
    };
  });
  if (
    clips.some((clip) => !clip.name) ||
    new Set(clips.map((clip) => clip.name)).size !== clips.length
  )
    throw new Error("animation names must be nonempty and unique");
  process.stdout.write(
    JSON.stringify({
      triangles,
      levelTriangles,
      textureMaxPx,
      materials: root.listMaterials().length,
      bones: joints.size,
      lods,
      clips,
      bounds,
      rig: json.asset.extras?.rig,
    }),
  );
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "invalid GLB");
  process.exitCode = 1;
}
