import { decodeOpaqueId, type ObjectId } from "./ids.js";
import { decodeScenePresentationBinding, type ScenePresentationBinding } from "./scene-protocol.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  integer,
  literal,
  literalVersion,
  nonNegativeInteger,
  optional,
  record,
  string,
  utcTimestamp,
} from "./validation.js";

/** The asset-manifest version a scene snapshot's `compatibility.assetManifestVersion` names. */
export const ASSET_MANIFEST_VERSION = 2;
/** The pack presentation-metadata version. */
export const PACK_PRESENTATION_VERSION = 1;
/**
 * Licenses an asset may deploy under (issue 813 decision): the repository's own MIT license for original
 * Clockgrove work, and the two Creative Commons licenses that allow redistribution in a product.
 */
export const PERMITTED_ASSET_LICENSES = ["MIT", "CC0-1.0", "CC-BY-4.0"] as const;
export const ASSET_ANIMATION_FAMILIES = [
  "idle",
  "walk",
  "sniff",
  "eat",
  "play",
  "shelter",
  "static",
  "loop",
] as const;
export type AssetAnimationFamily = (typeof ASSET_ANIMATION_FAMILIES)[number];
/** WebGL guarantees 2048 px textures; each world profile sets tighter role limits (issue 61). */
export const MAX_ASSET_FRAME_EDGE = 2048;
/**
 * The most frames in one strip (issue 813 decision): eight times the four-frame cycles of the first set,
 * headroom for smoother loops without unbounded strips. The atlas width also bounds a strip's pixels.
 */
export const MAX_ASSET_FRAME_COUNT = 32;

const kebab = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const sha256 = /^[0-9a-f]{64}$/u;
const colour = /^#[0-9a-f]{6}$/u;

/** Assetforge #47 provider grant field names; absent fields are refused by the deploy gate. */
export interface AssetOutputGrant {
  readonly license?: string;
  readonly plan?: string;
  readonly commercial?: boolean;
  readonly relabel?: boolean;
  readonly attribution?: string;
}
export interface AssetProvenance {
  readonly prompt: string | null;
  readonly references: readonly string[];
  readonly model?: string;
  readonly provider?: string;
  readonly route?: string;
  readonly providerTermsVersion?: string;
  readonly outputGrant?: AssetOutputGrant;
}

export interface AssetManifest {
  readonly assetManifestVersion: 2;
  /** Kebab-case; with `animationFamily` the manifest's identity. */
  readonly assetId: string;
  readonly animationFamily: AssetAnimationFamily;
  readonly source: {
    readonly kind: "generated" | "authored" | "imported";
    /** Repository-relative: `assets/source/<assetId>/<animationFamily>.png`. */
    readonly path: string;
    readonly creator: string;
    readonly tool: string | null;
  };
  /** An SPDX license identifier. */
  readonly license: string;
  /** Generation prompt (or generator parameters) and the references the asset was drawn from. */
  readonly provenance: AssetProvenance;
  readonly review: {
    readonly status: "pending" | "approved" | "rejected";
    /** The human reviewer's login; null until reviewed. */
    readonly reviewer: string | null;
    readonly reviewedAt: string | null;
    readonly notes: string;
  };
  readonly semantic: {
    readonly role: "actor" | "object" | "terrain" | "effect";
    readonly entity: string | null;
    readonly archetype: string | null;
  };
  readonly frames: {
    readonly width: number;
    readonly height: number;
    readonly count: number;
    readonly durationMs: number | null;
  };
  /** The frame pixel that sits on the entity's position. */
  readonly anchor: { readonly x: number; readonly y: number };
  /** World footprint in the pack frame's unit (millimetres). */
  readonly footprint: { readonly width: number; readonly depth: number };
  /** Opaque bounding box of the union of all frames, in frame pixels. */
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Every opaque colour the source uses, `#rrggbb`, sorted. */
  readonly palette: readonly string[];
  /** SHA-256 of the exact source bytes. */
  readonly contentHash: string;
  /** Frame 0's top-left in the atlas; later frames follow to its right. */
  readonly atlas: { readonly atlasId: string; readonly x: number; readonly y: number };
  readonly accessibilityLabel: string;
}

function nullable<T>(value: unknown, path: string, decode: (v: unknown, p: string) => T): T | null {
  return value === null ? null : decode(value, path);
}
function pattern(value: unknown, expression: RegExp, path: string, what: string): string {
  const decoded = string(value, path);
  if (!expression.test(decoded)) throw new ContractDecodeError(path, `expected ${what}`);
  return decoded;
}
function bounded(value: unknown, min: number, max: number, path: string): number {
  const decoded = integer(value, path);
  if (decoded < min || decoded > max)
    throw new ContractDecodeError(path, `expected an integer in ${min}..${max}`);
  return decoded;
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ContractDecodeError(path, "expected a string");
  return value;
}

export function decodeAssetManifest(value: unknown, path = "manifest"): AssetManifest {
  const v = record(value, path);
  exactKeys(
    v,
    [
      "assetManifestVersion",
      "assetId",
      "animationFamily",
      "source",
      "license",
      "provenance",
      "review",
      "semantic",
      "frames",
      "anchor",
      "footprint",
      "bounds",
      "palette",
      "contentHash",
      "atlas",
      "accessibilityLabel",
    ],
    [],
    path,
  );
  literalVersion(v.assetManifestVersion, ASSET_MANIFEST_VERSION, `${path}.assetManifestVersion`);
  const assetId = pattern(v.assetId, kebab, `${path}.assetId`, "a kebab-case id");
  const animationFamily = literal(
    v.animationFamily,
    ASSET_ANIMATION_FAMILIES,
    `${path}.animationFamily`,
  );

  const source = record(v.source, `${path}.source`);
  exactKeys(source, ["kind", "path", "creator", "tool"], [], `${path}.source`);
  const sourcePath = string(source.path, `${path}.source.path`);
  if (sourcePath !== `assets/source/${assetId}/${animationFamily}.png`)
    throw new ContractDecodeError(
      `${path}.source.path`,
      `expected assets/source/${assetId}/${animationFamily}.png`,
    );
  const kind = literal(source.kind, ["generated", "authored", "imported"], `${path}.source.kind`);

  const provenance = record(v.provenance, `${path}.provenance`);
  const generatedFields = ["model", "provider", "route", "providerTermsVersion", "outputGrant"];
  exactKeys(
    provenance,
    ["prompt", "references"],
    kind === "generated" ? generatedFields : [],
    `${path}.provenance`,
  );
  const prompt = nullable(provenance.prompt, `${path}.provenance.prompt`, string);
  const references = array(provenance.references, `${path}.provenance.references`, (v, p) =>
    kind === "generated"
      ? pattern(v, sha256, p, "a lowercase SHA-256 reference hash")
      : string(v, p),
  );
  const metadata = Object.fromEntries(
    generatedFields.slice(0, 4).flatMap((field) => {
      const value = optional(provenance, field, string, `${path}.provenance`);
      return value === undefined ? [] : [[field, value]];
    }),
  );
  const outputGrant = optional(
    provenance,
    "outputGrant",
    (value, p) => {
      const grant = record(value, p);
      exactKeys(grant, [], ["license", "plan", "commercial", "relabel", "attribution"], p);
      const result: Record<string, string | boolean> = {};
      for (const key of ["license", "plan", "attribution"])
        if (key in grant)
          result[key] =
            key === "license"
              ? pattern(
                  grant[key],
                  /^[A-Za-z0-9.+-]+(?: AND [A-Za-z0-9.+-]+)*$/u,
                  `${p}.${key}`,
                  "an SPDX identifier or AND expression",
                )
              : string(grant[key], `${p}.${key}`);
      for (const key of ["commercial", "relabel"])
        if (key in grant) {
          if (typeof grant[key] !== "boolean")
            throw new ContractDecodeError(`${p}.${key}`, "expected a boolean");
          result[key] = grant[key];
        }
      return Object.freeze(result) as AssetOutputGrant;
    },
    `${path}.provenance`,
  );
  if (kind === "generated" && prompt === null && references.length === 0)
    throw new ContractDecodeError(
      `${path}.provenance`,
      "a generated asset records its prompt or references",
    );

  const review = record(v.review, `${path}.review`);
  exactKeys(review, ["status", "reviewer", "reviewedAt", "notes"], [], `${path}.review`);
  const status = literal(
    review.status,
    ["pending", "approved", "rejected"],
    `${path}.review.status`,
  );
  const reviewer = nullable(review.reviewer, `${path}.review.reviewer`, string);
  const reviewedAt = nullable(review.reviewedAt, `${path}.review.reviewedAt`, utcTimestamp);
  if (
    (status === "pending") !== (reviewer === null) ||
    (reviewer === null) !== (reviewedAt === null)
  )
    throw new ContractDecodeError(
      `${path}.review`,
      "a reviewed asset names its reviewer and time; a pending one names neither",
    );

  const semantic = record(v.semantic, `${path}.semantic`);
  exactKeys(semantic, ["role", "entity", "archetype"], [], `${path}.semantic`);
  const frames = record(v.frames, `${path}.frames`);
  exactKeys(frames, ["width", "height", "count", "durationMs"], [], `${path}.frames`);
  const width = bounded(frames.width, 1, MAX_ASSET_FRAME_EDGE, `${path}.frames.width`);
  const height = bounded(frames.height, 1, MAX_ASSET_FRAME_EDGE, `${path}.frames.height`);
  const count = bounded(frames.count, 1, MAX_ASSET_FRAME_COUNT, `${path}.frames.count`);
  const durationMs = nullable(frames.durationMs, `${path}.frames.durationMs`, (d, p) =>
    // Per-frame duration at most one minute: a slower change is simulation state, not animation (issue 813 decision).
    bounded(d, 1, 60_000, p),
  );
  if (count > 1 !== (durationMs !== null))
    throw new ContractDecodeError(
      `${path}.frames.durationMs`,
      "an animated strip has a frame duration; a single frame has none",
    );

  const anchor = record(v.anchor, `${path}.anchor`);
  exactKeys(anchor, ["x", "y"], [], `${path}.anchor`);
  const footprint = record(v.footprint, `${path}.footprint`);
  exactKeys(footprint, ["width", "depth"], [], `${path}.footprint`);
  const bounds = record(v.bounds, `${path}.bounds`);
  exactKeys(bounds, ["x", "y", "width", "height"], [], `${path}.bounds`);
  const bx = bounded(bounds.x, 0, width - 1, `${path}.bounds.x`);
  const by = bounded(bounds.y, 0, height - 1, `${path}.bounds.y`);
  const atlas = record(v.atlas, `${path}.atlas`);
  exactKeys(atlas, ["atlasId", "x", "y"], [], `${path}.atlas`);
  const palette = array(v.palette, `${path}.palette`, (c, p) =>
    pattern(c, colour, p, "a #rrggbb colour"),
  );
  if (palette.length === 0 || palette.some((c, i) => i > 0 && (palette[i - 1] as string) >= c))
    throw new ContractDecodeError(`${path}.palette`, "expected sorted, unique colours");

  return Object.freeze({
    assetManifestVersion: 2,
    assetId,
    animationFamily,
    source: Object.freeze({
      kind,
      path: sourcePath,
      creator: string(source.creator, `${path}.source.creator`),
      tool: nullable(source.tool, `${path}.source.tool`, string),
    }),
    license: pattern(v.license, /^[A-Za-z0-9.+-]+$/u, `${path}.license`, "an SPDX identifier"),
    provenance: Object.freeze({
      prompt,
      references,
      ...metadata,
      ...(outputGrant === undefined ? {} : { outputGrant }),
    }),
    review: Object.freeze({
      status,
      reviewer,
      reviewedAt,
      notes: text(review.notes, `${path}.review.notes`),
    }),
    semantic: Object.freeze({
      role: literal(
        semantic.role,
        ["actor", "object", "terrain", "effect"],
        `${path}.semantic.role`,
      ),
      entity: nullable(semantic.entity, `${path}.semantic.entity`, string),
      archetype: nullable(semantic.archetype, `${path}.semantic.archetype`, string),
    }),
    frames: Object.freeze({ width, height, count, durationMs }),
    anchor: Object.freeze({
      x: bounded(anchor.x, 0, width, `${path}.anchor.x`),
      y: bounded(anchor.y, 0, height, `${path}.anchor.y`),
    }),
    // Footprints at most 1 km (1,000,000 mm) a side: an outer bound on any single object (issue 813 decision).
    footprint: Object.freeze({
      width: bounded(footprint.width, 1, 1_000_000, `${path}.footprint.width`),
      depth: bounded(footprint.depth, 1, 1_000_000, `${path}.footprint.depth`),
    }),
    bounds: Object.freeze({
      x: bx,
      y: by,
      width: bounded(bounds.width, 1, width - bx, `${path}.bounds.width`),
      height: bounded(bounds.height, 1, height - by, `${path}.bounds.height`),
    }),
    palette,
    contentHash: pattern(v.contentHash, sha256, `${path}.contentHash`, "a lowercase SHA-256"),
    atlas: Object.freeze({
      atlasId: pattern(atlas.atlasId, kebab, `${path}.atlas.atlasId`, "a kebab-case id"),
      x: nonNegativeInteger(atlas.x, `${path}.atlas.x`),
      y: nonNegativeInteger(atlas.y, `${path}.atlas.y`),
    }),
    accessibilityLabel: string(v.accessibilityLabel, `${path}.accessibilityLabel`),
  });
}

export type AssetDeployRefusalCode =
  | "REVIEW_NOT_APPROVED"
  | "REVIEWER_NOT_HUMAN"
  | "LICENSE_NOT_PERMITTED"
  | "GENERATED_PROVENANCE_INCOMPLETE"
  | "OUTPUT_GRANT_NOT_PERMITTED"
  | "OUTPUT_GRANT_LICENSE_MISMATCH"
  | "OUTPUT_GRANT_ATTRIBUTION_REQUIRED";
export interface AssetDeployRefusal {
  readonly code: AssetDeployRefusalCode;
  readonly asset: string;
  readonly detail: string;
}

/**
 * Why a decoded manifest may not deploy; empty when it may. Deployment needs an approved review by
 * a human login (a GitHub `[bot]` account is not one) and a permitted license.
 */
export function assetDeployRefusals(manifest: AssetManifest): readonly AssetDeployRefusal[] {
  const asset = `${manifest.assetId}/${manifest.animationFamily}`;
  const refusals: AssetDeployRefusal[] = [];
  if (manifest.review.status !== "approved")
    refusals.push({
      code: "REVIEW_NOT_APPROVED",
      asset,
      detail: `review status is ${manifest.review.status}; an approved human review is required`,
    });
  else if (manifest.review.reviewer?.endsWith("[bot]"))
    refusals.push({
      code: "REVIEWER_NOT_HUMAN",
      asset,
      detail: `reviewer ${manifest.review.reviewer} is not a human login`,
    });
  if (!(PERMITTED_ASSET_LICENSES as readonly string[]).includes(manifest.license))
    refusals.push({
      code: "LICENSE_NOT_PERMITTED",
      asset,
      detail: `license ${manifest.license} is not one of ${PERMITTED_ASSET_LICENSES.join(", ")}`,
    });
  if (manifest.source.kind === "generated") {
    const provenance = manifest.provenance;
    const grant = provenance.outputGrant;
    const grantLicenses = grant?.license?.split(" AND ") ?? [];
    const requiresCredit = grantLicenses.includes("CC-BY-4.0");
    if (
      !provenance.prompt?.trim() ||
      !provenance.model?.trim() ||
      !provenance.provider?.trim() ||
      !provenance.route?.trim() ||
      !provenance.providerTermsVersion?.trim() ||
      !grant?.license?.trim() ||
      !grant.plan?.trim() ||
      grant.commercial === undefined ||
      grant.relabel === undefined
    )
      refusals.push({
        code: "GENERATED_PROVENANCE_INCOMPLETE",
        asset,
        detail:
          "generated assets require prompt or serialized parameters, model, provider, route, providerTermsVersion and a complete outputGrant",
      });
    if (
      grant?.commercial === false ||
      (grant?.license !== undefined &&
        grant.relabel !== true &&
        !grantLicenses.every((license) =>
          (PERMITTED_ASSET_LICENSES as readonly string[]).includes(license),
        ))
    )
      refusals.push({
        code: "OUTPUT_GRANT_NOT_PERMITTED",
        asset,
        detail:
          "the provider grant must permit commercial distribution and either relicensing or a permitted asset license",
      });
    if (
      grant?.license !== undefined &&
      ((grant.relabel === false && manifest.license !== grant.license) ||
        (requiresCredit && manifest.license !== "CC-BY-4.0") ||
        (manifest.license === "MIT" && grant.relabel !== true))
    )
      refusals.push({
        code: "OUTPUT_GRANT_LICENSE_MISMATCH",
        asset,
        detail: "the declared license is incompatible with the provider output grant",
      });
    if (requiresCredit && !grant?.attribution?.trim())
      refusals.push({
        code: "OUTPUT_GRANT_ATTRIBUTION_REQUIRED",
        asset,
        detail: "a CC-BY-4.0 provider grant requires its credit line",
      });
  }
  return Object.freeze(refusals);
}

export type PackPresentationEffectRole =
  | "path"
  | "rain"
  | "puddle"
  | "lantern"
  | "window"
  | "selection";
export interface PackPresentationEffect {
  readonly role: PackPresentationEffectRole;
  readonly assetId: string;
  readonly animationFamily: AssetAnimationFamily;
  /** Where a placed effect sits (lantern, window); null for scene-wide effects. */
  readonly objectId: ObjectId | null;
}
/** A world pack's versioned presentation metadata: its stable IDs bound to asset manifests. */
export interface PackPresentation {
  readonly presentationVersion: 1;
  readonly assetManifestVersion: 2;
  readonly pack: { readonly id: string; readonly version: string };
  /** Each binding has the wire `ScenePresentationBinding` shape; `animationFamily` is the default. */
  readonly bindings: readonly ScenePresentationBinding[];
  readonly effects: readonly PackPresentationEffect[];
}

export function decodePackPresentation(value: unknown, path = "presentation"): PackPresentation {
  const v = record(value, path);
  exactKeys(
    v,
    ["presentationVersion", "assetManifestVersion", "pack", "bindings", "effects"],
    [],
    path,
  );
  literalVersion(v.presentationVersion, PACK_PRESENTATION_VERSION, `${path}.presentationVersion`);
  literalVersion(v.assetManifestVersion, ASSET_MANIFEST_VERSION, `${path}.assetManifestVersion`);
  const pack = record(v.pack, `${path}.pack`);
  exactKeys(pack, ["id", "version"], [], `${path}.pack`);
  const seen = new Set<string>();
  const bindings = array(v.bindings, `${path}.bindings`, (item, p) => {
    const binding = decodeScenePresentationBinding(item, p);
    if (seen.has(binding.objectId)) throw new ContractDecodeError(p, "duplicate object");
    seen.add(binding.objectId);
    pattern(binding.assetId, kebab, `${p}.assetId`, "a kebab-case id");
    literal(binding.animationFamily, ASSET_ANIMATION_FAMILIES, `${p}.animationFamily`);
    return Object.freeze(binding);
  });
  const effects = array(v.effects, `${path}.effects`, (item, p) => {
    const effect = record(item, p);
    exactKeys(effect, ["role", "assetId", "animationFamily", "objectId"], [], p);
    return Object.freeze({
      role: literal(
        effect.role,
        ["path", "rain", "puddle", "lantern", "window", "selection"],
        `${p}.role`,
      ),
      assetId: pattern(effect.assetId, kebab, `${p}.assetId`, "a kebab-case id"),
      animationFamily: literal(
        effect.animationFamily,
        ASSET_ANIMATION_FAMILIES,
        `${p}.animationFamily`,
      ),
      objectId: nullable(effect.objectId, `${p}.objectId`, (o, q) =>
        decodeOpaqueId(o, "ObjectId", q),
      ),
    });
  });
  return Object.freeze({
    presentationVersion: 1,
    assetManifestVersion: 2,
    pack: Object.freeze({
      id: string(pack.id, `${path}.pack.id`),
      version: string(pack.version, `${path}.pack.version`),
    }),
    bindings,
    effects,
  });
}
