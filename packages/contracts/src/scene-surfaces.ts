import { decodeOpaqueId, type ObjectId } from "./ids.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  integer,
  literal,
  record,
  string,
  unsignedDecimal,
} from "./validation.js";

/**
 * Surface presentation (issue 267): how a world draws the graded surface state its pack declares.
 * The look is derived from state and these records, never stored.
 */
export const SURFACE_TIERS = ["low", "medium", "high"] as const;
export type SurfaceTier = (typeof SURFACE_TIERS)[number];
/** The most close-range mark decals a world draws per tier; a decision matching the zone ceiling. */
export const MAX_SURFACE_DECALS = 256;

/** One tier's renderer-neutral treatment of a band: a tint over the zone and whether marks show. */
export interface SurfaceTierTreatment {
  readonly tint: string;
  readonly opacity: number;
  readonly marks: boolean;
}
export type SurfaceTierTreatments = Readonly<Record<SurfaceTier, SurfaceTierTreatment>>;
export type SurfaceDecalBudgets = Readonly<Record<SurfaceTier, number>>;

/** A pack presentation's surface bindings: zone labels, band treatments and decal budgets. */
export interface PackSurfacePresentation {
  readonly decals: SurfaceDecalBudgets;
  readonly zones: readonly { readonly zoneId: string; readonly label: string }[];
  readonly treatments: readonly {
    readonly channel: string;
    readonly band: string;
    /** Plain text completing the zone's label into the text path's sentence ("is scratched"). */
    readonly phrase: string;
    readonly tiers: SurfaceTierTreatments;
  }[];
}

function text(value: unknown, path: string): string {
  const s = string(value, path);
  if (s.trim() === "" || s.trim() !== s)
    throw new ContractDecodeError(path, "expected non-empty text without surrounding whitespace");
  return s;
}
function tint(value: unknown, path: string): string {
  const c = string(value, path);
  if (!/^#[0-9a-f]{6}$/u.test(c)) throw new ContractDecodeError(path, "expected RGB hex colour");
  return c;
}
function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  const n = integer(value, path);
  if (n < min || n > max) throw new ContractDecodeError(path, `expected ${min} to ${max}`);
  return n;
}

export function decodeSurfaceTierTreatments(value: unknown, path: string): SurfaceTierTreatments {
  const v = record(value, path);
  exactKeys(v, SURFACE_TIERS, [], path);
  const tier = (key: SurfaceTier): SurfaceTierTreatment => {
    const p = `${path}.${key}`;
    const t = record(v[key], p);
    exactKeys(t, ["tint", "opacity", "marks"], [], p);
    if (typeof t.opacity !== "number" || !Number.isFinite(t.opacity))
      throw new ContractDecodeError(`${p}.opacity`, "expected a number from 0 to 1");
    if (t.opacity < 0 || t.opacity > 1)
      throw new ContractDecodeError(`${p}.opacity`, "expected a number from 0 to 1");
    if (typeof t.marks !== "boolean")
      throw new ContractDecodeError(`${p}.marks`, "expected a boolean");
    return { tint: tint(t.tint, `${p}.tint`), opacity: t.opacity, marks: t.marks };
  };
  return { low: tier("low"), medium: tier("medium"), high: tier("high") };
}

function decodeDecalBudgets(value: unknown, path: string): SurfaceDecalBudgets {
  const v = record(value, path);
  exactKeys(v, SURFACE_TIERS, [], path);
  const budget = (key: SurfaceTier) =>
    boundedInteger(v[key], `${path}.${key}`, 0, MAX_SURFACE_DECALS);
  return { low: budget("low"), medium: budget("medium"), high: budget("high") };
}

export function decodePackSurfacePresentation(
  value: unknown,
  path = "surfaces",
): PackSurfacePresentation {
  const v = record(value, path);
  exactKeys(v, ["decals", "zones", "treatments"], [], path);
  const zoneIds = new Set<string>();
  const zones = array(v.zones, `${path}.zones`, (item, p) => {
    const zone = record(item, p);
    exactKeys(zone, ["zoneId", "label"], [], p);
    const zoneId = text(zone.zoneId, `${p}.zoneId`);
    if (zoneIds.has(zoneId)) throw new ContractDecodeError(`${p}.zoneId`, "duplicate zone");
    zoneIds.add(zoneId);
    return { zoneId, label: text(zone.label, `${p}.label`) };
  });
  const bands = new Set<string>();
  const treatments = array(v.treatments, `${path}.treatments`, (item, p) => {
    const t = record(item, p);
    exactKeys(t, ["channel", "band", "phrase", "tiers"], [], p);
    const channel = text(t.channel, `${p}.channel`);
    const band = text(t.band, `${p}.band`);
    const key = JSON.stringify([channel, band]);
    if (bands.has(key)) throw new ContractDecodeError(p, "duplicate channel band");
    bands.add(key);
    return {
      channel,
      band,
      phrase: text(t.phrase, `${p}.phrase`),
      tiers: decodeSurfaceTierTreatments(t.tiers, `${p}.tiers`),
    };
  });
  return { decals: decodeDecalBudgets(v.decals, `${path}.decals`), zones, treatments };
}

export interface SurfaceDecalRefusal {
  readonly code: "SURFACE_DECAL_BUDGET_EXCEEDED";
  readonly tier: SurfaceTier;
  readonly required: number;
  readonly budget: number;
}

/**
 * Whether a presentation's decal budget holds every mark its pack can keep: at each tier, the summed
 * mark capacity of the labelled zones with a channel whose band treatment draws marks at that tier
 * must fit that tier's budget, so a renderer never has to drop a mark. `undefined` when it fits.
 */
export function surfaceDecalRefusal(
  surfaces: PackSurfacePresentation,
  zones: readonly {
    readonly zoneId: string;
    readonly channels: readonly string[];
    readonly markCapacity: number;
  }[],
): SurfaceDecalRefusal | undefined {
  const labelled = new Set(surfaces.zones.map((zone) => zone.zoneId));
  for (const tier of SURFACE_TIERS) {
    const marked = new Set(
      surfaces.treatments.filter((t) => t.tiers[tier].marks).map((t) => t.channel),
    );
    const required = zones
      .filter((zone) => labelled.has(zone.zoneId) && zone.channels.some((c) => marked.has(c)))
      .reduce((sum, zone) => sum + zone.markCapacity, 0);
    const budget = surfaces.decals[tier];
    if (required > budget) return { code: "SURFACE_DECAL_BUDGET_EXCEEDED", tier, required, budget };
  }
  return undefined;
}

/** Where a projected zone is: on a projected object, or a region's rectangle bounds in its frame. */
export type SceneSurfaceHost =
  | { readonly kind: "object"; readonly objectId: ObjectId }
  | {
      readonly kind: "region";
      readonly regionId: string;
      readonly frameId: string;
      readonly frameVersion: number;
      readonly min: readonly string[];
      readonly max: readonly string[];
    };
export interface SceneSurfaceMark {
  /** The marking actor; null when the scene does not project it (it is never named there). */
  readonly actorId: ObjectId | null;
  readonly at: bigint;
  readonly intensity: number;
  readonly point: { readonly u: number; readonly v: number };
}
/** One projected zone: its settled level, the treatments of its current bands and its recent marks. */
export interface SceneSurfaceZone {
  readonly zoneId: string;
  readonly label: string;
  readonly host: SceneSurfaceHost;
  readonly channels: readonly {
    readonly channel: string;
    readonly value: number;
    readonly max: number;
    readonly bands: readonly string[];
  }[];
  readonly treatments: readonly {
    readonly channel: string;
    readonly band: string;
    readonly tiers: SurfaceTierTreatments;
  }[];
  /** The zone's ring of recent marks, oldest first. */
  readonly marks: readonly SceneSurfaceMark[];
  /** The text path's sentence; null when no current band has a treatment. */
  readonly sentence: string | null;
}
export interface SceneSurfaces {
  readonly decals: SurfaceDecalBudgets;
  readonly zones: readonly SceneSurfaceZone[];
}

function decimal(value: unknown, path: string): string {
  const s = string(value, path);
  if (!/^-?(0|[1-9][0-9]*)$/u.test(s)) throw new ContractDecodeError(path, "expected a decimal");
  return s;
}

function decodeHost(value: unknown, path: string): SceneSurfaceHost {
  const v = record(value, path);
  const kind = literal(v.kind, ["object", "region"], `${path}.kind`);
  if (kind === "object") {
    exactKeys(v, ["kind", "objectId"], [], path);
    return { kind, objectId: decodeOpaqueId(v.objectId, "ObjectId", `${path}.objectId`) };
  }
  exactKeys(v, ["kind", "regionId", "frameId", "frameVersion", "min", "max"], [], path);
  const corner = (c: unknown, p: string) => {
    const list = array(c, p, decimal);
    if (list.length !== 2) throw new ContractDecodeError(p, "expected two coordinates");
    return list;
  };
  return {
    kind,
    regionId: text(v.regionId, `${path}.regionId`),
    frameId: text(v.frameId, `${path}.frameId`),
    frameVersion: boundedInteger(v.frameVersion, `${path}.frameVersion`, 1, 2 ** 31 - 1),
    min: corner(v.min, `${path}.min`),
    max: corner(v.max, `${path}.max`),
  };
}

function decodeSceneSurfaceZone(value: unknown, path: string): SceneSurfaceZone {
  const v = record(value, path);
  exactKeys(
    v,
    ["zoneId", "label", "host", "channels", "treatments", "marks", "sentence"],
    [],
    path,
  );
  return {
    zoneId: text(v.zoneId, `${path}.zoneId`),
    label: text(v.label, `${path}.label`),
    host: decodeHost(v.host, `${path}.host`),
    channels: array(v.channels, `${path}.channels`, (item, p) => {
      const c = record(item, p);
      exactKeys(c, ["channel", "value", "max", "bands"], [], p);
      const max = boundedInteger(c.max, `${p}.max`, 1, 1_000_000);
      return {
        channel: text(c.channel, `${p}.channel`),
        value: boundedInteger(c.value, `${p}.value`, 0, max),
        max,
        bands: array(c.bands, `${p}.bands`, text),
      };
    }),
    treatments: array(v.treatments, `${path}.treatments`, (item, p) => {
      const t = record(item, p);
      exactKeys(t, ["channel", "band", "tiers"], [], p);
      return {
        channel: text(t.channel, `${p}.channel`),
        band: text(t.band, `${p}.band`),
        tiers: decodeSurfaceTierTreatments(t.tiers, `${p}.tiers`),
      };
    }),
    marks: array(v.marks, `${path}.marks`, (item, p) => {
      const m = record(item, p);
      exactKeys(m, ["actorId", "at", "intensity", "point"], [], p);
      const point = record(m.point, `${p}.point`);
      exactKeys(point, ["u", "v"], [], `${p}.point`);
      return {
        actorId: m.actorId === null ? null : decodeOpaqueId(m.actorId, "ObjectId", `${p}.actorId`),
        at: unsignedDecimal(m.at, `${p}.at`),
        intensity: boundedInteger(m.intensity, `${p}.intensity`, 1, 10_000),
        point: {
          u: boundedInteger(point.u, `${p}.point.u`, 0, 10_000),
          v: boundedInteger(point.v, `${p}.point.v`, 0, 10_000),
        },
      };
    }),
    sentence: v.sentence === null ? null : text(v.sentence, `${path}.sentence`),
  };
}

/**
 * Distinct zones; given the projected entities, an object host and a named mark actor must be among
 * them, never a hidden one (a patch's surfaces are checked where the patch is applied).
 */
export function decodeSceneSurfaces(
  value: unknown,
  path = "surfaces",
  projected?: ReadonlySet<ObjectId>,
): SceneSurfaces {
  const v = record(value, path);
  exactKeys(v, ["decals", "zones"], [], path);
  const seen = new Set<string>();
  const zones = array(v.zones, `${path}.zones`, (item, p) => {
    const zone = decodeSceneSurfaceZone(item, p);
    if (seen.has(zone.zoneId)) throw new ContractDecodeError(`${p}.zoneId`, "duplicate zone");
    seen.add(zone.zoneId);
    if (zone.host.kind === "object" && projected && !projected.has(zone.host.objectId))
      throw new ContractDecodeError(`${p}.host.objectId`, "entity is not projected");
    zone.marks.forEach((mark, i) => {
      if (mark.actorId !== null && projected && !projected.has(mark.actorId))
        throw new ContractDecodeError(`${p}.marks[${i}].actorId`, "entity is not projected");
    });
    return zone;
  });
  return { decals: decodeDecalBudgets(v.decals, `${path}.decals`), zones };
}
