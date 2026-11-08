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
    const scenePass = pass(scene, camera);
    // The puddle reflections need a stencil buffer in the pass target.
    if (scenePass.renderTarget) scenePass.renderTarget.stencilBuffer = true;
    const color = scenePass.getTextureNode("output");
    const bloomNode = bloom(color, mode === "full" ? 0.9 : 0.6, 0.4, 0.75);
    bloomNode.setResolutionScale(mode === "full" ? 1 : 0.5);
    // RenderPipeline replaced PostProcessing in r183.
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = color.add(bloomNode);
    return {
      render: () => pipeline.render(),
      dispose: () => {
        bloomNode.dispose();
        scenePass.dispose();
      },
    };
  },
};

registerCandidate("three-webgpu", (options) => createThreeAdapter(options, backend));
