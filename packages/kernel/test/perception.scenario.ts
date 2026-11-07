import type { ObjectId, SpaceId } from "@clockgrove/contracts";
import { createWorldState, type WorldEntity, type WorldState } from "@clockgrove/domain";
import { canonicalSerialize } from "../src/canonical.js";
import {
  type AudienceOutcome,
  type AudienceResolution,
  CANDIDATE_SOURCES,
  EXCLUSION_CODES,
  PERCEIVABLE_EVENT_TYPES,
  PERCEPTION_MODALITIES,
  REDUCTION_CODE,
  RESOLVER_VERSION,
  type ResolveAudienceOptions,
  resolveAudience,
} from "../src/perception/resolver.js";
import { drawNamedRandomStream, initializeNamedRandomStreams } from "../src/random.js";
import { executeWorldKernel, type WorldKernelInput } from "../src/world.js";
import {
  containmentFixture,
  containmentInput,
  containmentInputIdentity,
  fixturePayload,
} from "./containment.scenario.js";
import { assertEnvelope } from "./executor.scenario.js";
import {
  createLinearTestIndex,
  createThrowingTestIndex,
  GROUND,
  mover,
  spatialFixture,
} from "./spatial.scenario.js";
import { PERCEPTION_REFUSAL_CASES } from "./spatial-evidence.js";

export const perceptionSeed = { version: 1, seed: "perception-audience-v1" } as const;
const streams = ["behavior", "lifecycle", "perception", "weather"];
const HEX64 = /^[0-9a-f]{64}$/u;

export interface EventFixture {
  version: number;
  type: string;
  eventId: string;
  modality: string;
  sourceRevision: bigint;
  spaceId: string;
  actorId: string | null;
  targetId: string | null;
  regionIds: string[];
}
export interface PolicyFixture {
  version: number;
  modalities: { modality: string; range: number }[];
  occlusions: { observerId: string; modality: string }[];
  access: { observerId: string; effect: string }[];
  subscribers: { observerId: string }[];
  viewers: { viewerId: string; subscribed: boolean }[];
}
export interface PerceptionCase {
  readonly label: string;
  readonly event: unknown;
  readonly state: unknown;
  readonly policy: unknown;
  readonly options?: ResolveAudienceOptions;
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`perception assertion failed: ${what}`);
}

// ---------------------------------------------------------------------------------------------
// Fixtures over the RW-0105a anchor world and the RW-0104 containment fixture.
// ---------------------------------------------------------------------------------------------

const at = (id: string, x: number, y: number, space = "yard", extra: Partial<WorldEntity> = {}) =>
  mover(id, [BigInt(x), BigInt(y)], { spaceId: space as SpaceId, ...extra });

/**
 * Ground-plane world: walker stands on the porch inside porch-box; others surround it. The declared
 * semantic hierarchy is town → yard-lot → porch, so townsfolk, standing in the town just north of
 * the yard lot, is in an ancestor place of the walker's porch.
 */
export async function anchorWorld(): Promise<WorldState> {
  const place = (
    regionId: string,
    min: [bigint, bigint],
    max: [bigint, bigint],
    parent?: string,
  ) => ({
    regionId,
    version: 1,
    frameId: GROUND,
    frameVersion: 1,
    shape: { kind: "rectangle" as const, min, max },
    ...(parent === undefined ? {} : { parent: { regionId: parent, version: 1 } }),
  });
  const base = await spatialFixture([
    at("walker", 4000, 0, "yard", {
      containment: { kind: "object", capacity: 1, containerId: "porch-box" as ObjectId },
    }),
    at("porch-box", 4000, 0, "yard", { containment: { kind: "object", capacity: 2 } }),
    at("bowl", 3800, 200),
    at("mover", 4500, 500),
    at("hidden", 3500, 0),
    at("private-neighbour", 4200, 200),
    at("reduced-neighbour", 4300, -200),
    at("yard-far", 8000, 0),
    at("street-sitter", 4800, -300, "street"),
    at("townsfolk", 4000, 1400, "town"),
    at("subscriber", -5000, 3000, "elsewhere"),
    at("sleeper", 4100, 100, "yard", { lifecycle: { status: "dead" } }),
  ]);
  const state = base.partition.state;
  return createWorldState({
    ...state,
    spatialRegions: [
      ...(state.spatialRegions ?? []).map((region) =>
        region.regionId === "porch"
          ? { ...region, parent: { regionId: "yard-lot", version: 1 } }
          : region,
      ),
      place("town", [0n, -3000n], [12000n, 10000n]),
      place("yard-lot", [3400n, -1300n], [9000n, 1300n], "town"),
    ] as never,
  });
}

/** Containment fixture: box-b holds food-a and sits inside box-a (created through the real executor). */
export async function containmentWorld(): Promise<WorldState> {
  let current: WorldKernelInput = await containmentFixture();
  const step = (id: string, type: string, payload: unknown) => {
    const outcome = executeWorldKernel(containmentInput(current, type, payload, id), {
      mode: "test",
    });
    if (!outcome.ok) throw new Error(`containment fixture step refused: ${id}`);
    const state = outcome.result.state;
    current = {
      ...current,
      partition: { ...current.partition, state, revision: state.revision },
      schedules: outcome.result.schedules,
      simulationTime: state.simulationTime,
    };
  };
  for (const id of ["box-a", "box-b", "inventory", "food-a", "food-b", "water"])
    step(
      `perception:create:${id}`,
      "object.create",
      fixturePayload(
        current,
        id,
        id.startsWith("food")
          ? { kind: "food", quantity: 10 }
          : id === "water"
            ? { kind: "water", quantity: 2 }
            : undefined,
        2,
        id === "inventory" ? "persona-inventory" : "object",
      ),
    );
  step("perception:put:food", "containment.put", {
    schemaVersion: 1,
    objectId: "food-a",
    containerId: "box-b",
  });
  step("perception:put:box", "containment.put", {
    schemaVersion: 1,
    objectId: "box-b",
    containerId: "box-a",
  });
  return current.partition.state;
}

export function baseEvent(state: WorldState): EventFixture {
  return {
    version: 1,
    type: "movement.region-entered",
    eventId: "event-1",
    modality: "sound",
    sourceRevision: state.revision,
    spaceId: "yard",
    actorId: "walker",
    targetId: "bowl",
    regionIds: ["porch"],
  };
}
export function basePolicy(): PolicyFixture {
  return {
    version: 2,
    modalities: [
      { modality: "sight", range: 3000 },
      { modality: "sound", range: 1500 },
    ],
    occlusions: [{ observerId: "hidden", modality: "sound" }],
    access: [
      { observerId: "private-neighbour", effect: "deny" },
      { observerId: "reduced-neighbour", effect: "reduce" },
    ],
    subscribers: [{ observerId: "subscriber" }],
    viewers: [
      { viewerId: "viewer:subscribed", subscribed: true },
      { viewerId: "viewer:watching", subscribed: false },
    ],
  };
}
export function containmentEvent(state: WorldState): EventFixture {
  return {
    version: 1,
    type: "resource.offered",
    eventId: "event-containment",
    modality: "touch",
    sourceRevision: state.revision,
    spaceId: "fixture-space",
    actorId: "food-a",
    targetId: "food-b",
    regionIds: [],
  };
}
export function containmentPolicy(): PolicyFixture {
  return {
    version: 2,
    modalities: [{ modality: "touch", range: 0 }],
    occlusions: [],
    access: [{ observerId: "water", effect: "reduce" }],
    subscribers: [{ observerId: "inventory" }],
    viewers: [{ viewerId: "viewer:ui", subscribed: true }],
  };
}

// ---------------------------------------------------------------------------------------------
// Seeded generated events (named random streams only).
// ---------------------------------------------------------------------------------------------

function generator() {
  let driver = initializeNamedRandomStreams(perceptionSeed, streams);
  return (limit: number): number => {
    const result = drawNamedRandomStream(driver, "perception");
    driver = result.randomState;
    return Number(result.draw.rawValue + 2147483648n) % limit;
  };
}

interface World {
  readonly name: string;
  readonly state: WorldState;
  readonly regions: readonly string[];
  readonly maxRange: number;
  readonly count: number;
}

export function generatedCases(
  anchor: WorldState,
  containment: WorldState,
  count = 12,
): PerceptionCase[] {
  const next = generator();
  const worlds: World[] = [
    {
      name: "anchor",
      state: anchor,
      regions: ["garden", "pond", "porch"],
      maxRange: 6,
      count,
    },
    {
      name: "containment",
      state: containment,
      regions: [],
      maxRange: 2,
      count: Math.max(1, count - 4),
    },
  ];
  const cases: PerceptionCase[] = [];
  for (const world of worlds) {
    const ids = world.state.entities.map((entity) => entity.objectId as string);
    const distinct = (limit: number): string[] => {
      const chosen = new Set<string>();
      for (let index = next(limit + 1); index > 0; index -= 1) chosen.add(ids[next(ids.length)]!);
      return [...chosen];
    };
    for (let index = 0; index < world.count; index += 1) {
      const actor = world.state.entities[next(ids.length)]!;
      const modality = PERCEPTION_MODALITIES[next(PERCEPTION_MODALITIES.length)]!;
      const event: EventFixture = {
        version: 1,
        type: PERCEIVABLE_EVENT_TYPES[next(PERCEIVABLE_EVENT_TYPES.length)]!,
        eventId: `event:${world.name}:${index}`,
        modality,
        sourceRevision: world.state.revision,
        spaceId: actor.spaceId,
        actorId: actor.objectId,
        targetId: next(3) === 0 ? null : ids[next(ids.length)]!,
        regionIds: world.regions.filter(() => next(3) === 0),
      };
      const occlusions = new Map<string, { observerId: string; modality: string }>();
      for (let count = next(3); count > 0; count -= 1) {
        const entry = {
          observerId: ids[next(ids.length)]!,
          modality: PERCEPTION_MODALITIES[next(PERCEPTION_MODALITIES.length)]!,
        };
        occlusions.set(`${entry.observerId}/${entry.modality}`, entry);
      }
      const policy: PolicyFixture = {
        version: 2,
        modalities: PERCEPTION_MODALITIES.filter(() => next(3) !== 0).map((name) => ({
          modality: name,
          range: next(world.maxRange) * 1000,
        })),
        occlusions: [...occlusions.values()],
        access: distinct(2).map((observerId) => ({
          observerId,
          effect: next(2) === 0 ? "deny" : "reduce",
        })),
        subscribers: distinct(2).map((observerId) => ({ observerId })),
        viewers: Array.from({ length: 2 + next(2) }, (_, viewer) => ({
          viewerId: `viewer:${viewer}`,
          subscribed: next(2) === 1,
        })),
      };
      cases.push({ label: `generated:${world.name}:${index}`, event, state: world.state, policy });
    }
  }
  return cases;
}

/** Checks every generated-event property against one successful resolution. */
export function assertResolution(
  event: EventFixture,
  state: WorldState,
  policy: PolicyFixture,
  outcome: AudienceOutcome,
): AudienceResolution {
  if (!outcome.ok)
    throw new Error(
      `perception assertion failed: resolved input refused with ${canonicalSerialize(outcome.error)}`,
    );
  const value = outcome.value;
  const keys = value.reasons.map((reason) => `${reason.observerId}\u0000${reason.observerKind}`);
  check(new Set(keys).size === keys.length, "exactly one reason record per candidate observer");
  check(
    canonicalSerialize(keys) === canonicalSerialize([...keys].sort()),
    "reasons sorted by observer id",
  );
  const actors = value.reasons.filter((reason) => reason.observerKind === "actor");
  const includedIds = actors
    .filter((reason) => reason.outcome === "included")
    .map((reason) => reason.observerId);
  check(
    canonicalSerialize(value.perceptions.map((perception) => perception.observerId)) ===
      canonicalSerialize(includedIds),
    "every perception corresponds to an included reason and every excluded reason has none",
  );
  const active = (id: string | null) =>
    state.entities.some(
      (entity) => entity.objectId === id && (entity.lifecycle?.status ?? "active") === "active",
    );
  for (const id of [event.actorId, event.targetId])
    if (id !== null && active(id))
      check(
        actors.some((reason) => reason.observerId === id),
        "participants are candidates",
      );
  const viewerIds = policy.viewers.map((viewer) => viewer.viewerId);
  check(
    !value.perceptions.some((perception) => viewerIds.includes(perception.observerId)),
    "viewers never perceive",
  );
  const denied = new Set(
    policy.access.filter((entry) => entry.effect === "deny").map((entry) => entry.observerId),
  );
  for (const viewer of policy.viewers) {
    const reasons = value.reasons.filter(
      (reason) => reason.observerKind === "viewer" && reason.observerId === viewer.viewerId,
    );
    check(reasons.length === 1, "one reason per viewer");
    const reason = reasons[0]!;
    check(
      viewer.subscribed
        ? reason.outcome === (denied.has(viewer.viewerId) ? "excluded" : "included")
        : reason.code === "viewer-unsubscribed",
      "viewer needs an explicit subscription",
    );
  }
  check(
    canonicalSerialize(value.clientInterest.inputs.map((input) => input.viewerId)) ===
      canonicalSerialize(
        value.reasons
          .filter((reason) => reason.observerKind === "viewer" && reason.outcome === "included")
          .map((reason) => reason.observerId),
      ),
    "client interest only for included viewers",
  );
  const codes: readonly string[] = [...CANDIDATE_SOURCES, ...EXCLUSION_CODES];
  for (const reason of value.reasons) {
    check(codes.includes(reason.code), "reason code is a named code");
    check(
      (reason.outcome === "included") ===
        (CANDIDATE_SOURCES as readonly string[]).includes(reason.code),
      "outcome matches code kind",
    );
    check(
      reason.reduction === null ||
        (reason.outcome === "included" && reason.reduction === REDUCTION_CODE),
      "reduction only on inclusion",
    );
  }
  for (const perception of value.perceptions)
    check(HEX64.test(perception.hash), "perception hash is a digest");
  check(HEX64.test(value.clientInterest.hash), "client interest hash is a digest");
  return value;
}

// ---------------------------------------------------------------------------------------------
// Evidence.
// ---------------------------------------------------------------------------------------------

type Loose = Record<string, unknown>;

async function describeCase(item: PerceptionCase, outcome: AudienceOutcome) {
  const event = item.event as Loose | null;
  const identity = await containmentInputIdentity({
    event: item.event,
    sourceState: item.state,
    policy: item.policy,
  });
  const input = {
    type: typeof event?.type === "string" ? event.type : null,
    version:
      typeof event?.version === "number" && Number.isSafeInteger(event.version)
        ? event.version
        : null,
    eventId: typeof event?.eventId === "string" ? event.eventId : null,
    encoding: identity.encoding,
    inputHash: identity.inputHash,
    sourceStateHash: (await containmentInputIdentity(item.state)).inputHash,
    policyHash: (await containmentInputIdentity(item.policy)).inputHash,
    resolverVersion: outcome.ok ? outcome.value.resolverVersion : RESOLVER_VERSION,
  };
  if (!outcome.ok) {
    assertEnvelope(outcome.error);
    return { label: item.label, input, output: { kind: "refusal", ...outcome.error } };
  }
  const hashes = new Map(
    outcome.value.perceptions.map((perception) => [perception.observerId, perception.hash]),
  );
  return {
    label: item.label,
    input,
    output: {
      kind: "resolved",
      observers: outcome.value.reasons.map((reason) => ({
        observerId: reason.observerId,
        observerKind: reason.observerKind,
        outcome: reason.outcome,
        reasonCode: reason.code,
        sources: reason.sources,
        detailLevel: reason.detailLevel,
        reduction: reason.reduction,
        perceptionHash:
          reason.observerKind === "actor" ? (hashes.get(reason.observerId) ?? null) : null,
      })),
      clientInterestHash: outcome.value.clientInterest.hash,
    },
  };
}

const clone = <T>(value: T): T => structuredClone(value);

/** Named fixture cases: the differential outcomes plus variants. */
export function fixtureCases(anchor: WorldState, containment: WorldState): PerceptionCase[] {
  const event = baseEvent(anchor);
  const policy = basePolicy();
  const noModalities = { ...clone(policy), modalities: [] };
  const swapped = {
    ...clone(policy),
    viewers: [
      { viewerId: "viewer:subscribed", subscribed: false },
      { viewerId: "viewer:watching", subscribed: true },
    ],
  };
  return [
    { label: "case:baseline", event, state: anchor, policy },
    { label: "case:no-modality-declared", event, state: anchor, policy: noModalities },
    { label: "case:viewers-swapped", event, state: anchor, policy: swapped },
    { label: "case:no-regions", event: { ...event, regionIds: [] }, state: anchor, policy },
    { label: "case:sight-range", event: { ...event, modality: "sight" }, state: anchor, policy },
    {
      label: "case:containment-touch",
      event: containmentEvent(containment),
      state: containment,
      policy: containmentPolicy(),
    },
  ];
}

/** Malformed and unresolvable inputs, each expected to be refused with the catalogued envelope. */
export function refusalCases(anchor: WorldState): PerceptionCase[] {
  const event = baseEvent(anchor) as unknown as Loose;
  const policy = basePolicy() as unknown as Loose;
  const withEvent = (patch: Loose): PerceptionCase["event"] => ({ ...event, ...patch });
  const withPolicy = (patch: Loose): PerceptionCase["policy"] => ({ ...policy, ...patch });
  const without = (record: Loose, key: string): Loose => {
    const { [key]: _removed, ...rest } = record;
    return rest;
  };
  const modalities = (patch: Loose) =>
    withPolicy({ modalities: [{ modality: "sound", range: 1000, ...patch }] });
  const inputs: Record<string, [unknown, unknown, unknown, ResolveAudienceOptions?]> = {
    "null-event": [null, anchor, policy],
    "null-state": [event, null, policy],
    "null-policy": [event, anchor, null],
    "wrong-type": [withEvent({ eventId: 5 }), anchor, policy],
    "missing-field": [without(event, "spaceId"), anchor, policy],
    "extra-field": [withEvent({ extra: 1 }), anchor, policy],
    "policy-missing-field": [event, anchor, without(policy, "viewers")],
    "policy-extra-field": [event, anchor, withPolicy({ extra: 1 })],
    "non-integer-range": [event, anchor, modalities({ range: 1.5 })],
    "negative-range": [event, anchor, modalities({ range: -1 })],
    "unknown-event-type": [withEvent({ type: "world.explode" }), anchor, policy],
    "unknown-event-version": [withEvent({ version: 2 }), anchor, policy],
    "unknown-modality": [event, anchor, modalities({ modality: "telepathy" })],
    "revision-mismatch": [withEvent({ sourceRevision: anchor.revision + 1n }), anchor, policy],
    "unknown-actor": [withEvent({ actorId: "ghost" }), anchor, policy],
    "unknown-target": [withEvent({ targetId: "ghost" }), anchor, policy],
    "unknown-space": [withEvent({ spaceId: "nowhere" }), anchor, policy],
    "unknown-region": [withEvent({ regionIds: ["nowhere"] }), anchor, policy],
    "unknown-parent-place": [
      event,
      {
        ...anchor,
        spatialRegions: (anchor.spatialRegions ?? []).map((region) =>
          region.regionId === "porch"
            ? { ...region, parent: { regionId: "nowhere", version: 1 } }
            : region,
        ),
      },
      policy,
    ],
    "unknown-subscriber": [event, anchor, withPolicy({ subscribers: [{ observerId: "ghost" }] })],
    "resolver-exception": [event, anchor, policy, { spatialIndexFactory: createThrowingTestIndex }],
  };
  return PERCEPTION_REFUSAL_CASES.map((expected) => {
    const found = inputs[expected.name];
    if (found === undefined) throw new Error(`no input for refusal case ${expected.name}`);
    return {
      label: `refusal:${expected.name}`,
      event: found[0],
      state: found[1],
      policy: found[2],
      ...(found[3] === undefined ? {} : { options: found[3] }),
    };
  });
}

export async function perceptionEvidence(count = 12) {
  const anchor = await anchorWorld();
  const containment = await containmentWorld();
  const cases = [
    ...fixtureCases(anchor, containment),
    ...generatedCases(anchor, containment, count),
    ...refusalCases(anchor),
  ];
  const entries = [];
  const outputs: string[] = [];
  for (const item of cases) {
    const snapshot = () => {
      try {
        return canonicalSerialize([item.event, item.state, item.policy]);
      } catch {
        return JSON.stringify([item.event, item.state, item.policy], (_key, value: unknown) =>
          typeof value === "bigint" ? `${value}n` : value,
        );
      }
    };
    const before = snapshot();
    const outcome = resolveAudience(item.event, item.state, item.policy, item.options);
    check(snapshot() === before, "resolver left its input unchanged");
    if (item.label.startsWith("generated:")) {
      assertResolution(
        item.event as EventFixture,
        item.state as WorldState,
        item.policy as PolicyFixture,
        outcome,
      );
      const linear = resolveAudience(item.event, item.state, item.policy, {
        spatialIndexFactory: createLinearTestIndex,
      });
      check(
        canonicalSerialize(linear) === canonicalSerialize(outcome),
        "index implementations agree",
      );
    }
    outputs.push(canonicalSerialize(outcome));
    entries.push(await describeCase(item, outcome));
  }
  // Replaying the seed reproduces identical canonical outputs.
  const replay = [
    ...fixtureCases(anchor, containment),
    ...generatedCases(anchor, containment, count),
    ...refusalCases(anchor),
  ].map((item) =>
    canonicalSerialize(resolveAudience(item.event, item.state, item.policy, item.options)),
  );
  check(
    canonicalSerialize(replay) === canonicalSerialize(outputs),
    "seed replay reproduces identical canonical output",
  );
  return { schemaVersion: 1, resolverVersion: RESOLVER_VERSION, seed: perceptionSeed, entries };
}
