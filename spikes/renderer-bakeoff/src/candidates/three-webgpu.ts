import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
import { pass } from "three/tsl";
import * as THREE from "three/webgpu";
import { registerCandidate } from "../contract.js";
import { createThreeAdapter, type ThreeBackend } from "./three.js";

const backend: ThreeBackend = {
  candidate: "three-webgpu",
  THREE,
  async createRenderer() {
    // WebGPURenderer falls back to its WebGL2 backend when WebGPU is unavailable.
    const renderer = new THREE.WebGPURenderer({ antialias: false, stencil: true });
    await renderer.init();
    return renderer;
  },
  createPost(renderer, scene, camera, mode) {
    // The puddle reflections need a stencil buffer in the pass target. It must be asked for at
    // construction: PassNode then makes its depth texture depth-stencil. Setting stencilBuffer
    // afterwards left a depth-only texture on a stencil attachment, an incomplete framebuffer that
    // drew nothing on the WebGL2 backend (CI, SwiftShader).
    const scenePass = pass(scene, camera, { stencilBuffer: true });
    const color = scenePass.getTextureNode("output");
    const bloomNode = bloom(color, mode === "full" ? 0.9 : 0.6, 0.4, 0.75);
    bloomNode.setResolutionScale(mode === "full" ? 1 : 0.5);
    // RenderPipeline replaced PostProcessing in r183.
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = color.add(bloomNode);
    return {
      render: () => {
        // PassNode re-renders its scene once per node frame, and three advances that frame only on
        // its own requestAnimationFrame tick. The harness draws frames back to back at explicit
        // times, so advance it here or every frame after the first in a task reuses a stale pass.
        renderer._nodes?.nodeFrame?.update();
        pipeline.render();
      },
      dispose: () => {
        bloomNode.dispose();
        scenePass.dispose();
      },
    };
  },
};

registerCandidate("three-webgpu", (options) => createThreeAdapter(options, backend));
