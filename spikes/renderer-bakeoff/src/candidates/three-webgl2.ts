import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { BLOOM_SCALE, BLOOM_THRESHOLD, registerCandidate } from "../contract.js";
import { createThreeAdapter, THREE_BLOOM_STRENGTH, type ThreeBackend } from "./three.js";

const backend: ThreeBackend = {
  candidate: "three-webgl2",
  THREE,
  async createRenderer() {
    return new THREE.WebGLRenderer({
      antialias: false,
      preserveDrawingBuffer: true,
      stencil: true,
      powerPreference: "high-performance",
    });
  },
  createPost(renderer, scene, camera, mode, width, height) {
    // The composer's targets need a stencil buffer or the puddle reflections would vanish under bloom.
    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: true,
    });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      THREE_BLOOM_STRENGTH * BLOOM_SCALE[mode],
      0.4,
      BLOOM_THRESHOLD,
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    return {
      render: () => composer.render(0),
      dispose: () => {
        bloom.dispose();
        composer.dispose();
        target.dispose();
      },
    };
  },
};

registerCandidate("three-webgl2", (options) => createThreeAdapter(options, backend));
