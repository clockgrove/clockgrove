import { loadKtx2Encoder } from "./ktx2.js";

export * from "./atlas.js";
export { loadKtx2Encoder } from "./ktx2.js";
export * from "./license-report.js";
export * from "./model.js";
export * from "./png.js";
export * from "./repository.js";
export * from "./scene.js";
export * from "./upload.js";
export * from "./validate.js";

// Importers of the library get the encoder ready: `buildAtlases` encodes synchronously.
await loadKtx2Encoder();
