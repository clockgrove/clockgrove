import { TSL as nativeTSL } from "../../../apps/web/src/renderer-content.js";
import type {
  RendererContent,
  RendererContentFrame,
} from "../../../apps/web/src/renderer-content.js";

export const diagnostics = {
  ready: false,
  disposed: false,
  updates: 0,
  lastFrame: undefined as RendererContentFrame | undefined,
  boneAngle: 0,
  model: undefined as any,
  sprite: undefined as any,
  root: undefined as any,
  depthMap: undefined as any,
  loaders: undefined as any,
  normalMap: undefined as any,
  lightSources: undefined as any,
  shadowCaster: undefined as any,
  shadowReceiver: undefined as any,
  setAnchor: (_x: number, _y: number) => {},
  setModelAnchor: (_x: number, _y: number) => {},
};

export function fixtureContent(options: { failure?: string; workMs?: number; lighting?: boolean } = {}): RendererContent {
  return {
    version: 1,
    create(context) {
      if (options.failure === "load") throw new Error("Fixture load failure");
      const { THREE, TSL } = context;
      diagnostics.loaders = context.loaders;
      const root = new THREE.Group();
      root.name = "fixture-content";
      const geometry = new THREE.BoxGeometry(1.4, 3, 0.8, 2, 6, 2);
      geometry.translate(0, 1.5, 0);
      const positions = geometry.getAttribute("position");
      const indices = [], weights = [];
      for (let i = 0; i < positions.count; i++) {
        const weight = Math.max(0, Math.min(1, positions.getY(i) / 3));
        indices.push(0, 1, 0, 0);
        weights.push(1 - weight, weight, 0, 0);
      }
      geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(indices, 4));
      geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
      const material = new THREE.MeshStandardNodeMaterial({ color: 0xf06b46, roughness: 0.7 });
      if (options.failure === "draw") {
        const failedNode = TSL.uniform(1);
        failedNode.build = () => { throw new Error("Fixture draw failure"); };
        material.colorNode = failedNode;
      }
      if (options.failure === "shader") {
        material.colorNode = context.backend === "webgpu"
          ? nativeTSL.wgslFn("fn fixtureBrokenColor() -> vec3<f32> { return fixtureUndefinedSymbol; }")()
          : nativeTSL.glslFn("vec3 fixtureBrokenColor() { return fixtureUndefinedSymbol; }")();
      }
      if (options.failure === "vertex") material.vertexNode = TSL.vec4(0, 0, 0, 1);
      // Geometry deformation remains supported while the product owns projection.
      material.positionNode = TSL.positionLocal;
      const model = new THREE.SkinnedMesh(geometry, material);
      model.name = "fixture-skinned";
      if (options.failure === "contract") model.onBeforeRender = () => {};
      const base = new THREE.Bone(), tip = new THREE.Bone();
      base.name = "base";
      tip.name = "tip";
      tip.position.y = 1.5;
      base.add(tip);
      model.add(base);
      model.bind(new THREE.Skeleton([base, tip]));
      const clip = new THREE.AnimationClip("fixture-loop", 2, [
        new THREE.NumberKeyframeTrack(".bones[tip].rotation[z]", [0, 0.5, 1, 1.5, 2], [0, 0.35, 0, -0.35, 0]),
      ]);
      const mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
      const modelAnchor = new THREE.Group();
      modelAnchor.add(model);
      context.place(modelAnchor, { x: -2, y: -2 });
      root.add(modelAnchor);

      // Decision: a 16-square procedural bump is enough to exercise all channels without binary art.
      const albedo = new Uint8Array(16 * 16 * 4);
      const normals = new Uint8Array(albedo.length), depths = new Uint8Array(albedo.length);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const offset = (y * 16 + x) * 4;
        const dx = (x - 7.5) / 8, dy = (y - 7.5) / 8;
        const bump = Math.max(0, 1 - dx * dx - dy * dy);
        albedo.set([50, 150 + Math.round(bump * 60), 220, bump > 0 ? 255 : 0], offset);
        normals.set([128 + Math.round(dx * 65), 128 + Math.round(dy * 65), 220, 255], offset);
        const value = Math.round(bump * 255);
        depths.set([value, value, value, 255], offset);
      }
      const texture = (data: Uint8Array) => {
        const result = new THREE.DataTexture(data, 16, 16);
        result.needsUpdate = true;
        return result;
      };
      const map = texture(albedo), normalMap = texture(normals), depthMap = texture(depths);
      map.colorSpace = THREE.SRGBColorSpace;
      const spriteMaterial = new THREE.MeshStandardNodeMaterial({ map, normalMap, alphaTest: 0.5, roughness: 0.8 });
      // Three r187 ViewportDepthNode.viewZToOrthographicDepth: (viewZ + near) / (near - far).
      // Decision: the fixture bump shifts fragments toward the camera by up to .04 depth units.
      spriteMaterial.depthNode = TSL.positionView.z.add(TSL.texture(depthMap).r.mul(0.04))
        .add(TSL.cameraNear).div(TSL.cameraNear.sub(TSL.cameraFar));
      const spriteGeometry = new THREE.PlaneGeometry(2.4, 2.4);
      spriteGeometry.translate(0, 1.2, 0);
      const sprite = new THREE.Mesh(spriteGeometry, spriteMaterial);
      sprite.name = "fixture-mapped-sprite";
      sprite.userData.depthNode = spriteMaterial.depthNode;
      const spriteAnchor = new THREE.Group();
      spriteAnchor.add(sprite);
      context.place(spriteAnchor, { x: 0, y: 0 });
      root.add(spriteAnchor);
      const lightSources = Array.from({ length: 10 }, () => ({
        position: [-4, 2, 8] as [number, number, number], colour: "#ff8844", intensity: 60000, rangeMetres: 30,
      }));
      let shadowCaster: any, shadowReceiver: any;
      if (options.lighting) {
        shadowReceiver = new THREE.Mesh(new THREE.PlaneGeometry(180, 180),
          new THREE.MeshStandardNodeMaterial({ color: 0xcccccc, roughness: 1 }));
        shadowReceiver.position.set(-100, 80, -30);
        shadowReceiver.receiveShadow = true;
        root.add(shadowReceiver);
        shadowCaster = new THREE.Mesh(new THREE.BoxGeometry(36, 36, 36),
          new THREE.MeshStandardNodeMaterial({ color: 0xdd6666, roughness: 1 }));
        shadowCaster.position.set(-100, 80, 10);
        shadowCaster.castShadow = true;
        shadowCaster.receiveShadow = true;
        root.add(shadowCaster);
      }
      Object.assign(diagnostics, { ready: true, model, sprite, root, normalMap, depthMap, lightSources, shadowCaster, shadowReceiver });
      diagnostics.setAnchor = (x, y) => context.place(spriteAnchor, { x, y });
      diagnostics.setModelAnchor = (x, y) => context.place(modelAnchor, { x, y });
      return {
        root,
        lights: options.lighting ? lightSources : undefined,
        shadows: options.lighting,
        update(frame) {
          if (options.failure === "update") throw new Error("Fixture update failure");
          diagnostics.updates++;
          diagnostics.lastFrame = frame;
          mixer.setTime(frame.timeMs / 1000);
          diagnostics.boneAngle = tip.rotation.z;
          if (options.workMs) {
            const until = performance.now() + options.workMs;
            while (performance.now() < until) Math.sqrt(Math.random());
          }
        },
        dispose() {
          mixer.stopAllAction();
          mixer.uncacheRoot(model);
          diagnostics.disposed = true;
        },
      };
    },
  };
}
