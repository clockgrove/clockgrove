import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { assetDeployRefusals, decodeAssetManifest, decodePackPresentation } from "../src/index.js";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/asset-manifest/${name}.json`, import.meta.url), "utf8"),
  );

it("lets only an approved, permitted-license manifest deploy", () => {
  expect(assetDeployRefusals(decodeAssetManifest(fixture("approved")))).toEqual([]);
  expect(assetDeployRefusals(decodeAssetManifest(fixture("unreviewed")))).toEqual([
    {
      code: "REVIEW_NOT_APPROVED",
      asset: "fixture-critter/idle",
      detail: "review status is pending; an approved human review is required",
    },
  ]);
  expect(assetDeployRefusals(decodeAssetManifest(fixture("unlicensed")))).toEqual([
    {
      code: "LICENSE_NOT_PERMITTED",
      asset: "fixture-critter/idle",
      detail: "license LicenseRef-Proprietary is not one of MIT, CC0-1.0, CC-BY-4.0",
    },
  ]);
  const bot = {
    ...(fixture("approved") as object),
    review: {
      status: "approved",
      reviewer: "clockgrove-factory[bot]",
      reviewedAt: "2026-11-05T00:00:00Z",
      notes: "",
    },
  };
  expect(assetDeployRefusals(decodeAssetManifest(bot)).map(({ code }) => code)).toEqual([
    "REVIEWER_NOT_HUMAN",
  ]);
});

it("refuses manifests that misname, omit provenance or hide a reviewer", () => {
  const approved = fixture("approved") as Record<string, unknown>;
  for (const [change, message] of [
    [{ assetId: "Fixture_Critter" }, "manifest.assetId: expected a kebab-case id"],
    [
      { source: { ...(approved.source as object), path: "art/critter.png" } },
      "manifest.source.path: expected assets/source/fixture-critter/idle.png",
    ],
    [
      { provenance: { prompt: null, references: [] } },
      "manifest.provenance: a generated asset records its prompt or references",
    ],
    [
      { review: { status: "pending", reviewer: "someone", reviewedAt: null, notes: "" } },
      "manifest.review: a reviewed asset names its reviewer and time; a pending one names neither",
    ],
    [{ palette: ["#808080", "#202020"] }, "manifest.palette: expected sorted, unique colours"],
  ] as const)
    expect(() => decodeAssetManifest({ ...approved, ...change })).toThrow(message);
});

it("decodes pack presentation metadata and refuses a doubly bound object", () => {
  const binding = {
    objectId: "o",
    assetId: "fixture-critter",
    animationFamily: "idle",
    accessibilityLabel: "A critter",
  };
  const presentation = {
    presentationVersion: 1,
    assetManifestVersion: 2,
    pack: { id: "p", version: "1.0.0" },
    bindings: [binding],
    effects: [{ role: "rain", assetId: "fixture-rain", animationFamily: "loop", objectId: null }],
  };
  expect(decodePackPresentation(presentation)).toEqual(presentation);
  expect(() => decodePackPresentation({ ...presentation, bindings: [binding, binding] })).toThrow(
    "presentation.bindings[1]: duplicate object",
  );
});
