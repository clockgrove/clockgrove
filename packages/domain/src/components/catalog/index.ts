import {
  decodeOpaqueId,
  type ObjectId,
  type PartitionId,
  type PrivacyCeiling,
  type SimTimeMs,
  type TenantId,
  type TimelineId,
  type WorldId,
} from "@clockgrove/contracts";
import { z } from "zod";
import {
  fixedPoint,
  type SemanticPose,
  type SpatialFrame,
  validateSpatialBinding,
} from "../../spatial.js";
import type { WorldNeeds } from "../../world.js";

export interface CanonicalCodec<T> {
  encode(value: T): string;
  decode(canonical: string): T;
}

export interface ComponentSnapshot<T = unknown> {
  readonly type: string;
  readonly version: number;
  readonly state: T;
}

export interface DomainIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ComponentValidationContext {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly objectId: ObjectId;
  /** The enclosing world partition, when the caller knows it; Portal refuses other partitions. */
  readonly partitionId?: PartitionId;
  readonly simulationTime: SimTimeMs;
  readonly spatialFrames: readonly SpatialFrame[];
  readonly expectedArchetype?: PinnedReference;
  readonly expectedTraits?: readonly PinnedReference[];
}

export interface AccessPolicy {
  readonly privacyCeiling: PrivacyCeiling;
}

const MAX_TIME = (1n << 63n) - 1n;
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const name = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value);
const positiveVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const quantity = z
  .number()
  .int()
  .min(0)
  .max(10_000)
  .refine((value) => !Object.is(value, -0));
const time = z
  .bigint()
  .min(0n)
  .max(MAX_TIME)
  .transform((value) => value as SimTimeMs);
const hungerRemainder = z
  .bigint()
  .min(0n)
  .max(MAX_TIME - 1n);
const wetnessRemainder = z
  .bigint()
  .min(0n)
  .max(MAX_TIME * 100_000_000n - 1n);
const coordinate = z
  .bigint()
  .refine((value) => value.toString().length <= 256)
  .transform(fixedPoint);
const decimal = z
  .string()
  .max(256)
  .regex(/^(?:0|-?[1-9][0-9]*)$/u)
  .transform(BigInt);

function id<Name extends string>(brand: Name) {
  return z
    .string()
    .min(1)
    .refine((value) => value.trim() === value)
    .transform((value) => decodeOpaqueId(value, brand));
}

const reference = z.strictObject({ id: name, version: positiveVersion }).readonly();
export type PinnedReference = z.infer<typeof reference>;
const compareReference = (left: PinnedReference, right: PinnedReference): number =>
  compareText(left.id, right.id) || left.version - right.version;
const traits = z
  .array(reference)
  .max(10_000)
  .refine(
    (values) => new Set(values.map((value) => value.id)).size === values.length,
    "duplicate trait identity",
  )
  .transform((values) => values.sort(compareReference))
  .readonly();
const aliases = z
  .array(name)
  .max(10_000)
  .refine((values) => new Set(values).size === values.length, "duplicate alias")
  .transform((values) => values.sort(compareText))
  .readonly();

// Inspect data descriptors before Zod reads values. Do not invoke accessors or freeze caller data.
function assertData(value: unknown, path = "state", ancestors = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) throw new TypeError(`${path}: cyclic data`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    throw new TypeError(`${path}: expected plain data`);
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== "string" ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      descriptor.value === undefined
    )
      throw new TypeError(`${path}: expected defined enumerable data fields`);
    if (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/u.test(key))
      throw new TypeError(`${path}: unknown array field`);
    assertData(descriptor.value, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function dataSchema<S extends z.ZodType>(schema: S) {
  return z.preprocess((value) => {
    assertData(value);
    return value;
  }, schema);
}

export const identitySchema = dataSchema(
  z
    .strictObject({
      objectId: id("ObjectId"),
      displayName: name,
      aliases,
      owner: id("PrincipalId").optional(),
    })
    .readonly(),
);
export type IdentityState = z.infer<typeof identitySchema>;
export const archetypeSchema = dataSchema(
  z.strictObject({ archetype: reference, traits }).readonly(),
);
export type ArchetypeState = z.infer<typeof archetypeSchema>;

function spatialShape<C extends z.ZodType<ReturnType<typeof fixedPoint>>>(scalar: C) {
  return z
    .strictObject({
      spaceId: id("SpaceId"),
      pose: z
        .strictObject({
          frameId: id("SpatialFrameId"),
          frameVersion: positiveVersion,
          coordinates: z
            .union([z.tuple([scalar, scalar]), z.tuple([scalar, scalar, scalar])])
            .readonly(),
        })
        .readonly(),
      locationId: id("ObjectId").optional(),
    })
    .readonly();
}
export const spatialTransformSchema = dataSchema(spatialShape(coordinate));
export type SpatialTransformState = z.infer<typeof spatialTransformSchema>;

function needsShape<
  T extends z.ZodType<SimTimeMs>,
  H extends z.ZodType<bigint>,
  W extends z.ZodType<bigint>,
>(t: T, h: H, w: W) {
  return z
    .strictObject({
      hunger: quantity,
      wetness: quantity,
      integratedAt: t,
      hungerRemainder: h,
      wetnessRemainder: w,
    })
    .readonly();
}
export const needsSchema = dataSchema(needsShape(time, hungerRemainder, wetnessRemainder));
export type NeedsState = z.infer<typeof needsSchema>;
export const weatherExposureSchema = dataSchema(
  z.strictObject({ rainProtection: quantity }).readonly(),
);
export type WeatherExposureState = z.infer<typeof weatherExposureSchema>;

/** Material units are exact safe integers; aggregate totals use bigint. */
export const materialQuantitySchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => !Object.is(value, -0));
export const RESOURCE_KINDS = Object.freeze(["food", "water"] as const);
export const containmentSchema = dataSchema(
  z
    .strictObject({
      kind: z.enum(["object", "persona-inventory"]),
      capacity: materialQuantitySchema.refine((value) => value > 0),
      containerId: id("ObjectId").optional(),
    })
    .readonly(),
);
export type ContainmentState = z.infer<typeof containmentSchema>;
export const resourceSchema = dataSchema(
  z
    .strictObject({
      kind: z.enum(RESOURCE_KINDS),
      quantity: materialQuantitySchema,
    })
    .readonly(),
);
export type ResourceState = z.infer<typeof resourceSchema>;
export const lifecycleSchema = dataSchema(
  z
    .strictObject({
      status: z.enum(["active", "retired", "dead"]),
    })
    .readonly(),
);
export type LifecycleState = z.infer<typeof lifecycleSchema>;
export const ANIMATION_FAMILIES = Object.freeze([
  "idle",
  "walk",
  "sniff",
  "eat",
  "play",
  "shelter",
  "static",
  "loop",
] as const);
export const presentationSchema = dataSchema(
  z
    .strictObject({
      assetId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
      animationFamily: z.enum(ANIMATION_FAMILIES),
      accessibilityLabel: name,
    })
    .readonly(),
);
export type PresentationState = z.infer<typeof presentationSchema>;

/**
 * A portal endpoint names a place of the enclosing partition: an anchor or a region. `worldId`
 * and `partitionId` are optional; when present they must name the enclosing world and partition,
 * because version 1 never crosses worlds or partitions (cross-space transfer is Wave 11).
 */
const portalScope = {
  worldId: id("WorldId").optional(),
  partitionId: id("PartitionId").optional(),
};
const portalEndpoint = z.union([
  z.strictObject({ kind: z.literal("anchor"), anchorId: name, ...portalScope }).readonly(),
  z.strictObject({ kind: z.literal("region"), regionId: name, ...portalScope }).readonly(),
]);
export const PORTAL_STATUSES = Object.freeze(["open", "closed"] as const);
export const portalSchema = dataSchema(
  z
    .strictObject({
      status: z.enum(PORTAL_STATUSES),
      endpoints: z.tuple([portalEndpoint, portalEndpoint]).readonly(),
    })
    .readonly(),
);
export type PortalState = z.infer<typeof portalSchema>;
export type PortalEndpoint = PortalState["endpoints"][number];

/** The place id of an endpoint, whichever kind it is. */
export function portalPlaceId(endpoint: PortalEndpoint): string {
  return endpoint.kind === "anchor" ? endpoint.anchorId : endpoint.regionId;
}

/**
 * Scope and self-link issues of a portal, without consulting places: `cross-world` and
 * `cross-partition` at `<path>.endpoints[i].worldId|partitionId`, `self-link` at
 * `<path>.endpoints[1]`. Unknown places are checked against the partition state
 * (`validatePortals`), which the component context does not carry.
 */
export function portalScopeIssues(
  portal: PortalState,
  scope: { readonly worldId: string; readonly partitionId?: string | undefined },
  path: string,
): DomainIssue[] {
  const issues: DomainIssue[] = [];
  portal.endpoints.forEach((endpoint, index) => {
    if (endpoint.worldId !== undefined && endpoint.worldId !== scope.worldId)
      issues.push(
        issue(
          "cross-world",
          `${path}.endpoints[${index}].worldId`,
          "a portal joins places of its own world",
        ),
      );
    if (
      endpoint.partitionId !== undefined &&
      scope.partitionId !== undefined &&
      endpoint.partitionId !== scope.partitionId
    )
      issues.push(
        issue(
          "cross-partition",
          `${path}.endpoints[${index}].partitionId`,
          "a portal joins places of its own partition",
        ),
      );
  });
  const [first, second] = portal.endpoints;
  if (first.kind === second.kind && portalPlaceId(first) === portalPlaceId(second))
    issues.push(issue("self-link", `${path}.endpoints[1]`, "a portal joins two distinct places"));
  return issues;
}

function issue(code: string, path: string, message: string): DomainIssue {
  return { code, path, message };
}

function registration<T>(
  type: string,
  schema: z.ZodType<T>,
  wireSchema: z.ZodType<T>,
  invariants: (value: T, context: ComponentValidationContext) => DomainIssue[],
) {
  const upcasters: never[] = [];
  Object.freeze(upcasters);
  const encode = (value: T): string =>
    JSON.stringify({ type, version: 1, state: schema.parse(value) }, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    );
  const canonicalCodec: CanonicalCodec<T> = Object.freeze({
    encode,
    decode(canonical: string): T {
      const envelope = z
        .strictObject({ type: z.literal(type), version: z.literal(1), state: wireSchema })
        .parse(JSON.parse(canonical));
      if (encode(envelope.state) !== canonical)
        throw new TypeError("canonical: noncanonical component encoding");
      return envelope.state;
    },
  });
  return Object.freeze({
    type,
    version: 1 as const,
    schema,
    canonicalCodec,
    validateState(value: T, context: ComponentValidationContext): DomainIssue[] {
      let parsed: T;
      try {
        parsed = schema.parse(value);
      } catch (error) {
        if (error instanceof z.ZodError)
          return error.issues.map((entry) =>
            issue(
              "invalid-state",
              entry.path.length ? `state.${entry.path.join(".")}` : "state",
              entry.message,
            ),
          );
        return [
          issue("invalid-state", "state", error instanceof Error ? error.message : "invalid data"),
        ];
      }
      return invariants(parsed, context);
    },
    privacyClass: "public_scene" as const,
    redact(value: T, access: AccessPolicy): T | null {
      return access.privacyCeiling.allowedCategories.includes("public_scene")
        ? schema.parse(value)
        : null;
    },
    // Version one has no predecessors. No migration compatibility is implied.
    upcasters,
  });
}

export function createInitialComponentCatalog() {
  const identity = registration(
    "clockgrove.identity",
    identitySchema,
    identitySchema,
    (value, context) =>
      value.objectId === context.objectId
        ? []
        : [issue("identity-mismatch", "state.objectId", "does not match the context object")],
  );
  const archetype = registration(
    "clockgrove.archetype",
    archetypeSchema,
    archetypeSchema,
    (value, context) => {
      const issues: DomainIssue[] = [];
      if (
        context.expectedArchetype !== undefined &&
        compareReference(value.archetype, context.expectedArchetype) !== 0
      )
        issues.push(
          issue(
            "identity-mismatch",
            "state.archetype",
            "does not match the expected archetype pin",
          ),
        );
      if (context.expectedTraits !== undefined) {
        const expected = [...context.expectedTraits].sort(compareReference);
        if (
          expected.length !== value.traits.length ||
          expected.some((pin, index) => compareReference(pin, value.traits[index]!) !== 0)
        )
          issues.push(
            issue("identity-mismatch", "state.traits", "does not match the expected trait pins"),
          );
      }
      return issues;
    },
  );
  const spatialTransform = registration(
    "clockgrove.spatial-transform",
    spatialTransformSchema,
    dataSchema(spatialShape(decimal.pipe(coordinate))),
    (value, context) => {
      const frame = context.spatialFrames.find(
        (candidate) => candidate.frameId === value.pose.frameId,
      );
      if (frame === undefined || frame.version !== value.pose.frameVersion)
        return [
          issue("scope-mismatch", "state.pose", "does not reference a declared frame version"),
        ];
      try {
        validateSpatialBinding(frame, {
          identity: { objectId: context.objectId },
          pose: value.pose satisfies SemanticPose,
        });
      } catch (error) {
        return [
          issue(
            "invalid-state",
            "state.pose",
            error instanceof Error ? error.message : "invalid spatial binding",
          ),
        ];
      }
      return [];
    },
  );
  const needs = registration(
    "clockgrove.needs",
    needsSchema,
    dataSchema(
      needsShape(decimal.pipe(time), decimal.pipe(hungerRemainder), decimal.pipe(wetnessRemainder)),
    ),
    (value, context) => {
      const needs: WorldNeeds = value;
      if (
        typeof context.simulationTime !== "bigint" ||
        context.simulationTime < 0n ||
        context.simulationTime > MAX_TIME
      )
        return [
          issue(
            "invalid-state",
            "context.simulationTime",
            "must be nonnegative signed-64-bit simulation milliseconds",
          ),
        ];
      return needs.integratedAt > context.simulationTime
        ? [
            issue(
              "invalid-state",
              "state.integratedAt",
              "must not exceed the context simulation time",
            ),
          ]
        : [];
    },
  );
  const weatherExposure = registration(
    "clockgrove.weather-exposure",
    weatherExposureSchema,
    weatherExposureSchema,
    () => [],
  );
  const containment = registration(
    "clockgrove.containment",
    containmentSchema,
    containmentSchema,
    (value, context) =>
      value.containerId === context.objectId
        ? [issue("invalid-state", "state.containerId", "object cannot contain itself")]
        : [],
  );
  const resource = registration("clockgrove.resource", resourceSchema, resourceSchema, () => []);
  const lifecycle = registration(
    "clockgrove.lifecycle",
    lifecycleSchema,
    lifecycleSchema,
    () => [],
  );
  const presentation = registration(
    "clockgrove.presentation",
    presentationSchema,
    presentationSchema,
    () => [],
  );
  const portal = registration("clockgrove.portal", portalSchema, portalSchema, (value, context) =>
    portalScopeIssues(value, context, "state"),
  );
  return Object.freeze([
    identity,
    archetype,
    spatialTransform,
    needs,
    weatherExposure,
    containment,
    resource,
    lifecycle,
    portal,
    presentation,
  ] as const);
}
