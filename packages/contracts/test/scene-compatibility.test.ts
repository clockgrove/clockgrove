import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  ContractDecodeError,
  decodeObserverSceneMessage,
  decodeSceneAssetManifest,
  decodeSceneAudience,
  decodeSceneCompatibility,
  SceneCompatibilityError,
} from "../src/index.js";

it("rejects incompatible serialized protocol, projection, asset and client versions with visible stable codes", async () => {
  const snapshot = JSON.parse(
    await readFile(
      new URL("./fixtures/realtime-projection/snapshot.golden.json", import.meta.url),
      "utf8",
    ),
  );
  const cases = JSON.parse(
    await readFile(
      new URL("./fixtures/realtime-projection/compatibility.json", import.meta.url),
      "utf8",
    ),
  );
  expect(cases).toEqual([
    { field: "protocolVersion", actual: 9, code: "unsupported_protocol_version" },
    { field: "projectionVersion", actual: 9, code: "unsupported_projection_version" },
    { field: "assetManifestVersion", actual: 9, code: "unsupported_asset_manifest_version" },
    { field: "clientVersion", actual: 9, code: "unsupported_client_version" },
  ]);
  for (const mismatch of cases) {
    const input =
      mismatch.field === "protocolVersion"
        ? { ...snapshot, protocolVersion: mismatch.actual }
        : {
            ...snapshot,
            payload: {
              ...snapshot.payload,
              compatibility: {
                ...snapshot.payload.compatibility,
                [mismatch.field]: mismatch.actual,
              },
            },
          };
    // A newer peer also changes shape; its version must still win. JSON drops undefined fields.
    const reshaped =
      mismatch.field === "protocolVersion"
        ? [
            { ...input, lighting: "dusk" },
            { ...input, sentAt: undefined },
          ]
        : [
            {
              ...input,
              payload: {
                ...input.payload,
                lighting: "dusk",
                compatibility: { ...input.payload.compatibility, rendererVersion: 2 },
              },
            },
            { ...input, payload: { ...input.payload, feedCursor: undefined } },
          ];
    for (const variant of [input, ...reshaped])
      try {
        decodeObserverSceneMessage(JSON.parse(JSON.stringify(variant)));
        throw new Error("mismatched scene decoded successfully");
      } catch (error) {
        expect(error).toBeInstanceOf(SceneCompatibilityError);
        if (!(error instanceof SceneCompatibilityError)) throw error;
        const expected = mismatch.field === "projectionVersion" ? 2 : 1;
        expect({ code: error.code, actual: error.actual, expected: error.expected }).toEqual({
          code: mismatch.code,
          actual: 9,
          expected,
        });
        expect(error.message).toContain(`${mismatch.code}; actual=9; expected=${expected}`);
      }
  }
  expect(() =>
    decodeSceneCompatibility({ ...snapshot.payload.compatibility, providerId: "forbidden" }),
  ).toThrow(ContractDecodeError);
  // An absent version is malformed rather than newer, so it keeps the generic missing-field error.
  expect(() =>
    decodeObserverSceneMessage(
      JSON.parse(JSON.stringify({ ...snapshot, protocolVersion: undefined })),
    ),
  ).toThrow("message.protocolVersion: missing field");
  expect(() => decodeSceneCompatibility({ projectionVersion: 1, clientVersion: 1 })).toThrow(
    "compatibility.assetManifestVersion: missing field",
  );
});

it("refuses a patch declaring a newer projection version with its stable code, whatever else changed", async () => {
  const patch = JSON.parse(
    await readFile(
      new URL("./fixtures/realtime-projection/patch.golden.json", import.meta.url),
      "utf8",
    ),
  );
  const newer = {
    op: "set_compatibility",
    compatibility: { projectionVersion: 9, assetManifestVersion: 1, clientVersion: 1 },
  };
  for (const payload of [
    { ...patch.payload, operations: [newer] },
    { ...patch.payload, operations: [{ op: "set_lighting", lighting: "dusk" }, newer] },
    { ...patch.payload, operations: [{ ...newer, lighting: "dusk" }] },
    { ...patch.payload, operations: [newer], lighting: "dusk" },
  ])
    expect(() => decodeObserverSceneMessage({ ...patch, payload })).toThrow(
      /\.compatibility\.projectionVersion: unsupported_projection_version; actual=9; expected=2$/u,
    );
});

it("accepts the prior projection version 1 only without version 2's effects", async () => {
  const [snapshot, patch] = await Promise.all(
    ["snapshot", "patch"].map(async (name) =>
      JSON.parse(
        await readFile(
          new URL(`./fixtures/realtime-projection/${name}.golden.json`, import.meta.url),
          "utf8",
        ),
      ),
    ),
  );
  const v1 = { projectionVersion: 1, assetManifestVersion: 1, clientVersion: 1 };
  const { effects: _effects, ...prior } = snapshot.payload;
  const decoded = decodeObserverSceneMessage({
    ...snapshot,
    payload: { ...prior, compatibility: v1 },
  });
  expect(decoded.type === "snapshot" && decoded.payload.compatibility).toEqual(v1);
  expect(decoded.type === "snapshot" && decoded.payload.effects).toBeUndefined();
  expect(() =>
    decodeObserverSceneMessage({
      ...snapshot,
      payload: { ...snapshot.payload, compatibility: v1 },
    }),
  ).toThrow("projection.effects: absent from projection version 1");
  const priorOperations = patch.payload.operations.map((operation: { op: string }) =>
    operation.op === "set_compatibility" ? { ...operation, compatibility: v1 } : operation,
  );
  expect(() =>
    decodeObserverSceneMessage({
      ...patch,
      payload: { ...patch.payload, operations: priorOperations },
    }),
  ).toThrow(/operations\[\d+\]\.op: absent from projection version 1$/u);
  const withoutEffects = priorOperations.filter(
    (operation: { op: string }) => operation.op !== "set_effects",
  );
  expect(
    decodeObserverSceneMessage({
      ...patch,
      payload: { ...patch.payload, operations: withoutEffects },
    }).type,
  ).toBe("patch");
});

it("freezes strict audience and complete reviewed asset metadata", async () => {
  const audience = { kind: "observer", hash: "audience-hall-observer", spaceIds: ["hall", "den"] };
  expect(decodeSceneAudience(audience)).toEqual(audience);
  expect(() => decodeSceneAudience({ ...audience, grants: ["operator"] })).toThrow(
    ContractDecodeError,
  );
  expect(() => decodeSceneAudience({ ...audience, kind: "operator" })).toThrow(ContractDecodeError);
  const manifest = JSON.parse(
    await readFile(
      new URL("./fixtures/realtime-projection/asset-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  expect(decodeSceneAssetManifest(manifest)).toEqual({
    version: 1,
    contentHash: "sha256-manifest-content",
    assets: [
      {
        assetId: "keeper-reviewed",
        provenance: {
          source: "original-clockgrove",
          creator: "Clockgrove artists",
          license: "CC0-1.0",
          tool: "fixture-tool",
          generated: { prompt: "Resting resident", references: ["original-study"] },
        },
        reviewStatus: "approved",
        semanticEntityId: "keeper",
        semanticArchetypeId: "resident",
        animationFamily: "idle",
        anchor: ["0", "0"],
        footprint: ["1", "1"],
        bounds: ["0", "0", "1", "1"],
        palette: ["brown", "gray"],
        contentHash: "sha256-keeper-content",
        atlasLocation: "atlas/keeper",
        accessibilityLabel: "Keeper resting",
      },
    ],
  });
  for (const reshaped of [{}, { signature: "sha256-signed" }, { contentHash: undefined }])
    expect(() =>
      decodeSceneAssetManifest(
        JSON.parse(JSON.stringify({ ...manifest, ...reshaped, version: 9 })),
      ),
    ).toThrow("unsupported_asset_manifest_version; actual=9; expected=1");
  expect(() => decodeSceneAssetManifest({ contentHash: "x", assets: [] })).toThrow(
    "manifest.version: missing field",
  );
  for (const mutate of [
    { ...manifest, extra: "forbidden" },
    { ...manifest, assets: [{ ...manifest.assets[0], extra: "forbidden" }] },
    {
      ...manifest,
      assets: [
        {
          ...manifest.assets[0],
          provenance: { ...manifest.assets[0].provenance, providerId: "forbidden" },
        },
      ],
    },
    {
      ...manifest,
      assets: [
        {
          ...manifest.assets[0],
          provenance: {
            ...manifest.assets[0].provenance,
            generated: { ...manifest.assets[0].provenance.generated, extra: "forbidden" },
          },
        },
      ],
    },
  ])
    expect(() => decodeSceneAssetManifest(mutate)).toThrow(ContractDecodeError);
});
