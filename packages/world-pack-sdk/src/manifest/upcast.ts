function isPlain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

/**
 * Pure, synchronous schema-1 to schema-2 upcast. A schema-1 manifest gains
 * `schemaVersion: 2` and, per asset, `generation: null`, `dimensions: null`,
 * `anchors: []` and `footprint: null`. The input is never mutated; any other
 * input is returned unchanged so validation can refuse it with its own code.
 */
export function upcastWorldPackManifest(
  manifest: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!isPlain(manifest) || manifest.schemaVersion !== 1) return manifest;
  const assets = Array.isArray(manifest.assets)
    ? manifest.assets.map((asset: unknown) =>
        isPlain(asset)
          ? { ...asset, generation: null, dimensions: null, anchors: [], footprint: null }
          : asset,
      )
    : manifest.assets;
  return { ...manifest, schemaVersion: 2, assets };
}
