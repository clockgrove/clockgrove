import { readFileSync } from "node:fs";
import { Extension, getBounds, Logger, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import validator from "gltf-validator";
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
  if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error("first GLB chunk must be JSON");
  const json = JSON.parse(new TextDecoder().decode(bytes.slice(20, 20 + view.getUint32(12, true))));
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])])
    if (resource.uri !== undefined && !resource.uri.startsWith("data:"))
      throw new Error("GLB resources must be embedded buffer views or data URIs");
  const report = await validator.validateBytes(bytes, {
    maxIssues: 0,
    externalResourceFunction: async () => {
      throw new Error("external resources are not permitted");
    },
  });
  const errors = report.issues.messages.filter((message) => message.severity === 0);
  if (report.issues.numErrors)
    throw new Error(
      errors
        .slice(0, 16)
        .map((message) => `${message.code}: ${message.message}`)
        .join("; "),
    );
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions([...ALL_EXTENSIONS, ModelLod])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder })
    .setLogger(new Logger(Logger.Verbosity.SILENT));
  const document = await io.readBinary(bytes);
  // The Khronos validator does not decode meshopt; validate the decoded buffers too.
  if (json.extensionsUsed?.includes("EXT_meshopt_compression")) {
    const extension = document
      .getRoot()
      .listExtensionsUsed()
      .find((extension) => extension.extensionName === "EXT_meshopt_compression");
    extension?.dispose();
    const decodedBytes = await io.writeBinary(document);
    const decodedReport = await validator.validateBytes(decodedBytes, { maxIssues: 0 });
    if (decodedReport.issues.numErrors)
      throw new Error(
        decodedReport.issues.messages
          .filter((message) => message.severity === 0)
          .slice(0, 16)
          .map((message) => `${message.code}: ${message.message}`)
          .join("; "),
      );
  }
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error("a model requires a scene");
  const bounds = getBounds(scene);
  if (![...bounds.min, ...bounds.max].every(Number.isFinite))
    throw new Error("scene has no finite geometry bounds");
  let triangles = 0;
  for (const mesh of root.listMeshes())
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
  const clips = root.listAnimations().map((animation) => {
    const times = animation
      .listSamplers()
      .flatMap((sampler) => Array.from(sampler.getInput()?.getArray() ?? []));
    const extras = animation.getExtras();
    if (typeof extras.loop !== "boolean")
      throw new Error(`animation ${animation.getName()} requires extras.loop`);
    if (extras.generated !== undefined && typeof extras.generated !== "boolean")
      throw new Error("animation extras.generated must be boolean");
    if (!times.length) throw new Error("animation has no samples");
    return {
      name: animation.getName(),
      durationMs: times.reduce((max, n) => Math.max(max, n), 0) * 1000,
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
