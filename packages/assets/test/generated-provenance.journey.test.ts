import { readFileSync } from "node:fs";
import {
  assetDeployRefusals,
  decodeAssetManifest,
  decodeAssetStyleProfile,
} from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { encodePng, licenseReport, sha256Hex, validateSource } from "../src/index.js";

it("accepts larger painterly generated art and enforces provider output grants without relabelling", () => {
  const template = JSON.parse(
    readFileSync(
      new URL("../../contracts/test/fixtures/asset-manifest/approved.json", import.meta.url),
      "utf8",
    ),
  );
  const rgba = new Uint8Array(300 * 300 * 4);
  rgba.set([17, 99, 201, 180], (150 * 300 + 150) * 4);
  rgba.set([123, 213, 42, 64], (149 * 300 + 150) * 4);
  const bytes = encodePng({ width: 300, height: 300, rgba });
  const outputGrant = { license: "MIT", plan: "owned", commercial: true, relabel: true };
  const provenance = {
    prompt: "test parameters",
    references: ["a".repeat(64)],
    model: "test-model",
    provider: "test-provider",
    route: "test-route",
    providerTermsVersion: "2026-11-09",
    outputGrant,
  };
  const input = {
    ...template,
    assetManifestVersion: 2,
    provenance,
    frames: { width: 300, height: 300, count: 1, durationMs: null },
    bounds: { x: 150, y: 150, width: 1, height: 1 },
    contentHash: sha256Hex(bytes),
  };
  const manifest = decodeAssetManifest(input);
  const profile = decodeAssetStyleProfile({
    styleProfileVersion: 1,
    alpha: { mode: "soft", boundsThreshold: 180 },
    colour: { mode: "unrestricted" },
    edge: "unrestricted",
    sizes: Object.fromEntries(
      ["actor", "object", "terrain", "effect"].map((role) => [
        role,
        { maxWidth: 512, maxHeight: 512 },
      ]),
    ),
  });
  expect(validateSource(manifest, bytes, undefined, profile)).toEqual([]);
  expect(assetDeployRefusals(manifest)).toEqual([]);
  expect(
    assetDeployRefusals(
      decodeAssetManifest({
        ...input,
        provenance: {
          ...provenance,
          outputGrant: { ...outputGrant, license: "LicenseRef-provider-owned" },
        },
      }),
    ),
  ).toEqual([]);
  const codes = (changes: object) =>
    assetDeployRefusals(decodeAssetManifest({ ...input, ...changes })).map((row) => row.code);
  for (const field of ["model", "provider", "route", "providerTermsVersion", "outputGrant"]) {
    const partial = { ...provenance } as Record<string, unknown>;
    delete partial[field];
    expect(codes({ provenance: partial })).toEqual(["GENERATED_PROVENANCE_INCOMPLETE"]);
  }
  expect(codes({ provenance: { ...provenance, outputGrant: { license: "MIT" } } })).toEqual([
    "GENERATED_PROVENANCE_INCOMPLETE",
    "OUTPUT_GRANT_LICENSE_MISMATCH",
  ]);
  expect(
    codes({ provenance: { ...provenance, outputGrant: { ...outputGrant, commercial: false } } }),
  ).toEqual(["OUTPUT_GRANT_NOT_PERMITTED"]);
  expect(
    codes({
      provenance: {
        ...provenance,
        outputGrant: { ...outputGrant, license: "LicenseRef-provider-free", relabel: false },
      },
    }),
  ).toEqual(["OUTPUT_GRANT_NOT_PERMITTED", "OUTPUT_GRANT_LICENSE_MISMATCH"]);
  const credit = {
    ...outputGrant,
    license: "CC-BY-4.0",
    relabel: false,
    attribution: "Credit test-provider",
  };
  expect(
    codes({ license: "CC-BY-4.0", provenance: { ...provenance, outputGrant: credit } }),
  ).toEqual([]);
  const credited = decodeAssetManifest({
    ...input,
    license: "CC-BY-4.0",
    provenance: { ...provenance, outputGrant: credit },
  });
  expect(licenseReport([credited]).split("\n").slice(-4)).toEqual([
    "## Provider credits",
    "",
    "fixture-critter/idle: Credit test-provider",
    "",
  ]);
  expect(credited.license).toBe("CC-BY-4.0");
  expect(codes({ provenance: { ...provenance, outputGrant: credit } })).toEqual([
    "OUTPUT_GRANT_LICENSE_MISMATCH",
  ]);
  expect(
    codes({ provenance: { ...provenance, outputGrant: { ...credit, relabel: true } } }),
  ).toEqual(["OUTPUT_GRANT_LICENSE_MISMATCH"]);
  const { attribution: _credit, ...withoutCredit } = credit;
  expect(
    codes({ license: "CC-BY-4.0", provenance: { ...provenance, outputGrant: withoutCredit } }),
  ).toEqual(["OUTPUT_GRANT_ATTRIBUTION_REQUIRED"]);
  expect(() =>
    decodeAssetManifest({ ...input, provenance: { ...provenance, references: ["not-a-hash"] } }),
  ).toThrow("lowercase SHA-256 reference hash");
  expect(() => decodeAssetManifest({ ...input, assetManifestVersion: 1 })).toThrow(
    "unsupported version; expected 2",
  );
});
