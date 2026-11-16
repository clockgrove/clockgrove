import {
  type AssetManifest,
  type AssetOutputGrant,
  decodeAssetManifest,
} from "./asset-manifest.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  literal,
  literalVersion,
  nonNegativeInteger,
  optional,
  record,
  string,
  utcTimestamp,
} from "./validation.js";

export interface ModelClip {
  readonly name: string;
  readonly durationMs: number;
  readonly loop: boolean;
  readonly generated?: boolean;
}
export interface ModelMetrics {
  readonly triangles: number;
  readonly textureMaxPx: number;
  readonly materials: number;
  readonly bones: number;
  readonly lods: number;
}
export interface ModelAssetManifest
  extends Pick<
    AssetManifest,
    | "assetManifestVersion"
    | "assetId"
    | "source"
    | "license"
    | "provenance"
    | "review"
    | "semantic"
    | "accessibilityLabel"
  > {
  readonly kind: "model";
  readonly output: ModelMetrics & {
    readonly path: string;
    readonly mediaType: "model/gltf-binary";
    readonly extension: "glb";
    readonly sha256: string;
    readonly clips: readonly ModelClip[];
    /** glTF's default-scene, axis-aligned bounds in metres. */
    readonly bounds: {
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
    };
    readonly rig?: { readonly template: string; readonly sha256: string };
    /** Ordered full-detail to lowest-detail levels; paths identify separate GLBs. */
    readonly levels?: readonly {
      readonly triangles: number;
      readonly path?: string;
      readonly sha256?: string;
    }[];
    readonly renditions?: Readonly<Record<string, readonly number[]>>;
    /** Assetgrove's hand-off choice; `embedded` declares no side images. */
    readonly sideImages?: "beside" | "embedded";
    readonly groom?: ModelImageSet;
    readonly textures?: ModelImageSet;
    readonly eyes?: ModelImageSet;
    /** Per profile tier, the side images that tier draws; unlisted tiers draw the top-level ones. */
    readonly tiers?: Readonly<Record<string, ModelTierImages>>;
  };
}
/** A world-relative image beside the `.glb`, which refers to it by relative `uri`. */
export interface ModelSideImage {
  readonly path: string;
  readonly sha256: string;
}
/** One image, or names (seasons, maps) mapped to image sets, at most two levels deep. */
export type ModelImageSet = ModelSideImage | { readonly [name: string]: ModelImageSet };
export interface ModelTierImages {
  readonly groom?: ModelImageSet;
  readonly textures?: ModelImageSet;
  readonly eyes?: ModelImageSet;
}
export const modelImageFields = ["groom", "textures", "eyes"] as const;
/** Every declared side image with its manifest field path, e.g. `groom.winter` or `tiers.low.eyes`. */
export function modelSideImages(
  output: ModelTierImages & { readonly tiers?: Readonly<Record<string, ModelTierImages>> },
): readonly { readonly field: string; readonly image: ModelSideImage; readonly tier?: string }[] {
  const result: { field: string; image: ModelSideImage; tier?: string }[] = [];
  const walk = (set: ModelImageSet, field: string, tier?: string) => {
    if (typeof set.path === "string")
      result.push({ field, image: set as ModelSideImage, ...(tier === undefined ? {} : { tier }) });
    else
      for (const [name, child] of Object.entries(set))
        walk(child as ModelImageSet, `${field}.${name}`, tier);
  };
  for (const key of modelImageFields) if (output[key]) walk(output[key], key);
  for (const [tier, images] of Object.entries(output.tiers ?? {}))
    for (const key of modelImageFields)
      if (images[key]) walk(images[key], `tiers.${tier}.${key}`, tier);
  return result;
}
export interface ModelTargetProfile {
  readonly version: 1;
  /** All metrics are upper bounds; no platform budget is implied. */
  readonly limits: ModelMetrics;
  readonly tiers?: Readonly<Record<string, ModelMetrics>>;
}
const hashPattern = /^[0-9a-f]{64}$/u;
function hash(value: unknown, path: string): string {
  const result = string(value, path);
  if (!hashPattern.test(result))
    throw new ContractDecodeError(path, "expected a lowercase SHA-256");
  return result;
}
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ContractDecodeError(path, "expected a boolean");
  return value;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ContractDecodeError(path, "expected a finite number");
  return value;
}
function vector(value: unknown, path: string): readonly [number, number, number] {
  const result = array(value, path, finite);
  if (result.length !== 3) throw new ContractDecodeError(path, "expected three coordinates");
  return result as readonly [number, number, number];
}
function nullable<T>(value: unknown, path: string, decode: (v: unknown, p: string) => T): T | null {
  return value === null ? null : decode(value, path);
}
const metrics = ["triangles", "textureMaxPx", "materials", "bones", "lods"] as const;
function decodeMetrics(value: unknown, path: string): ModelMetrics {
  const v = record(value, path);
  exactKeys(v, metrics, [], path);
  return Object.freeze(
    Object.fromEntries(metrics.map((key) => [key, nonNegativeInteger(v[key], `${path}.${key}`)])),
  ) as unknown as ModelMetrics;
}
export function decodeModelTargetProfile(value: unknown, path = "modelTarget"): ModelTargetProfile {
  const v = record(value, path);
  exactKeys(v, ["version", "limits"], ["tiers"], path);
  literalVersion(v.version, 1, `${path}.version`);
  const tiers = optional(
    v,
    "tiers",
    (value, p) => {
      const entries = Object.entries(record(value, p));
      if (!entries.length) throw new ContractDecodeError(p, "expected at least one tier");
      return Object.freeze(
        Object.fromEntries(
          entries.map(([key, limit]) => [string(key, p), decodeMetrics(limit, `${p}.${key}`)]),
        ),
      );
    },
    path,
  );
  return Object.freeze({
    version: 1,
    limits: decodeMetrics(v.limits, `${path}.limits`),
    ...(tiers === undefined ? {} : { tiers }),
  });
}

export function decodeModelAssetManifest(value: unknown, path = "manifest"): ModelAssetManifest {
  const v = record(value, path);
  exactKeys(
    v,
    [
      "kind",
      "assetManifestVersion",
      "assetId",
      "source",
      "license",
      "provenance",
      "review",
      "semantic",
      "accessibilityLabel",
      "output",
    ],
    [],
    path,
  );
  literal(v.kind, ["model"], `${path}.kind`);
  literalVersion(v.assetManifestVersion, 2, `${path}.assetManifestVersion`);
  const assetId = string(v.assetId, `${path}.assetId`);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(assetId))
    throw new ContractDecodeError(`${path}.assetId`, "expected a kebab-case id");
  const source = record(v.source, `${path}.source`);
  exactKeys(source, ["kind", "path", "creator", "tool"], [], `${path}.source`);
  const kind = literal(source.kind, ["generated", "authored", "imported"], `${path}.source.kind`);
  const sourcePath = string(source.path, `${path}.source.path`);
  if (
    !sourcePath.endsWith(".glb") ||
    !/^[a-zA-Z0-9_./-]+$/u.test(sourcePath) ||
    sourcePath.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new ContractDecodeError(
      `${path}.source.path`,
      "expected a safe world-relative .glb path",
    );
  const provenance = record(v.provenance, `${path}.provenance`);
  const fields = ["model", "provider", "route", "providerTermsVersion", "outputGrant"];
  exactKeys(
    provenance,
    ["prompt", "references"],
    kind === "generated" ? fields : [],
    `${path}.provenance`,
  );
  const prompt = nullable(provenance.prompt, `${path}.provenance.prompt`, string);
  const references = array(
    provenance.references,
    `${path}.provenance.references`,
    kind === "generated" ? hash : string,
  );
  if (kind === "generated" && prompt === null && references.length === 0)
    throw new ContractDecodeError(
      `${path}.provenance`,
      "a generated asset records its prompt or references",
    );
  const metadata = Object.fromEntries(
    fields.slice(0, 4).flatMap((key) => {
      const value = optional(provenance, key, string, `${path}.provenance`);
      return value === undefined ? [] : [[key, value]];
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
        if (key in grant) {
          const value = string(grant[key], `${p}.${key}`);
          if (key === "license" && !/^[A-Za-z0-9.+-]+(?: AND [A-Za-z0-9.+-]+)*$/u.test(value))
            throw new ContractDecodeError(
              `${p}.${key}`,
              "expected an SPDX identifier or AND expression",
            );
          result[key] = value;
        }
      for (const key of ["commercial", "relabel"])
        if (key in grant) result[key] = boolean(grant[key], `${p}.${key}`);
      return Object.freeze(result) as AssetOutputGrant;
    },
    `${path}.provenance`,
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
  if (typeof review.notes !== "string")
    throw new ContractDecodeError(`${path}.review.notes`, "expected a string");
  const semantic = record(v.semantic, `${path}.semantic`);
  exactKeys(semantic, ["role", "entity", "archetype"], [], `${path}.semantic`);
  const output = record(v.output, `${path}.output`);
  exactKeys(
    output,
    ["path", "mediaType", "extension", "sha256", ...metrics, "clips", "bounds"],
    ["rig", "levels", "renditions", "sideImages", ...modelImageFields, "tiers"],
    `${path}.output`,
  );
  const sideImages = optional(
    output,
    "sideImages",
    (value, p) => literal(value, ["beside", "embedded"] as const, p),
    `${path}.output`,
  );
  const imageFields = (record_: Record<string, unknown>, p: string) =>
    Object.fromEntries(
      modelImageFields.flatMap((key) =>
        record_[key] === undefined ? [] : [[key, decodeImageSet(record_[key], `${p}.${key}`, 0)]],
      ),
    ) as ModelTierImages;
  const images = imageFields(output, `${path}.output`);
  const tiers = optional(
    output,
    "tiers",
    (value, p) => {
      const entries = Object.entries(record(value, p));
      if (!entries.length) throw new ContractDecodeError(p, "expected at least one tier");
      return Object.freeze(
        Object.fromEntries(
          entries.map(([tier, value]) => {
            const entry = record(value, `${p}.${tier}`);
            exactKeys(entry, [], modelImageFields, `${p}.${tier}`);
            return [tier, Object.freeze(imageFields(entry, `${p}.${tier}`))];
          }),
        ),
      );
    },
    `${path}.output`,
  );
  const declared = modelSideImages({ ...images, ...(tiers === undefined ? {} : { tiers }) });
  if (sideImages === "embedded" && declared.length)
    throw new ContractDecodeError(
      `${path}.output.sideImages`,
      "an embedded model declares no side images",
    );
  const hashes = new Map<string, string>();
  for (const { field, image } of declared) {
    if (image.path === sourcePath || (hashes.get(image.path) ?? image.sha256) !== image.sha256)
      throw new ContractDecodeError(
        `${path}.output.${field}.path`,
        "a side image is not the model and one path has one sha256",
      );
    hashes.set(image.path, image.sha256);
  }
  if (output.path !== sourcePath)
    throw new ContractDecodeError(`${path}.output.path`, "must equal source.path");
  const bounds = record(output.bounds, `${path}.output.bounds`);
  exactKeys(bounds, ["min", "max"], [], `${path}.output.bounds`);
  const min = vector(bounds.min, `${path}.output.bounds.min`),
    max = vector(bounds.max, `${path}.output.bounds.max`);
  if (min.some((coordinate, i) => coordinate > (max[i] as number)))
    throw new ContractDecodeError(`${path}.output.bounds`, "min must not exceed max");
  const names = new Set<string>();
  const clips = array(output.clips, `${path}.output.clips`, (value, p) => {
    const clip = record(value, p);
    exactKeys(clip, ["name", "durationMs", "loop"], ["generated"], p);
    const name = string(clip.name, `${p}.name`);
    if (names.has(name)) throw new ContractDecodeError(`${p}.name`, "duplicate clip name");
    names.add(name);
    const durationMs = finite(clip.durationMs, `${p}.durationMs`);
    if (durationMs < 0)
      throw new ContractDecodeError(`${p}.durationMs`, "expected non-negative duration");
    const generated = optional(clip, "generated", boolean, p);
    return Object.freeze({
      name,
      durationMs,
      loop: boolean(clip.loop, `${p}.loop`),
      ...(generated === undefined ? {} : { generated }),
    });
  });
  if (kind !== "generated" && clips.some((clip) => clip.generated === true))
    throw new ContractDecodeError(
      `${path}.source.kind`,
      "generated clips require generated-asset provenance",
    );
  const rig = optional(
    output,
    "rig",
    (value, p) => {
      const rig = record(value, p);
      exactKeys(rig, ["template", "sha256"], [], p);
      return Object.freeze({
        template: string(rig.template, `${p}.template`),
        sha256: hash(rig.sha256, `${p}.sha256`),
      });
    },
    `${path}.output`,
  );
  const levels = optional(
    output,
    "levels",
    (value, p) => {
      const result = array(value, p, (value, p) => {
        const level = record(value, p);
        exactKeys(level, ["triangles"], ["path", "sha256"], p);
        if ((level.path === undefined) !== (level.sha256 === undefined))
          throw new ContractDecodeError(p, "path and sha256 must be supplied together");
        const levelPath = optional(level, "path", string, p);
        if (
          levelPath !== undefined &&
          (!levelPath.endsWith(".glb") ||
            !/^[a-zA-Z0-9_./-]+$/u.test(levelPath) ||
            levelPath.split("/").some((part) => !part || part === "." || part === ".."))
        )
          throw new ContractDecodeError(`${p}.path`, "expected a safe world-relative .glb path");
        return Object.freeze({
          triangles: nonNegativeInteger(level.triangles, `${p}.triangles`),
          ...(levelPath === undefined
            ? {}
            : { path: levelPath, sha256: hash(level.sha256, `${p}.sha256`) }),
        });
      });
      if (!result.length || result.length !== output.lods)
        throw new ContractDecodeError(p, "levels must contain exactly output.lods entries");
      const files = result[0]?.path !== undefined;
      if (result.some((level) => (level.path !== undefined) !== files))
        throw new ContractDecodeError(p, "levels must be all embedded or all separate files");
      if (
        files &&
        (result[0]?.path !== sourcePath ||
          result[0]?.sha256 !== output.sha256 ||
          new Set(result.map((level) => level.path)).size !== result.length)
      )
        throw new ContractDecodeError(
          p,
          "file levels need unique paths and level zero must match output path and hash",
        );
      return Object.freeze(result);
    },
    `${path}.output`,
  );
  const renditions = optional(
    output,
    "renditions",
    (value, p) =>
      Object.freeze(
        Object.fromEntries(
          Object.entries(record(value, p)).map(([tier, value]) => {
            string(tier, p);
            const indices = array(value, `${p}.${tier}`, nonNegativeInteger);
            if (
              !indices.length ||
              new Set(indices).size !== indices.length ||
              indices.some((index) => index >= Number(output.lods))
            )
              throw new ContractDecodeError(
                `${p}.${tier}`,
                "expected distinct existing level indices",
              );
            return [tier, Object.freeze(indices)];
          }),
        ),
      ),
    `${path}.output`,
  );
  const license = string(v.license, `${path}.license`);
  if (!/^[A-Za-z0-9.+-]+$/u.test(license))
    throw new ContractDecodeError(`${path}.license`, "expected an SPDX identifier");
  return Object.freeze({
    kind: "model",
    assetManifestVersion: 2,
    assetId,
    source: Object.freeze({
      kind,
      path: sourcePath,
      creator: string(source.creator, `${path}.source.creator`),
      tool: nullable(source.tool, `${path}.source.tool`, string),
    }),
    license,
    provenance: Object.freeze({
      prompt,
      references,
      ...metadata,
      ...(outputGrant === undefined ? {} : { outputGrant }),
    }),
    review: Object.freeze({ status, reviewer, reviewedAt, notes: review.notes }),
    semantic: Object.freeze({
      role: literal(
        semantic.role,
        ["actor", "object", "terrain", "effect"],
        `${path}.semantic.role`,
      ),
      entity: nullable(semantic.entity, `${path}.semantic.entity`, string),
      archetype: nullable(semantic.archetype, `${path}.semantic.archetype`, string),
    }),
    accessibilityLabel: string(v.accessibilityLabel, `${path}.accessibilityLabel`),
    output: Object.freeze({
      path: sourcePath,
      mediaType: literal(output.mediaType, ["model/gltf-binary"], `${path}.output.mediaType`),
      extension: literal(output.extension, ["glb"], `${path}.output.extension`),
      sha256: hash(output.sha256, `${path}.output.sha256`),
      ...decodeMetrics(
        Object.fromEntries(metrics.map((key) => [key, output[key]])),
        `${path}.output`,
      ),
      clips,
      bounds: Object.freeze({ min, max }),
      ...(rig === undefined ? {} : { rig }),
      ...(levels === undefined ? {} : { levels }),
      ...(renditions === undefined ? {} : { renditions }),
      ...(sideImages === undefined ? {} : { sideImages }),
      ...images,
      ...(tiers === undefined ? {} : { tiers }),
    }),
  });
}
const safePath = /^[a-zA-Z0-9_./-]+$/u;
function decodeImageSet(value: unknown, path: string, depth: number): ModelImageSet {
  const v = record(value, path);
  if ("path" in v) {
    exactKeys(v, ["path", "sha256"], [], path);
    const imagePath = string(v.path, `${path}.path`);
    if (
      !safePath.test(imagePath) ||
      imagePath.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw new ContractDecodeError(`${path}.path`, "expected a safe world-relative path");
    return Object.freeze({ path: imagePath, sha256: hash(v.sha256, `${path}.sha256`) });
  }
  const entries = Object.entries(v);
  if (!entries.length || depth >= 2)
    throw new ContractDecodeError(path, "expected an image or at most two levels of named images");
  return Object.freeze(
    Object.fromEntries(
      entries.map(([name, child]) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name))
          throw new ContractDecodeError(`${path}.${name}`, "expected a plain image name");
        return [name, decodeImageSet(child, `${path}.${name}`, depth + 1)];
      }),
    ),
  );
}
export function decodeAnyAssetManifest(
  value: unknown,
  path = "manifest",
): AssetManifest | ModelAssetManifest {
  return record(value, path).kind === "model"
    ? decodeModelAssetManifest(value, path)
    : decodeAssetManifest(value, path);
}
