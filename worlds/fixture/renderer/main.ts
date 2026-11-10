import { decodeSceneProjection, defaultSceneLighting } from "../../../packages/contracts/src/index.js";
import { ThreeWorldSceneAdapter, type QualityTier } from "../../../apps/web/src/renderer.js";
import { worldShell } from "../../../apps/web/src/shell.js";
import { diagnostics, fixtureContent } from "./content.js";
import committed from "./snapshot.json";

const parent = document.querySelector<HTMLElement>("#scene")!;
const status = document.querySelector<HTMLElement>("#status")!;
const params = new URLSearchParams(location.search);
const reports: unknown[] = [];
let snapshot = decodeSceneProjection(committed);
const content = params.get("content") === "none" ? undefined : fixtureContent({
  failure: params.get("failure") ?? undefined,
  // Decision: cap this fixture-only stress knob at 50ms; 40ms exceeds the product's 33.4ms budget.
  workMs: Math.min(50, Math.max(0, Number(params.get("workMs") ?? 0))),
});
const adapter = new ThreeWorldSceneAdapter(parent, () => {
  snapshot = { ...snapshot, lighting: defaultSceneLighting(snapshot.simulationTime, snapshot.weather, snapshot.effects ?? []) };
  adapter.loadSnapshot(snapshot);
  status.textContent = "Scene ready";
  document.body.dataset.ready = "true";
}, () => {
  status.textContent = "Canvas unavailable";
}, (point) => {
  reports.push(point);
  // Match the client measurement ring: retain only the latest 512 observations.
  if (reports.length > 512) reports.shift();
}, content);

const setEnvironment = (timeMs: bigint | number, rainIntensity: number) => {
  const simulationTime = typeof timeMs === "bigint" ? timeMs : BigInt(Math.round(timeMs));
  snapshot = { ...snapshot, simulationTime, weather: { rainIntensity },
    lighting: defaultSceneLighting(simulationTime, { rainIntensity }, snapshot.effects ?? []),
  };
  adapter.loadSnapshot(snapshot);
};
const setReducedMotion = (value: boolean) => adapter.setReducedMotion(value);
const setQuality = (value: QualityTier) => adapter.setQuality(value);
const internal = adapter as any;
const api = {
  adapter,
  diagnostics,
  reports,
  get snapshot() { return snapshot; },
  setEnvironment,
  setReducedMotion,
  setQuality,
  capture() {
    if (internal.composer) internal.composer.render();
    else internal.renderer.render(internal.scene, internal.camera);
    return internal.renderer.domElement.toDataURL("image/png");
  },
  setContentAnchor(x: number, y: number) { diagnostics.setAnchor(x, y); },
  setModelAnchor(x: number, y: number) { diagnostics.setModelAnchor(x, y); },
  setDepthEnabled(enabled: boolean) {
    if (!diagnostics.sprite) return;
    diagnostics.sprite.material.depthNode = enabled
      ? diagnostics.sprite.userData.depthNode
      : null;
    diagnostics.sprite.material.needsUpdate = true;
    internal.dirty = true;
  },
  setNormalEnabled(enabled: boolean) {
    if (!diagnostics.sprite) return;
    diagnostics.sprite.material.normalMap = enabled ? diagnostics.normalMap : null;
    diagnostics.sprite.material.needsUpdate = true;
    internal.dirty = true;
  },
  destroy() { adapter.destroy(); },
};
(globalThis as any).fixtureRenderer = api;

document.querySelector<HTMLSelectElement>("#clock")!.onchange = (event) => {
  setEnvironment(Number((event.target as HTMLSelectElement).value), snapshot.weather.rainIntensity);
};
document.querySelector<HTMLInputElement>("#time")!.oninput = (event) => {
  setEnvironment(Number((event.target as HTMLInputElement).value), snapshot.weather.rainIntensity);
};
document.querySelector<HTMLInputElement>("#rain")!.onchange = (event) => {
  setEnvironment(snapshot.simulationTime, (event.target as HTMLInputElement).checked ? 9000 : 0);
};
document.querySelector<HTMLInputElement>("#motion")!.onchange = (event) => {
  setReducedMotion((event.target as HTMLInputElement).checked);
};
document.querySelector<HTMLSelectElement>("#quality")!.onchange = (event) => {
  setQuality((event.target as HTMLSelectElement).value as QualityTier);
};
globalThis.addEventListener("pagehide", () => adapter.destroy(), { once: true });

const zoom = document.querySelector<HTMLInputElement>("#zoom")!;
zoom.min = String(worldShell.scene.camera?.minZoom ?? 0.75);
zoom.max = String(worldShell.scene.camera?.maxZoom ?? 2);
zoom.oninput = () => {
  if (!internal.camera) return;
  adapter.setCamera({
    x: internal.camera.position.x,
    y: -internal.camera.position.y,
    zoom: Number(zoom.value),
  });
};
