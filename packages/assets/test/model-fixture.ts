import { createHash } from "node:crypto";
import { Document, NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRTextureBasisu } from "@gltf-transform/extensions";
import { MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";
import { encodeKtx2Uastc } from "../src/ktx2.js";
import { encodePng } from "../src/png.js";

// biome-ignore lint/suspicious/noExplicitAny: the fixture edits raw glTF extension JSON independently of the reader.
export function rewriteModelJson(bytes: Uint8Array, change: (json: Record<string, any>) => void) {
  const original = Buffer.from(bytes);
  const length = original.readUInt32LE(12);
  const json = JSON.parse(original.subarray(20, 20 + length).toString());
  change(json);
  const encoded = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(padded);
  const header = Buffer.from(original.subarray(0, 20));
  const tail = original.subarray(20 + length);
  header.writeUInt32LE(20 + padded.length + tail.length, 8);
  header.writeUInt32LE(padded.length, 12);
  return new Uint8Array(Buffer.concat([header, padded, tail]));
}

export async function createRiggedModelFixture(
  options: {
    texture?: "png" | "jpeg" | "ktx2";
    meshopt?: boolean;
    lod?: boolean;
    generated?: boolean;
    unusedSampler?: boolean;
  } = {},
) {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]))
    .setBuffer(buffer);
  const normals = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const joints = document
    .createAccessor()
    .setType("VEC4")
    .setArray(new Uint16Array(12))
    .setBuffer(buffer);
  const weights = document
    .createAccessor()
    .setType("VEC4")
    .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
    .setBuffer(buffer);
  const material = document
    .createMaterial()
    .setBaseColorFactor([0.8, 0.25, 0.1, 1])
    .setDoubleSided(true)
    .setMetallicFactor(0)
    .setRoughnessFactor(1);
  if (options.texture) {
    const image = { width: 4, height: 4, rgba: new Uint8Array(64).fill(255) };
    const data =
      options.texture === "png"
        ? encodePng(image)
        : options.texture === "jpeg"
          ? new Uint8Array(
              await sharp(image.rgba, { raw: { width: 4, height: 4, channels: 4 } })
                .jpeg()
                .toBuffer(),
            )
          : encodeKtx2Uastc(image, "srgb");
    const texture = document.createTexture().setImage(data).setMimeType(`image/${options.texture}`);
    material.setBaseColorTexture(texture);
    if (options.texture === "ktx2") document.createExtension(KHRTextureBasisu).setRequired(true);
  }
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", positions)
    .setAttribute("NORMAL", normals)
    .setAttribute("JOINTS_0", joints)
    .setAttribute("WEIGHTS_0", weights)
    .setMaterial(material);
  if (options.texture)
    primitive.setAttribute(
      "TEXCOORD_0",
      document
        .createAccessor()
        .setType("VEC2")
        .setArray(new Float32Array([0, 0, 1, 0, 0.5, 1]))
        .setBuffer(buffer),
    );
  const joint = document.createNode("joint");
  const skin = document.createSkin("fixture-rig").addJoint(joint).setSkeleton(joint);
  const actor = document
    .createNode("actor")
    .setMesh(document.createMesh().addPrimitive(primitive))
    .setSkin(skin);
  document.createScene("default").addChild(actor).addChild(joint);
  document.getRoot().setDefaultScene(document.getRoot().listScenes()[0]!);
  const times = document
    .createAccessor()
    .setType("SCALAR")
    .setArray(new Float32Array([0, 0.5, 1]))
    .setBuffer(buffer);
  const rotations = document
    .createAccessor()
    .setType("VEC4")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0.38268343, 0.92387953, 0, 0, 0, 1]))
    .setBuffer(buffer);
  const sampler = document
    .createAnimationSampler()
    .setInput(times)
    .setOutput(rotations)
    .setInterpolation("LINEAR");
  const channel = document
    .createAnimationChannel()
    .setTargetNode(joint)
    .setTargetPath("rotation")
    .setSampler(sampler);
  const animation = document
    .createAnimation("idle")
    .setExtras({ loop: true, generated: options.generated ?? false })
    .addSampler(sampler)
    .addChannel(channel);
  if (options.unusedSampler)
    animation.addSampler(
      document
        .createAnimationSampler()
        .setInput(
          document
            .createAccessor()
            .setType("SCALAR")
            .setArray(new Float32Array([0, 2.5, 5]))
            .setBuffer(buffer),
        )
        .setOutput(rotations)
        .setInterpolation("LINEAR"),
    );
  if (options.meshopt) {
    await MeshoptEncoder.ready;
    document
      .createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  }
  let bytes = await new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRTextureBasisu])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder })
    .writeBinary(document);
  if (options.lod)
    bytes = rewriteModelJson(bytes, (json) => {
      json.extensionsUsed = [...(json.extensionsUsed ?? []), "MSFT_lod"];
      json.extensionsRequired = [...(json.extensionsRequired ?? []), "MSFT_lod"];
      const actor = json.nodes.find((node: { name: string }) => node.name === "actor");
      actor.extensions = { MSFT_lod: { ids: [json.nodes.length] } };
      json.nodes.push({ name: "lower-detail", mesh: actor.mesh, skin: actor.skin });
    });
  const manifest = {
    kind: "model",
    assetManifestVersion: 2,
    assetId: "model-fixture",
    source: {
      kind: options.generated ? "generated" : "authored",
      path: "assets/source/model-fixture/model.glb",
      creator: "fixture",
      tool: null,
    },
    license: "MIT",
    provenance: {
      prompt: options.generated ? "fixture generation" : null,
      references: [],
      ...(options.generated
        ? {
            model: "fixture",
            provider: "fixture",
            route: "fixture",
            providerTermsVersion: "fixture",
            outputGrant: { license: "MIT", plan: "fixture", commercial: true, relabel: true },
          }
        : {}),
    },
    review: {
      status: "pending",
      reviewer: null,
      reviewedAt: null,
      notes: "generated test fixture",
    },
    semantic: { role: "actor", entity: null, archetype: null },
    accessibilityLabel: "A rigged triangle",
    output: {
      path: "assets/source/model-fixture/model.glb",
      mediaType: "model/gltf-binary",
      extension: "glb",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      triangles: 1,
      textureMaxPx: options.texture ? 4 : 0,
      materials: 1,
      bones: 1,
      lods: options.lod ? 2 : 1,
      clips: [
        { name: "idle", durationMs: 1000, loop: true, generated: options.generated ?? false },
      ],
      bounds: { min: [-1, 0, 0], max: [1, 2, 0] },
    },
  };
  const profile = {
    version: 1,
    limits: {
      triangles: 1,
      textureMaxPx: options.texture ? 4 : 0,
      materials: 1,
      bones: 1,
      lods: options.lod ? 2 : 1,
    },
    tiers: {
      low: {
        triangles: 1,
        textureMaxPx: options.texture ? 4 : 0,
        materials: 1,
        bones: 1,
        lods: options.lod ? 2 : 1,
      },
    },
  };
  return { bytes, manifest, profile };
}
