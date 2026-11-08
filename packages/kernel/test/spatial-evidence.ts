import { createHash } from "node:crypto";
import { lifecycleReportProblems } from "./lifecycle-evidence.js";

const HEX64 = /^[0-9a-f]{64}$/u;
const ENCODINGS = ["clockgrove-canonical-v1", "clockgrove-malformed-input-v1"];
export const SPATIAL_IMPLEMENTATIONS = ["loose-quadtree", "linear-test"] as const;
const COMMAND_TYPES = [
  "movement.start",
  "movement.interrupt",
  "movement.replan",
  "spatial.query",
  "spatial.region.validate",
  "spatial.anchor-graph.validate",
];

export interface SpatialRefusalCase {
  readonly name: string;
  readonly code: string;
  readonly check?: string;
  readonly path?: string;
}

/** Fixed named refusal cases; every one must appear as an entry labelled `case:<name>`. */
export const SPATIAL_REFUSAL_CASES: readonly SpatialRefusalCase[] = [
  {
    name: "unknown-anchor",
    code: "precondition-failed",
    check: "movement.route@1",
    path: "payload.destination.anchorId",
  },
  {
    name: "unknown-frame",
    code: "precondition-failed",
    check: "movement.route@1",
    path: "payload.destination.pose.frameId",
  },
  {
    name: "unknown-frame-version",
    code: "precondition-failed",
    check: "movement.route@1",
    path: "payload.destination.pose.frameVersion",
  },
  {
    name: "unreachable",
    code: "precondition-failed",
    check: "movement.route@1",
    path: "payload.destination",
  },
  {
    name: "retired-object",
    code: "precondition-failed",
    check: "movement.active-object@1",
    path: "payload.objectId",
  },
  {
    name: "dead-object",
    code: "precondition-failed",
    check: "movement.active-object@1",
    path: "payload.objectId",
  },
  {
    name: "frame-mismatch",
    code: "precondition-failed",
    check: "movement.route@1",
    path: "payload.destination.pose.frameId",
  },
  { name: "null-payload", code: "invalid-input" },
  { name: "wrong-type", code: "invalid-input" },
  { name: "missing-field", code: "invalid-input" },
  { name: "extra-field", code: "invalid-input" },
  { name: "non-integer", code: "invalid-input" },
  { name: "negative-value", code: "invalid-input" },
  { name: "out-of-range", code: "invalid-input" },
  { name: "clockwise-polygon", code: "invalid-input" },
  { name: "self-intersecting-polygon", code: "invalid-input" },
  { name: "few-vertices", code: "invalid-input" },
  { name: "zero-area-region", code: "invalid-input" },
  { name: "unknown-region-version", code: "invalid-input" },
  { name: "unknown-anchor-version", code: "invalid-input" },
  { name: "handler-failed", code: "handler-failed" },
  { name: "reducer-failed", code: "reducer-failed" },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hex = (value: unknown): boolean => typeof value === "string" && HEX64.test(value);

/** Executable schema of the `spatial` evidence section; returns every violation (empty = valid). */
export function spatialEvidenceProblems(value: unknown, path = "spatial"): string[] {
  const problems: string[] = [];
  const bad = (at: string, why: string) => problems.push(`${at}: ${why}`);
  if (!isRecord(value)) return [`${path}: must be a record`];
  if (value.schemaVersion !== 1) bad(`${path}.schemaVersion`, "must be 1");
  if (!isRecord(value.seed) || typeof value.seed.seed !== "string")
    bad(`${path}.seed`, "seed record required");
  if (!Number.isInteger(value.steps)) bad(`${path}.steps`, "integer required");
  const registry = value.registry;
  if (!isRecord(registry) || !hex(registry.hash))
    bad(`${path}.registry.hash`, "64 lowercase hex characters required");
  if (!hex(value.finalStateHash))
    bad(`${path}.finalStateHash`, "64 lowercase hex characters required");
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    bad(`${path}.entries`, "non-empty array required");
    return problems;
  }
  const byLabel = new Map<string, Map<string, string>>();
  const seenCases = new Map<string, Record<string, unknown>[]>();
  for (const [index, entry] of value.entries.entries()) {
    const at = `${path}.entries[${index}]`;
    if (!isRecord(entry) || typeof entry.label !== "string") {
      bad(at, "label required");
      continue;
    }
    const input = entry.input,
      output = entry.output;
    if (!isRecord(input)) bad(`${at}.input`, "record required");
    else {
      for (const key of ["inputHash", "preStateHash", "randomStateHash"])
        if (!hex(input[key])) bad(`${at}.input.${key}`, "64 lowercase hex characters required");
      if (!ENCODINGS.includes(input.encoding as string))
        bad(`${at}.input.encoding`, "canonical-v1 or malformed-input-v1 required");
      if (!COMMAND_TYPES.includes(input.type as string))
        bad(`${at}.input.type`, "known spatial command or query type required");
      if (!Number.isInteger(input.version) || (input.version as number) < 1)
        bad(`${at}.input.version`, "positive integer required");
      if (typeof input.commandId !== "string" || input.commandId.length === 0)
        bad(`${at}.input.commandId`, "non-empty string required");
      if (typeof input.indexImplementation !== "string" || input.indexImplementation.length === 0)
        bad(`${at}.input.indexImplementation`, "non-empty string required");
    }
    if (!isRecord(output)) {
      bad(`${at}.output`, "record required");
      continue;
    }
    if (!hex(output.postStateHash))
      bad(`${at}.output.postStateHash`, "64 lowercase hex characters required");
    if (output.kind === "success") {
      if (!Array.isArray(output.eventTypes)) bad(`${at}.output.eventTypes`, "array required");
      if (
        !Array.isArray(output.eventIds) ||
        (Array.isArray(output.eventTypes) && output.eventIds.length !== output.eventTypes.length)
      )
        bad(`${at}.output.eventIds`, "one id per event required");
      if (!Array.isArray(output.crossings)) bad(`${at}.output.crossings`, "array required");
      else
        for (const [crossing, item] of output.crossings.entries())
          if (
            !isRecord(item) ||
            typeof item.regionId !== "string" ||
            typeof item.time !== "string" ||
            !/^\d+$/u.test(item.time)
          )
            bad(`${at}.output.crossings[${crossing}]`, "region and decimal time required");
    } else if (output.kind === "query") {
      if (
        !Array.isArray(output.candidates) ||
        output.candidates.some((id) => typeof id !== "string")
      )
        bad(`${at}.output.candidates`, "id array required");
    } else if (output.kind === "refusal") {
      if (typeof output.code !== "string" || typeof output.path !== "string")
        bad(`${at}.output`, "refusal code and path required");
      if (
        (output.code === "precondition-failed" || output.code === "invariant-violated") &&
        typeof output.check !== "string"
      )
        bad(`${at}.output.check`, "check name required");
    } else bad(`${at}.output.kind`, "success, query or refusal required");
    if (isRecord(input) && SPATIAL_IMPLEMENTATIONS.includes(input.indexImplementation as never)) {
      const impls = byLabel.get(entry.label) ?? new Map<string, string>();
      impls.set(
        input.indexImplementation as string,
        JSON.stringify({ ...output, postStateHash: output.postStateHash }),
      );
      byLabel.set(entry.label, impls);
    }
    if (entry.label.startsWith("case:"))
      seenCases.set(entry.label.slice(5), [...(seenCases.get(entry.label.slice(5)) ?? []), output]);
  }
  for (const [label, impls] of byLabel) {
    for (const name of SPATIAL_IMPLEMENTATIONS)
      if (!impls.has(name)) bad(`${path}.entries[${label}]`, `missing ${name} entry`);
    if (new Set(impls.values()).size > 1)
      bad(`${path}.entries[${label}]`, "index implementations disagree");
  }
  for (const name of SPATIAL_IMPLEMENTATIONS)
    if (![...byLabel.values()].some((impls) => impls.has(name)))
      bad(`${path}.entries`, `no ${name} entries`);
  for (const refusalCase of SPATIAL_REFUSAL_CASES) {
    const outputs = seenCases.get(refusalCase.name);
    if (outputs === undefined) {
      bad(`${path}.cases.${refusalCase.name}`, "missing refusal case");
      continue;
    }
    for (const output of outputs) {
      if (output.kind !== "refusal" || output.code !== refusalCase.code)
        bad(`${path}.cases.${refusalCase.name}`, `must refuse with ${refusalCase.code}`);
      else {
        if (refusalCase.check !== undefined && output.check !== refusalCase.check)
          bad(`${path}.cases.${refusalCase.name}`, `check must be ${refusalCase.check}`);
        if (refusalCase.path !== undefined && output.path !== refusalCase.path)
          bad(`${path}.cases.${refusalCase.name}`, `path must be ${refusalCase.path}`);
      }
    }
  }
  return problems;
}

/** Cross-runtime comparison summary: every field is plain data with real hashes. */
export function spatialComparisonProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["comparison.spatial: must be a record"];
  if (value.equal !== true) problems.push("comparison.spatial.equal: must be true");
  for (const key of ["nodeHash", "workersHash", "registryHash", "finalStateHash"])
    if (!hex(value[key]))
      problems.push(`comparison.spatial.${key}: 64 lowercase hex characters required`);
  if (value.nodeHash !== value.workersHash)
    problems.push("comparison.spatial: node and workers hashes differ");
  if (!Number.isInteger(value.entryCount) || (value.entryCount as number) < 1)
    problems.push("comparison.spatial.entryCount: positive integer required");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// RW-0105b perception section. Code literals are deliberately repeated here (not imported) so the
// schema independently pins the names the resolver and docs/perception.md must use.
// ---------------------------------------------------------------------------------------------

export const PERCEPTION_RESOLVER_VERSION = "clockgrove-audience-resolver@2";
export const PERCEPTION_CANDIDATE_CODES = [
  "direct-target",
  "event-actor",
  "containing-space",
  "space-contents",
  "nearby-peer",
  "ancestor-space",
  "explicit-subscriber",
] as const;
export const PERCEPTION_EXCLUSION_CODES = [
  "modality-range",
  "declared-occlusion",
  "privacy-excluded",
  "viewer-unsubscribed",
] as const;
export const PERCEPTION_REDUCTION_CODE = "privacy-reduced";
export const PERCEPTION_REFUSAL_CODES = [
  "invalid-input",
  "unsupported-input",
  "unknown-event-version",
  "revision-conflict",
  "precondition-failed",
  "handler-failed",
] as const;
const PERCEPTION_FIXTURE_CASES = [
  "baseline",
  "no-modality-declared",
  "viewers-swapped",
  "no-regions",
  "sight-range",
  "containment-touch",
];
const OBSERVER_CHECK = "perception.observer@1";

/** Fixed named refusal cases; every one must appear as an entry labelled `refusal:<name>`. */
export const PERCEPTION_REFUSAL_CASES: readonly SpatialRefusalCase[] = [
  { name: "null-event", code: "invalid-input", path: "event" },
  { name: "null-state", code: "invalid-input", path: "sourceState" },
  { name: "null-policy", code: "invalid-input", path: "policy" },
  { name: "wrong-type", code: "invalid-input", path: "event.eventId" },
  { name: "missing-field", code: "invalid-input", path: "event.spaceId" },
  { name: "extra-field", code: "invalid-input", path: "event.extra" },
  { name: "policy-missing-field", code: "invalid-input", path: "policy.viewers" },
  { name: "policy-extra-field", code: "invalid-input", path: "policy.extra" },
  { name: "non-integer-range", code: "invalid-input", path: "policy.modalities[0].range" },
  { name: "negative-range", code: "invalid-input", path: "policy.modalities[0].range" },
  { name: "unknown-event-type", code: "unsupported-input", path: "event.type" },
  { name: "unknown-event-version", code: "unknown-event-version", path: "event.version" },
  { name: "unknown-modality", code: "unsupported-input", path: "policy.modalities[0].modality" },
  {
    name: "revision-mismatch",
    code: "revision-conflict",
    path: "event.sourceRevision",
    check: "perception.source-revision@1",
  },
  {
    name: "unknown-actor",
    code: "precondition-failed",
    path: "event.actorId",
    check: OBSERVER_CHECK,
  },
  {
    name: "unknown-target",
    code: "precondition-failed",
    path: "event.targetId",
    check: OBSERVER_CHECK,
  },
  {
    name: "unknown-space",
    code: "precondition-failed",
    path: "event.spaceId",
    check: "perception.space@1",
  },
  {
    name: "unknown-region",
    code: "precondition-failed",
    path: "event.regionIds[0]",
    check: "perception.region@1",
  },
  {
    name: "unknown-parent-place",
    code: "invalid-input",
    path: "sourceState.spatialRegions[2].parent.regionId",
  },
  {
    name: "unknown-subscriber",
    code: "precondition-failed",
    path: "policy.subscribers[0].observerId",
    check: OBSERVER_CHECK,
  },
  {
    name: "resolver-exception",
    code: "handler-failed",
    path: "resolver",
    check: "perception.resolver@1",
  },
];

/** Exact differential outcomes of `case:baseline`: [observer, kind, outcome, reason code, reduction]. */
export const PERCEPTION_BASELINE_OUTCOMES: readonly (readonly [
  string,
  string,
  string,
  string,
  string | null,
])[] = [
  ["bowl", "actor", "included", "direct-target", null],
  ["hidden", "actor", "excluded", "declared-occlusion", null],
  ["mover", "actor", "included", "space-contents", null],
  ["porch-box", "actor", "included", "containing-space", null],
  ["private-neighbour", "actor", "excluded", "privacy-excluded", null],
  ["reduced-neighbour", "actor", "included", "space-contents", PERCEPTION_REDUCTION_CODE],
  ["street-sitter", "actor", "included", "nearby-peer", null],
  ["subscriber", "actor", "included", "explicit-subscriber", null],
  ["townsfolk", "actor", "included", "ancestor-space", null],
  ["viewer:subscribed", "viewer", "included", "explicit-subscriber", null],
  ["viewer:watching", "viewer", "excluded", "viewer-unsubscribed", null],
  ["walker", "actor", "included", "event-actor", null],
  ["zone-far", "actor", "excluded", "modality-range", null],
];

/** Executable schema of the `perception` evidence section; returns every violation (empty = valid). */
export function perceptionEvidenceProblems(value: unknown, path = "perception"): string[] {
  const problems: string[] = [];
  const bad = (at: string, why: string) => problems.push(`${at}: ${why}`);
  if (!isRecord(value)) return [`${path}: must be a record`];
  if (value.schemaVersion !== 1) bad(`${path}.schemaVersion`, "must be 1");
  if (value.resolverVersion !== PERCEPTION_RESOLVER_VERSION)
    bad(`${path}.resolverVersion`, `must be ${PERCEPTION_RESOLVER_VERSION}`);
  if (!isRecord(value.seed) || typeof value.seed.seed !== "string")
    bad(`${path}.seed`, "seed record required");
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    bad(`${path}.entries`, "non-empty array required");
    return problems;
  }
  const reasonCodes = new Set<string>();
  const refusalCodes = new Set<string>();
  const labels = new Map<string, Record<string, unknown>>();
  const allReasons = [
    ...PERCEPTION_CANDIDATE_CODES,
    ...PERCEPTION_EXCLUSION_CODES,
  ] as readonly string[];
  for (const [index, entry] of value.entries.entries()) {
    const at = `${path}.entries[${index}]`;
    if (!isRecord(entry) || typeof entry.label !== "string") {
      bad(at, "label required");
      continue;
    }
    const input = entry.input,
      output = entry.output;
    const resolved = isRecord(output) && output.kind === "resolved";
    if (!isRecord(input)) bad(`${at}.input`, "record required");
    else {
      for (const key of ["inputHash", "sourceStateHash", "policyHash"])
        if (!hex(input[key])) bad(`${at}.input.${key}`, "64 lowercase hex characters required");
      if (!ENCODINGS.includes(input.encoding as string))
        bad(`${at}.input.encoding`, "canonical-v1 or malformed-input-v1 required");
      if (typeof input.resolverVersion !== "string" || input.resolverVersion.length === 0)
        bad(`${at}.input.resolverVersion`, "non-empty string required");
      if (input.type !== null && typeof input.type !== "string")
        bad(`${at}.input.type`, "string or null required");
      if (input.eventId !== null && typeof input.eventId !== "string")
        bad(`${at}.input.eventId`, "string or null required");
      if (
        input.version !== null &&
        (!Number.isInteger(input.version) || (input.version as number) < 1)
      )
        bad(`${at}.input.version`, "positive integer or null required");
      if (resolved) {
        if (
          typeof input.type !== "string" ||
          typeof input.eventId !== "string" ||
          input.version !== 1
        )
          bad(`${at}.input`, "resolved entries need event type, version 1 and event id");
        if (input.encoding !== "clockgrove-canonical-v1")
          bad(`${at}.input.encoding`, "resolved inputs are canonical-v1");
        if (input.resolverVersion !== PERCEPTION_RESOLVER_VERSION)
          bad(`${at}.input.resolverVersion`, "must equal the resolver version");
      }
    }
    if (!isRecord(output)) {
      bad(`${at}.output`, "record required");
      continue;
    }
    labels.set(entry.label, output);
    if (output.kind === "resolved") {
      if (!hex(output.clientInterestHash))
        bad(`${at}.output.clientInterestHash`, "64 lowercase hex characters required");
      if (!Array.isArray(output.observers)) {
        bad(`${at}.output.observers`, "array required");
        continue;
      }
      let previous = "";
      for (const [position, observer] of output.observers.entries()) {
        const where = `${at}.output.observers[${position}]`;
        if (!isRecord(observer) || typeof observer.observerId !== "string") {
          bad(where, "observer id required");
          continue;
        }
        if (observer.observerId < previous) bad(where, "observers must be sorted by id");
        previous = observer.observerId;
        if (observer.observerKind !== "actor" && observer.observerKind !== "viewer")
          bad(`${where}.observerKind`, "actor or viewer required");
        if (observer.outcome !== "included" && observer.outcome !== "excluded")
          bad(`${where}.outcome`, "included or excluded required");
        if (typeof observer.reasonCode !== "string" || !allReasons.includes(observer.reasonCode))
          bad(`${where}.reasonCode`, "named reason code required");
        else {
          reasonCodes.add(observer.reasonCode);
          const included = (PERCEPTION_CANDIDATE_CODES as readonly string[]).includes(
            observer.reasonCode,
          );
          if (included !== (observer.outcome === "included"))
            bad(`${where}.reasonCode`, "code must match the outcome");
        }
        if (observer.reduction !== null && observer.reduction !== PERCEPTION_REDUCTION_CODE)
          bad(`${where}.reduction`, "null or privacy-reduced required");
        if (observer.reduction === PERCEPTION_REDUCTION_CODE)
          reasonCodes.add(PERCEPTION_REDUCTION_CODE);
        const perceives = observer.observerKind === "actor" && observer.outcome === "included";
        if (perceives ? !hex(observer.perceptionHash) : observer.perceptionHash !== null)
          bad(
            `${where}.perceptionHash`,
            perceives
              ? "64 lowercase hex characters required"
              : "must be null without a perception",
          );
      }
      if (
        new Set(
          output.observers.map((item) =>
            isRecord(item) ? `${item.observerKind}/${item.observerId}` : "",
          ),
        ).size !== output.observers.length
      )
        bad(`${at}.output.observers`, "exactly one reason per observer required");
    } else if (output.kind === "refusal") {
      if (typeof output.code !== "string" || typeof output.path !== "string")
        bad(`${at}.output`, "refusal code and path required");
      else refusalCodes.add(output.code);
      if (
        ["revision-conflict", "precondition-failed", "handler-failed"].includes(
          output.code as string,
        ) &&
        typeof output.check !== "string"
      )
        bad(`${at}.output.check`, "check name required");
    } else bad(`${at}.output.kind`, "resolved or refusal required");
  }
  for (const code of [
    ...PERCEPTION_CANDIDATE_CODES,
    ...PERCEPTION_EXCLUSION_CODES,
    PERCEPTION_REDUCTION_CODE,
  ])
    if (!reasonCodes.has(code)) bad(`${path}.reasonCodes`, `missing reason code ${code}`);
  for (const code of PERCEPTION_REFUSAL_CODES)
    if (!refusalCodes.has(code)) bad(`${path}.refusalCodes`, `missing refusal code ${code}`);
  for (const name of PERCEPTION_FIXTURE_CASES) {
    const output = labels.get(`case:${name}`);
    if (output === undefined || output.kind !== "resolved")
      bad(`${path}.cases.${name}`, "missing resolved fixture case");
  }
  for (const world of ["anchor", "containment"])
    if (![...labels.keys()].some((label) => label.startsWith(`generated:${world}:`)))
      bad(`${path}.generated.${world}`, "missing generated entries");
  for (const refusalCase of PERCEPTION_REFUSAL_CASES) {
    const output = labels.get(`refusal:${refusalCase.name}`);
    if (output === undefined) {
      bad(`${path}.refusals.${refusalCase.name}`, "missing refusal case");
      continue;
    }
    if (
      output.kind !== "refusal" ||
      output.code !== refusalCase.code ||
      output.path !== refusalCase.path ||
      output.check !== refusalCase.check
    )
      bad(
        `${path}.refusals.${refusalCase.name}`,
        `must refuse with ${refusalCase.code} at ${refusalCase.path}`,
      );
  }
  const baseline = labels.get("case:baseline");
  if (baseline !== undefined) {
    const actual = Array.isArray(baseline.observers)
      ? baseline.observers.map((item) =>
          isRecord(item)
            ? [item.observerId, item.observerKind, item.outcome, item.reasonCode, item.reduction]
            : null,
        )
      : null;
    if (JSON.stringify(actual) !== JSON.stringify(PERCEPTION_BASELINE_OUTCOMES))
      bad(`${path}.cases.baseline`, "differential outcomes do not match the expected reason codes");
  }
  return problems;
}

/** Cross-runtime comparison summary of the perception section. */
export function perceptionComparisonProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["comparison.perception: must be a record"];
  if (value.equal !== true) problems.push("comparison.perception.equal: must be true");
  for (const key of ["nodeHash", "workersHash"])
    if (!hex(value[key]))
      problems.push(`comparison.perception.${key}: 64 lowercase hex characters required`);
  if (value.nodeHash !== value.workersHash)
    problems.push("comparison.perception: node and workers hashes differ");
  if (value.resolverVersion !== PERCEPTION_RESOLVER_VERSION)
    problems.push("comparison.perception.resolverVersion: must equal the resolver version");
  for (const key of ["entryCount", "refusalCount"])
    if (!Number.isInteger(value[key]) || (value[key] as number) < 1)
      problems.push(`comparison.perception.${key}: positive integer required`);
  return problems;
}

/** Validates the three written report bodies together for the perception section. */
export function perceptionReportProblems(
  node: unknown,
  workers: unknown,
  comparison: unknown,
): string[] {
  const nodeSection =
    isRecord(node) && isRecord(node.evidence) ? node.evidence.perception : undefined;
  const workersSection =
    isRecord(workers) && isRecord(workers.evidence) ? workers.evidence.perception : undefined;
  const summary = isRecord(comparison) ? comparison.perception : undefined;
  const problems = [
    ...(nodeSection === undefined
      ? ["node.json: perception section missing"]
      : perceptionEvidenceProblems(nodeSection, "node.perception")),
    ...(workersSection === undefined
      ? ["workers.json: perception section missing"]
      : perceptionEvidenceProblems(workersSection, "workers.perception")),
    ...perceptionComparisonProblems(summary),
  ];
  if (
    nodeSection !== undefined &&
    workersSection !== undefined &&
    JSON.stringify(nodeSection) !== JSON.stringify(workersSection)
  )
    problems.push("node and workers perception bodies differ");
  if (isRecord(summary)) {
    const sha = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (nodeSection !== undefined && summary.nodeHash !== sha(nodeSection))
      problems.push("comparison.perception.nodeHash does not match node.json");
    if (workersSection !== undefined && summary.workersHash !== sha(workersSection))
      problems.push("comparison.perception.workersHash does not match workers.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.entries) &&
      summary.entryCount !== nodeSection.entries.length
    )
      problems.push("comparison.perception.entryCount does not match node.json");
  }
  return problems;
}

/** Validates the three written report bodies together (presence, equality, matching hashes). */
export function spatialReportProblems(
  node: unknown,
  workers: unknown,
  comparison: unknown,
): string[] {
  const nodeSpatial = isRecord(node) && isRecord(node.evidence) ? node.evidence.spatial : undefined;
  const workersSpatial =
    isRecord(workers) && isRecord(workers.evidence) ? workers.evidence.spatial : undefined;
  const summary = isRecord(comparison) ? comparison.spatial : undefined;
  const problems = [
    ...(nodeSpatial === undefined
      ? ["node.json: spatial section missing"]
      : spatialEvidenceProblems(nodeSpatial, "node.spatial")),
    ...(workersSpatial === undefined
      ? ["workers.json: spatial section missing"]
      : spatialEvidenceProblems(workersSpatial, "workers.spatial")),
    ...spatialComparisonProblems(summary),
  ];
  if (
    nodeSpatial !== undefined &&
    workersSpatial !== undefined &&
    JSON.stringify(nodeSpatial) !== JSON.stringify(workersSpatial)
  )
    problems.push("node and workers spatial bodies differ");
  if (isRecord(summary)) {
    const sha = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (nodeSpatial !== undefined && summary.nodeHash !== sha(nodeSpatial))
      problems.push("comparison.spatial.nodeHash does not match node.json");
    if (workersSpatial !== undefined && summary.workersHash !== sha(workersSpatial))
      problems.push("comparison.spatial.workersHash does not match workers.json");
    if (
      isRecord(nodeSpatial) &&
      isRecord(nodeSpatial.registry) &&
      summary.registryHash !== nodeSpatial.registry.hash
    )
      problems.push("comparison.spatial.registryHash does not match the registry identity");
    if (isRecord(nodeSpatial) && summary.finalStateHash !== nodeSpatial.finalStateHash)
      problems.push("comparison.spatial.finalStateHash does not match node.json");
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// RW-0106 scheduler section. Literals are deliberately repeated here (not imported) so the schema
// independently pins the engine version, differential pairs and refusal catalogue that the engine
// and docs/scheduler.md must use.
// ---------------------------------------------------------------------------------------------

export const SCHEDULER_ENGINE_VERSION = "clockgrove-catch-up@1";
export const SCHEDULER_PAIR_NAMES = [
  "continuous-steps-vs-aggregate",
  "sleep-reactivation-vs-uninterrupted",
  "pause-resume-vs-uninterrupted",
  "superseded-vs-replacement",
  "retried-call-vs-first",
  "bounded-continuation-vs-unbounded",
] as const;

export interface SchedulerRefusalCase {
  readonly name: string;
  readonly code: string;
  readonly path: string;
  readonly check: string | null;
}

const sched = (
  name: string,
  code: string,
  path: string,
  check: string | null = null,
): SchedulerRefusalCase => ({ name, code, path, check });

/** Fixed named refusal cases; every one must appear as an entry labelled `refusal:<name>`. */
export const SCHEDULER_REFUSAL_CASES: readonly SchedulerRefusalCase[] = [
  sched("null-request", "invalid-input", "request"),
  sched("missing-field", "invalid-input", "request.budget"),
  sched("extra-field", "invalid-input", "request.extra"),
  sched("wrong-type", "invalid-input", "request.start"),
  sched("item-null", "invalid-input", "request.queue[0]"),
  sched("item-missing-field", "invalid-input", "request.queue[0].kind"),
  sched("item-extra-field", "invalid-input", "request.queue[0].extra"),
  sched("item-wrong-type", "invalid-input", "request.queue[0].dueAt"),
  sched("cursor-wrong-type", "invalid-input", "request.cursor"),
  sched("cursor-missing-field", "invalid-input", "request.cursor.position"),
  sched("cursor-extra-field", "invalid-input", "request.cursor.extra"),
  sched("result-null", "invalid-input", "request.results[0]"),
  sched("result-missing-field", "invalid-input", "request.results[0].payload"),
  sched("result-extra-field", "invalid-input", "request.results[0].extra"),
  sched("unknown-engine-version", "unknown-command-version", "request.engineVersion"),
  sched("unknown-cursor-engine-version", "unknown-command-version", "request.cursor.engineVersion"),
  sched("unknown-class", "unsupported-input", "request.queue[0].catchUpClass"),
  sched("unknown-kind", "unsupported-input", "request.queue[0].kind"),
  sched("unknown-payload-version", "unknown-command-version", "request.queue[0].payloadVersion"),
  sched(
    "class-dispatch-mismatch",
    "unsupported-input",
    "request.queue[0].catchUpClass",
    "catch-up.dispatch-class@1",
  ),
  sched("negative-time", "invalid-input", "request.start"),
  sched("non-bigint-time", "invalid-input", "request.target"),
  sched("out-of-range-time", "invalid-input", "request.target"),
  sched("target-before-start", "invalid-input", "request.target", "catch-up.time-order@1"),
  sched("budget-non-integer", "invalid-input", "request.budget"),
  sched("budget-non-positive", "invalid-input", "request.budget"),
  sched("scope-violation", "invalid-input", "request.queue[1]", "catch-up.queue-scope@1"),
  sched("duplicate-id", "invalid-input", "request.queue[1].id", "catch-up.queue-duplicate@1"),
  sched("ambiguous-ordering", "invalid-input", "request.queue", "catch-up.queue-ordering@1"),
  sched(
    "cursor-queue-mismatch",
    "invalid-input",
    "request.cursor.queueDigest",
    "catch-up.cursor@1",
  ),
  sched("cursor-time-mismatch", "invalid-input", "request.cursor.target", "catch-up.cursor@1"),
  sched(
    "result-unknown-item",
    "invalid-input",
    "request.results[0].scheduleId",
    "catch-up.result-target@1",
  ),
  sched(
    "result-non-blocked",
    "invalid-input",
    "request.results[0].scheduleId",
    "catch-up.result-blocked@1",
  ),
  sched(
    "result-duplicate",
    "invalid-input",
    "request.results[1].scheduleId",
    "catch-up.result-duplicate@1",
  ),
  sched("unknown-system", "unsupported-input", "request.systems[0].systemId"),
  sched(
    "duplicate-system",
    "invalid-input",
    "request.systems[1].systemId",
    "catch-up.systems-duplicate@1",
  ),
  sched(
    "aggregate-without-system",
    "invalid-input",
    "request.queue[0].kind",
    "catch-up.system-state@1",
  ),
  sched(
    "systems-time-mismatch",
    "invalid-input",
    "request.systems[0].at",
    "catch-up.systems-time@1",
  ),
  sched(
    "system-non-integer",
    "check-error",
    "request.systems[2].state.level",
    "catch-up.system-integrate@1",
  ),
  sched(
    "system-threshold-not-forward",
    "check-error",
    "request.systems[2]",
    "catch-up.system-threshold@1",
  ),
  sched("system-exception", "check-error", "request.systems[2]", "catch-up.system@1"),
  sched("engine-exception", "handler-failed", "engine", "catch-up.engine@1"),
];

const DECIMAL = /^\d+$/u;
const decimal = (value: unknown): boolean => typeof value === "string" && DECIMAL.test(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Executable schema of the `scheduler` evidence section; returns every violation (empty = valid). */
export function schedulerEvidenceProblems(value: unknown, path = "scheduler"): string[] {
  const problems: string[] = [];
  const bad = (at: string, why: string) => problems.push(`${at}: ${why}`);
  if (!isRecord(value)) return [`${path}: must be a record`];
  if (value.schemaVersion !== 1) bad(`${path}.schemaVersion`, "must be 1");
  if (value.engineVersion !== SCHEDULER_ENGINE_VERSION)
    bad(`${path}.engineVersion`, `must be ${SCHEDULER_ENGINE_VERSION}`);
  if (!isRecord(value.seed) || typeof value.seed.seed !== "string")
    bad(`${path}.seed`, "seed record required");
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    bad(`${path}.entries`, "non-empty array required");
    return problems;
  }
  const labels = new Map<string, Record<string, unknown>>();
  const refusalCodes = new Set<string>();
  const seen = {
    dispatched: false,
    threshold: false,
    skipped: false,
    blocked: false,
    cursor: false,
    incomplete: false,
    generated: false,
  };
  for (const [index, entry] of value.entries.entries()) {
    const at = `${path}.entries[${index}]`;
    if (!isRecord(entry) || typeof entry.label !== "string") {
      bad(at, "label required");
      continue;
    }
    if (labels.has(entry.label)) bad(at, `duplicate label ${entry.label}`);
    if (entry.label.startsWith("generated:")) seen.generated = true;
    const input = entry.input,
      output = entry.output;
    if (!isRecord(input)) bad(`${at}.input`, "record required");
    else {
      for (const key of ["inputHash", "queueHash", "systemsHash"])
        if (!hex(input[key])) bad(`${at}.input.${key}`, "64 lowercase hex characters required");
      if (input.cursorHash !== null && !hex(input.cursorHash))
        bad(`${at}.input.cursorHash`, "null or 64 lowercase hex characters required");
      if (hex(input.cursorHash)) seen.cursor = true;
      if (!ENCODINGS.includes(input.encoding as string))
        bad(`${at}.input.encoding`, "canonical-v1 or malformed-input-v1 required");
      if (input.engineVersion !== null && typeof input.engineVersion !== "string")
        bad(`${at}.input.engineVersion`, "string or null required");
      for (const key of ["start", "target"])
        if (
          input[key] !== null &&
          !(typeof input[key] === "string" && /^-?\d+$/u.test(input[key] as string))
        )
          bad(`${at}.input.${key}`, "null or decimal integer time required");
      if (input.budget !== null && !Number.isSafeInteger(input.budget))
        bad(`${at}.input.budget`, "null or safe integer required");
    }
    if (!isRecord(output)) {
      bad(`${at}.output`, "record required");
      continue;
    }
    labels.set(entry.label, output);
    if (output.kind === "success") {
      if (
        isRecord(input) &&
        (input.engineVersion !== SCHEDULER_ENGINE_VERSION ||
          !decimal(input.start) ||
          !decimal(input.target) ||
          input.budget === null)
      )
        bad(`${at}.input`, "successful calls need the engine version, start, target and budget");
      if (
        !strings(output.dispatched) ||
        new Set(output.dispatched).size !== output.dispatched.length
      )
        bad(`${at}.output.dispatched`, "unique id array required");
      else if (output.dispatched.length > 0) seen.dispatched = true;
      if (!Array.isArray(output.thresholds)) bad(`${at}.output.thresholds`, "array required");
      else {
        let previous = -1n;
        for (const [position, threshold] of output.thresholds.entries()) {
          const where = `${at}.output.thresholds[${position}]`;
          if (
            !isRecord(threshold) ||
            typeof threshold.systemId !== "string" ||
            typeof threshold.name !== "string" ||
            !decimal(threshold.time)
          ) {
            bad(where, "system id, threshold name and decimal time required");
            continue;
          }
          const when = BigInt(threshold.time as string);
          if (when < previous) bad(where, "thresholds must be in time order");
          previous = when;
          seen.threshold = true;
        }
      }
      if (!Array.isArray(output.skipped)) bad(`${at}.output.skipped`, "array required");
      else {
        let previous = "";
        for (const [position, summary] of output.skipped.entries()) {
          const where = `${at}.output.skipped[${position}]`;
          if (
            !isRecord(summary) ||
            typeof summary.kind !== "string" ||
            !Number.isInteger(summary.count) ||
            (summary.count as number) < 1 ||
            !decimal(summary.firstDueAt) ||
            !decimal(summary.lastDueAt)
          ) {
            bad(where, "kind, positive count, first and last due time required");
            continue;
          }
          if (BigInt(summary.firstDueAt as string) > BigInt(summary.lastDueAt as string))
            bad(where, "first due time must not exceed last");
          if (summary.kind <= previous) bad(where, "one summary per kind, sorted by kind required");
          previous = summary.kind;
          seen.skipped = true;
        }
      }
      if (!strings(output.blocked)) bad(`${at}.output.blocked`, "id array required");
      else if (output.blocked.length > 0) seen.blocked = true;
      for (const key of ["remainingQueueHash", "nextSystemsHash"])
        if (!hex(output[key])) bad(`${at}.output.${key}`, "64 lowercase hex characters required");
      if (typeof output.complete !== "boolean") bad(`${at}.output.complete`, "boolean required");
      if (output.nextCursorHash !== null && !hex(output.nextCursorHash))
        bad(`${at}.output.nextCursorHash`, "null or 64 lowercase hex characters required");
      else if ((output.nextCursorHash === null) !== (output.complete === true))
        bad(`${at}.output.nextCursorHash`, "a cursor exists exactly when the call is incomplete");
      if (output.complete === false) seen.incomplete = true;
      if (output.nextDueAt !== null && !decimal(output.nextDueAt))
        bad(`${at}.output.nextDueAt`, "null or decimal time required");
    } else if (output.kind === "refusal") {
      if (typeof output.code !== "string" || typeof output.path !== "string")
        bad(`${at}.output`, "refusal code and path required");
      else refusalCodes.add(output.code);
      if (output.check !== null && typeof output.check !== "string")
        bad(`${at}.output.check`, "check name or null required");
    } else bad(`${at}.output.kind`, "success or refusal required");
  }
  if (!seen.dispatched) bad(`${path}.coverage`, "no entry dispatched an exact item");
  if (!seen.threshold) bad(`${path}.coverage`, "no entry carries an aggregate threshold record");
  if (!seen.skipped) bad(`${path}.coverage`, "no entry carries a skipped summary");
  if (!seen.blocked) bad(`${path}.coverage`, "no entry reports a blocked id");
  if (!seen.incomplete || !seen.cursor)
    bad(`${path}.coverage`, "no bounded continuation with a cursor was recorded");
  if (!seen.generated) bad(`${path}.generated`, "missing generated entries");
  for (const refusalCase of SCHEDULER_REFUSAL_CASES) {
    const output = labels.get(`refusal:${refusalCase.name}`);
    if (output === undefined) {
      bad(`${path}.refusals.${refusalCase.name}`, "missing refusal case");
      continue;
    }
    if (
      output.kind !== "refusal" ||
      output.code !== refusalCase.code ||
      output.path !== refusalCase.path ||
      output.check !== refusalCase.check
    )
      bad(
        `${path}.refusals.${refusalCase.name}`,
        `must refuse with ${refusalCase.code} at ${refusalCase.path}`,
      );
  }
  for (const code of new Set(SCHEDULER_REFUSAL_CASES.map((item) => item.code)))
    if (!refusalCodes.has(code)) bad(`${path}.refusalCodes`, `missing refusal code ${code}`);
  if (!Array.isArray(value.pairs)) bad(`${path}.pairs`, "array required");
  else {
    const names = new Map<string, number>();
    for (const [index, pair] of value.pairs.entries()) {
      const at = `${path}.pairs[${index}]`;
      if (!isRecord(pair) || typeof pair.name !== "string") {
        bad(at, "pair name required");
        continue;
      }
      names.set(pair.name, (names.get(pair.name) ?? 0) + 1);
      if (pair.equivalence !== "exact") bad(`${at}.equivalence`, "must declare exact");
      for (const key of ["leftHash", "rightHash"])
        if (!hex(pair[key])) bad(`${at}.${key}`, "64 lowercase hex characters required");
      if (pair.leftHash !== pair.rightHash) bad(at, "pair hashes differ");
    }
    for (const name of SCHEDULER_PAIR_NAMES)
      if (names.get(name) !== 1) bad(`${path}.pairs.${name}`, "exactly one entry required");
    for (const name of names.keys())
      if (!(SCHEDULER_PAIR_NAMES as readonly string[]).includes(name))
        bad(`${path}.pairs.${name}`, "unknown pair");
  }
  return problems;
}

/** Cross-runtime comparison summary of the scheduler section. */
export function schedulerComparisonProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["comparison.scheduler: must be a record"];
  if (value.equal !== true) problems.push("comparison.scheduler.equal: must be true");
  for (const key of ["nodeHash", "workersHash"])
    if (!hex(value[key]))
      problems.push(`comparison.scheduler.${key}: 64 lowercase hex characters required`);
  if (value.nodeHash !== value.workersHash)
    problems.push("comparison.scheduler: node and workers hashes differ");
  if (value.engineVersion !== SCHEDULER_ENGINE_VERSION)
    problems.push("comparison.scheduler.engineVersion: must equal the engine version");
  for (const key of ["entryCount", "refusalCount"])
    if (!Number.isInteger(value[key]) || (value[key] as number) < 1)
      problems.push(`comparison.scheduler.${key}: positive integer required`);
  if (value.pairCount !== SCHEDULER_PAIR_NAMES.length)
    problems.push("comparison.scheduler.pairCount: must equal the differential pair count");
  return problems;
}

/** Validates the three written report bodies together for the scheduler section. */
export function schedulerReportProblems(
  node: unknown,
  workers: unknown,
  comparison: unknown,
): string[] {
  const nodeSection =
    isRecord(node) && isRecord(node.evidence) ? node.evidence.scheduler : undefined;
  const workersSection =
    isRecord(workers) && isRecord(workers.evidence) ? workers.evidence.scheduler : undefined;
  const summary = isRecord(comparison) ? comparison.scheduler : undefined;
  const problems = [
    ...(nodeSection === undefined
      ? ["node.json: scheduler section missing"]
      : schedulerEvidenceProblems(nodeSection, "node.scheduler")),
    ...(workersSection === undefined
      ? ["workers.json: scheduler section missing"]
      : schedulerEvidenceProblems(workersSection, "workers.scheduler")),
    ...schedulerComparisonProblems(summary),
  ];
  if (
    nodeSection !== undefined &&
    workersSection !== undefined &&
    JSON.stringify(nodeSection) !== JSON.stringify(workersSection)
  )
    problems.push("node and workers scheduler bodies differ");
  if (isRecord(summary)) {
    const sha = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (nodeSection !== undefined && summary.nodeHash !== sha(nodeSection))
      problems.push("comparison.scheduler.nodeHash does not match node.json");
    if (workersSection !== undefined && summary.workersHash !== sha(workersSection))
      problems.push("comparison.scheduler.workersHash does not match workers.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.entries) &&
      summary.entryCount !== nodeSection.entries.length
    )
      problems.push("comparison.scheduler.entryCount does not match node.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.pairs) &&
      summary.pairCount !== nodeSection.pairs.length
    )
      problems.push("comparison.scheduler.pairCount does not match node.json");
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// RW-0107a environment section. As for the scheduler, the literals are repeated here (not imported)
// so the schema independently pins the pair names, the golden hashes and the refusal catalogue.
// ---------------------------------------------------------------------------------------------

export const ENVIRONMENT_PAIR_NAMES = [
  "live-steps-vs-fast-forward",
  "bounded-continuation-vs-unbounded",
] as const;
export const ENVIRONMENT_EQUIVALENCE = "material-threshold";
export const ENVIRONMENT_EVENT_TYPES = [
  "environment.phase-changed",
  "weather.transitioned",
  "exposure.threshold-crossed",
] as const;
const ENVIRONMENT_RANK: Readonly<Record<string, number>> = {
  "environment.phase-changed": 0,
  "weather.transitioned": 1,
  "exposure.threshold-crossed": 2,
  "routine.selected": 3,
};
const ENVIRONMENT_CHECK = "environment.state-matches-policy@1";
const ENVIRONMENT_RAIN_CHANGES = ["began", "ended", "changed", "unchanged"] as const;
const ENVIRONMENT_CROSSINGS = [
  "wet.entered",
  "wet.left",
  "uncomfortable.entered",
  "uncomfortable.left",
] as const;

/** Committed literals of the `rain-shelter-comfort` golden; any change here is a reviewed change. */
export const ENVIRONMENT_GOLDEN = {
  name: "rain-shelter-comfort",
  materialEventHash: "f29049ce223ded73fda2326eda5417f989f6c1673d6df8029467749575ac2b91",
  finalStateHash: "da83e70c5e0810352f8394839e5067cb2c2a79d1ae17403154b1e6feec442542",
} as const;

const ENV_POLICY = "pack.pack.policy.environment";
const ENV_STATE = "partition.state.environment";
const envPolicy = (name: string, suffix = ""): SchedulerRefusalCase =>
  sched(name, "invalid-input", `${ENV_POLICY}${suffix}`);
const envState = (name: string, suffix = ""): SchedulerRefusalCase =>
  sched(name, "invalid-input", `${ENV_STATE}${suffix}`);
const envDisagrees = (name: string, path = "state.environment"): SchedulerRefusalCase =>
  sched(name, "precondition-failed", path, ENVIRONMENT_CHECK);
const envInvariant = (name: string): SchedulerRefusalCase =>
  sched(name, "invariant-violated", "state.environment.phase", ENVIRONMENT_CHECK);

/** Fixed named refusal cases; every one must appear as an entry labelled `refusal:<name>`. */
export const ENVIRONMENT_REFUSAL_CASES: readonly SchedulerRefusalCase[] = [
  envPolicy("policy-null"),
  envPolicy("policy-wrong-type"),
  envPolicy("policy-missing-field", ".dayLengthMs"),
  envPolicy("policy-extra-field", ".extra"),
  envPolicy("unknown-version", ".schemaVersion"),
  envPolicy("phase-null", ".phases[0]"),
  envPolicy("phase-missing-field", ".phases[0].lightBand"),
  envPolicy("phase-extra-field", ".phases[0].extra"),
  envPolicy("segment-null", ".weatherSegments[0]"),
  envPolicy("segment-missing-field", ".weatherSegments[0].durationMs"),
  envPolicy("segment-extra-field", ".weatherSegments[0].extra"),
  envPolicy("threshold-missing", ".wetThreshold"),
  envPolicy("threshold-wrong-type", ".discomfortThreshold"),
  envPolicy("day-length-zero", ".dayLengthMs"),
  envPolicy("day-length-negative", ".dayLengthMs"),
  envPolicy("day-length-wrong-type", ".dayLengthMs"),
  envPolicy("day-length-out-of-range", ".dayLengthMs"),
  envPolicy("duration-zero", ".weatherSegments[0].durationMs"),
  envPolicy("duration-out-of-range", ".weatherSegments[0].durationMs"),
  envPolicy("phases-empty", ".phases"),
  envPolicy("phases-too-many", ".phases"),
  envPolicy("segments-empty", ".weatherSegments"),
  envPolicy("segments-too-many", ".weatherSegments"),
  envPolicy("first-phase-not-zero", ".phases[0].startMs"),
  envPolicy("phase-starts-not-increasing", ".phases[2].startMs"),
  envPolicy("phase-start-beyond-day", ".phases[4].startMs"),
  envPolicy("duplicate-phase-name", ".phases[1].name"),
  envPolicy("rain-negative", ".weatherSegments[0].rainIntensity"),
  envPolicy("rain-over-range", ".weatherSegments[0].rainIntensity"),
  envPolicy("threshold-zero", ".wetThreshold"),
  envPolicy("threshold-over-range", ".discomfortThreshold"),
  envState("state-null"),
  envState("state-wrong-type"),
  envState("state-missing-field", ".phase"),
  envState("state-extra-field", ".extra"),
  envState("state-field-wrong-type", ".segmentIndex"),
  envState("state-boundary-wrong-type", ".nextPhaseBoundary"),
  envDisagrees("state-without-policy"),
  envDisagrees("policy-without-state"),
  envDisagrees("phase-differs", "state.environment.phase"),
  envDisagrees("light-band-differs", "state.environment.lightBand"),
  envDisagrees("segment-differs", "state.environment.segmentIndex"),
  envDisagrees("temperature-differs", "state.environment.temperatureBand"),
  envDisagrees("phase-boundary-differs", "state.environment.nextPhaseBoundary"),
  envDisagrees("weather-boundary-differs", "state.environment.nextWeatherBoundary"),
  envInvariant("invariant-advance"),
  envInvariant("invariant-weather-set"),
  envInvariant("invariant-containment"),
  envInvariant("invariant-movement"),
  sched("system-exception", "check-error", "request.systems[0]", "catch-up.system@1"),
  sched("handler-exception", "handler-failed", "handler"),
  sched("reducer-exception", "reducer-failed", "events[2]"),
];

/** Executable schema of the `environment` evidence section; returns every violation (empty = valid). */
export function environmentEvidenceProblems(value: unknown, path = "environment"): string[] {
  const problems: string[] = [];
  const bad = (at: string, why: string) => problems.push(`${at}: ${why}`);
  if (!isRecord(value)) return [`${path}: must be a record`];
  if (value.schemaVersion !== 1) bad(`${path}.schemaVersion`, "must be 1");
  if (!isRecord(value.seed) || typeof value.seed.seed !== "string")
    bad(`${path}.seed`, "seed record required");
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    bad(`${path}.entries`, "non-empty array required");
    return problems;
  }
  const labels = new Map<string, Record<string, unknown>>();
  const refusalCodes = new Set<string>();
  const eventTypes = new Set<string>();
  const rainChanges = new Set<string>();
  const crossings = new Set<string>();
  const seen = { incomplete: false, generated: false, success: false };
  for (const [index, entry] of value.entries.entries()) {
    const at = `${path}.entries[${index}]`;
    if (!isRecord(entry) || typeof entry.label !== "string") {
      bad(at, "label required");
      continue;
    }
    if (labels.has(entry.label)) bad(at, `duplicate label ${entry.label}`);
    if (entry.label.startsWith("generated:")) seen.generated = true;
    const input = entry.input;
    const output = entry.output;
    if (!isRecord(input)) bad(`${at}.input`, "record required");
    else {
      for (const key of ["type", "commandId"])
        if (input[key] !== null && typeof input[key] !== "string")
          bad(`${at}.input.${key}`, "string or null required");
      if (input.version !== null && !Number.isSafeInteger(input.version))
        bad(`${at}.input.version`, "null or safe integer required");
      if (!ENCODINGS.includes(input.encoding as string))
        bad(`${at}.input.encoding`, "canonical-v1 or malformed-input-v1 required");
      for (const key of ["inputHash", "preStateHash", "schedulesHash", "policyHash"])
        if (!hex(input[key])) bad(`${at}.input.${key}`, "64 lowercase hex characters required");
      if (input.targetTime !== null && !decimal(input.targetTime))
        bad(`${at}.input.targetTime`, "null or decimal time required");
      for (const key of ["maxInputs", "maxEvents"])
        if (input[key] !== null && !Number.isSafeInteger(input[key]))
          bad(`${at}.input.${key}`, "null or safe integer required");
    }
    if (!isRecord(output)) {
      bad(`${at}.output`, "record required");
      continue;
    }
    labels.set(entry.label, output);
    if (output.kind === "success") {
      seen.success = true;
      if (!Array.isArray(output.events)) bad(`${at}.output.events`, "array required");
      else {
        let previousTime = -1n;
        let previousRank = -1;
        for (const [position, event] of output.events.entries()) {
          const where = `${at}.output.events[${position}]`;
          if (
            !isRecord(event) ||
            typeof event.type !== "string" ||
            !(event.type in ENVIRONMENT_RANK) ||
            !decimal(event.time) ||
            typeof event.eventId !== "string" ||
            event.eventId.length === 0 ||
            !hex(event.payloadHash)
          ) {
            bad(where, "material event type, decimal time, event id and payload hash required");
            continue;
          }
          const time = BigInt(event.time as string);
          const rank = ENVIRONMENT_RANK[event.type] ?? 0;
          if (time < previousTime) bad(where, "events must be in simulation-time order");
          else if (time === previousTime && rank < previousRank)
            bad(where, "same-time order must be phase/weather, then exposure, then decision");
          previousTime = time;
          previousRank = rank;
          eventTypes.add(event.type);
        }
      }
      if (
        !strings(output.rainChanges) ||
        output.rainChanges.some(
          (change) => !(ENVIRONMENT_RAIN_CHANGES as readonly string[]).includes(change),
        )
      )
        bad(`${at}.output.rainChanges`, "rain change array required");
      else for (const change of output.rainChanges) rainChanges.add(change);
      if (
        !strings(output.crossings) ||
        output.crossings.some(
          (crossing) => !(ENVIRONMENT_CROSSINGS as readonly string[]).includes(crossing),
        )
      )
        bad(`${at}.output.crossings`, "threshold crossing array required");
      else for (const crossing of output.crossings) crossings.add(crossing);
      if (!hex(output.postStateHash))
        bad(`${at}.output.postStateHash`, "64 lowercase hex characters required");
      if (typeof output.complete !== "boolean") bad(`${at}.output.complete`, "boolean required");
      if (output.continuationHash !== null && !hex(output.continuationHash))
        bad(`${at}.output.continuationHash`, "null or 64 lowercase hex characters required");
      else if ((output.continuationHash === null) !== (output.complete === true))
        bad(
          `${at}.output.continuationHash`,
          "a continuation exists exactly when the call is incomplete",
        );
      if (output.complete === false && hex(output.continuationHash)) seen.incomplete = true;
    } else if (output.kind === "refusal") {
      if (typeof output.code !== "string" || typeof output.path !== "string")
        bad(`${at}.output`, "refusal code and path required");
      else refusalCodes.add(output.code);
      if (output.check !== null && typeof output.check !== "string")
        bad(`${at}.output.check`, "check name or null required");
    } else bad(`${at}.output.kind`, "success or refusal required");
  }
  if (!seen.success) bad(`${path}.coverage`, "no successful call was recorded");
  for (const type of ENVIRONMENT_EVENT_TYPES)
    if (!eventTypes.has(type)) bad(`${path}.coverage`, `no entry carries ${type}`);
  for (const change of ["began", "ended"])
    if (!rainChanges.has(change))
      bad(`${path}.coverage`, `no weather transition ${change} the rain`);
  for (const crossing of ENVIRONMENT_CROSSINGS)
    if (!crossings.has(crossing)) bad(`${path}.coverage`, `no exposure crossing ${crossing}`);
  if (!seen.incomplete)
    bad(`${path}.coverage`, "no incomplete call with a continuation was recorded");
  if (!seen.generated) bad(`${path}.generated`, "missing generated entries");
  for (const refusalCase of ENVIRONMENT_REFUSAL_CASES) {
    const output = labels.get(`refusal:${refusalCase.name}`);
    if (output === undefined) {
      bad(`${path}.refusals.${refusalCase.name}`, "missing refusal case");
      continue;
    }
    if (
      output.kind !== "refusal" ||
      output.code !== refusalCase.code ||
      output.path !== refusalCase.path ||
      output.check !== refusalCase.check
    )
      bad(
        `${path}.refusals.${refusalCase.name}`,
        `must refuse with ${refusalCase.code} at ${refusalCase.path}`,
      );
  }
  for (const code of new Set(ENVIRONMENT_REFUSAL_CASES.map((item) => item.code)))
    if (!refusalCodes.has(code)) bad(`${path}.refusalCodes`, `missing refusal code ${code}`);
  if (!Array.isArray(value.pairs)) bad(`${path}.pairs`, "array required");
  else {
    const names = new Map<string, number>();
    for (const [index, pair] of value.pairs.entries()) {
      const at = `${path}.pairs[${index}]`;
      if (!isRecord(pair) || typeof pair.name !== "string") {
        bad(at, "pair name required");
        continue;
      }
      names.set(pair.name, (names.get(pair.name) ?? 0) + 1);
      if (pair.equivalence !== ENVIRONMENT_EQUIVALENCE)
        bad(`${at}.equivalence`, `must declare ${ENVIRONMENT_EQUIVALENCE}`);
      for (const key of ["leftHash", "rightHash"])
        if (!hex(pair[key])) bad(`${at}.${key}`, "64 lowercase hex characters required");
      if (pair.leftHash !== pair.rightHash) bad(at, "pair hashes differ");
    }
    for (const name of ENVIRONMENT_PAIR_NAMES)
      if (names.get(name) !== 1) bad(`${path}.pairs.${name}`, "exactly one entry required");
    for (const name of names.keys())
      if (!(ENVIRONMENT_PAIR_NAMES as readonly string[]).includes(name))
        bad(`${path}.pairs.${name}`, "unknown pair");
  }
  const golden = value.golden;
  if (!isRecord(golden)) bad(`${path}.golden`, "record required");
  else {
    if (golden.name !== ENVIRONMENT_GOLDEN.name)
      bad(`${path}.golden.name`, `must be ${ENVIRONMENT_GOLDEN.name}`);
    for (const key of ["materialEventHash", "finalStateHash"] as const) {
      if (!hex(golden[key])) bad(`${path}.golden.${key}`, "64 lowercase hex characters required");
      else if (golden[key] !== ENVIRONMENT_GOLDEN[key])
        bad(
          `${path}.golden.${key}`,
          `must equal the committed literal (recorded ${String(golden[key])})`,
        );
    }
  }
  return problems;
}

/** Cross-runtime comparison summary of the environment section. */
export function environmentComparisonProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["comparison.environment: must be a record"];
  if (value.equal !== true) problems.push("comparison.environment.equal: must be true");
  for (const key of ["nodeHash", "workersHash", "goldenMaterialEventHash", "goldenFinalStateHash"])
    if (!hex(value[key]))
      problems.push(`comparison.environment.${key}: 64 lowercase hex characters required`);
  if (value.nodeHash !== value.workersHash)
    problems.push("comparison.environment: node and workers hashes differ");
  if (
    value.goldenMaterialEventHash !== ENVIRONMENT_GOLDEN.materialEventHash ||
    value.goldenFinalStateHash !== ENVIRONMENT_GOLDEN.finalStateHash
  )
    problems.push("comparison.environment: golden hashes must equal the committed literals");
  for (const key of ["entryCount", "refusalCount"])
    if (!Number.isInteger(value[key]) || (value[key] as number) < 1)
      problems.push(`comparison.environment.${key}: positive integer required`);
  if (value.pairCount !== ENVIRONMENT_PAIR_NAMES.length)
    problems.push("comparison.environment.pairCount: must equal the differential pair count");
  return problems;
}

/** Validates the three written report bodies together for the environment section. */
export function environmentReportProblems(
  node: unknown,
  workers: unknown,
  comparison: unknown,
): string[] {
  const nodeSection =
    isRecord(node) && isRecord(node.evidence) ? node.evidence.environment : undefined;
  const workersSection =
    isRecord(workers) && isRecord(workers.evidence) ? workers.evidence.environment : undefined;
  const summary = isRecord(comparison) ? comparison.environment : undefined;
  const problems = [
    ...(nodeSection === undefined
      ? ["node.json: environment section missing"]
      : environmentEvidenceProblems(nodeSection, "node.environment")),
    ...(workersSection === undefined
      ? ["workers.json: environment section missing"]
      : environmentEvidenceProblems(workersSection, "workers.environment")),
    ...environmentComparisonProblems(summary),
  ];
  if (
    nodeSection !== undefined &&
    workersSection !== undefined &&
    JSON.stringify(nodeSection) !== JSON.stringify(workersSection)
  )
    problems.push("node and workers environment bodies differ");
  if (isRecord(summary)) {
    const sha = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (nodeSection !== undefined && summary.nodeHash !== sha(nodeSection))
      problems.push("comparison.environment.nodeHash does not match node.json");
    if (workersSection !== undefined && summary.workersHash !== sha(workersSection))
      problems.push("comparison.environment.workersHash does not match workers.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.entries) &&
      summary.entryCount !== nodeSection.entries.length
    )
      problems.push("comparison.environment.entryCount does not match node.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.entries) &&
      summary.refusalCount !==
        nodeSection.entries.filter(
          (entry: unknown) =>
            isRecord(entry) && isRecord(entry.output) && entry.output.kind === "refusal",
        ).length
    )
      problems.push("comparison.environment.refusalCount does not match node.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.pairs) &&
      summary.pairCount !== nodeSection.pairs.length
    )
      problems.push("comparison.environment.pairCount does not match node.json");
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// RW-0107b: resources and growth (`ecology` section)
// ---------------------------------------------------------------------------------------------

export const ECOLOGY_PAIR_NAMES = [
  "live-steps-vs-fast-forward",
  "bounded-continuation-vs-unbounded",
] as const;
export const ECOLOGY_EQUIVALENCE = "material-ecology";
export const ECOLOGY_EVENT_TYPES = [
  "resource.appeared",
  "resource.spoiled",
  "growth.stage-changed",
  "growth.integrated",
] as const;
/** Same-time rank of the material events: phase and weather, exposure, spoilage, appearance, stage, decision. */
const ECOLOGY_RANK: Readonly<Record<string, number>> = {
  "environment.phase-changed": 0,
  "weather.transitioned": 1,
  "exposure.threshold-crossed": 2,
  "resource.spoiled": 3,
  "resource.appeared": 4,
  "growth.stage-changed": 5,
  "routine.selected": 6,
};
const ECOLOGY_CHECK = "ecology.state-matches-policy@1";
const ECOLOGY_BATCH_CHECK = "resource.perishable-single-batch@1";
const ECOLOGY_KINDS = ["food", "water"] as const;

/** Committed literals of the two ecology goldens; any change here is a reviewed change. */
export const ECOLOGY_GOLDENS = [
  {
    name: "food-decay-and-conservation",
    materialEventHash: "72a52ddf64ac477802cf56200d49a2ffed84e242578c5607d6ebbc894e0bf28b",
    finalStateHash: "f80d1e1050641b4f1e6605a2af384b92e7932d6c7bb32e2c07d2602692702765",
  },
  {
    name: "cedar-growth",
    materialEventHash: "023be47e530b5e49844b720d0f565f221efc83935090f8b70a32ae1111eb495d",
    finalStateHash: "590ea459a70e9e4da9c06ee58b4c7f5d7ba5a35721625a65396ca643e1b24cd7",
  },
] as const;

const ECO_POLICY = "pack.pack.policy.ecology";
const ECO_STATE = "partition.state.ecology";
const ecoPolicy = (name: string, suffix = ""): SchedulerRefusalCase =>
  sched(name, "invalid-input", `${ECO_POLICY}${suffix}`);
const ecoState = (name: string, suffix = ""): SchedulerRefusalCase =>
  sched(name, "invalid-input", `${ECO_STATE}${suffix}`);
const ecoDisagrees = (name: string, path: string): SchedulerRefusalCase =>
  sched(name, "precondition-failed", path, ECOLOGY_CHECK);
const ecoInvariant = (name: string): SchedulerRefusalCase =>
  sched(name, "invariant-violated", "state.ecology.plants[0].stage", ECOLOGY_CHECK);

/** Fixed named refusal cases; every one must appear as an entry labelled `refusal:<name>`. */
export const ECOLOGY_REFUSAL_CASES: readonly SchedulerRefusalCase[] = [
  ecoPolicy("policy-null"),
  ecoPolicy("policy-wrong-type"),
  ecoPolicy("policy-missing-field", ".sources"),
  ecoPolicy("policy-extra-field", ".extra"),
  ecoPolicy("unknown-version", ".schemaVersion"),
  ecoPolicy("policy-without-environment"),
  ecoPolicy("source-null", ".sources[0]"),
  ecoPolicy("source-missing-field", ".sources[0].quantity"),
  ecoPolicy("source-extra-field", ".sources[0].extra"),
  ecoPolicy("perishable-null", ".perishables[0]"),
  ecoPolicy("perishable-missing-field", ".perishables[0].shelfLifeMs"),
  ecoPolicy("perishable-extra-field", ".perishables[0].extra"),
  ecoPolicy("plant-null", ".plants[0]"),
  ecoPolicy("plant-missing-field", ".plants[0].stages"),
  ecoPolicy("plant-extra-field", ".plants[0].extra"),
  ecoPolicy("stage-null", ".plants[0].stages[0]"),
  ecoPolicy("stage-missing-field", ".plants[0].stages[0].name"),
  ecoPolicy("stage-extra-field", ".plants[0].stages[0].extra"),
  ecoPolicy("first-time-zero", ".sources[0].firstAtMs"),
  ecoPolicy("first-time-negative", ".sources[0].firstAtMs"),
  ecoPolicy("first-time-wrong-type", ".sources[0].firstAtMs"),
  ecoPolicy("first-time-out-of-range", ".sources[0].firstAtMs"),
  ecoPolicy("period-zero", ".sources[0].periodMs"),
  ecoPolicy("period-out-of-range", ".sources[0].periodMs"),
  ecoPolicy("quantity-zero", ".sources[0].quantity"),
  ecoPolicy("quantity-negative", ".sources[0].quantity"),
  ecoPolicy("quantity-wrong-type", ".sources[0].quantity"),
  ecoPolicy("quantity-out-of-range", ".sources[0].quantity"),
  ecoPolicy("shelf-life-zero", ".perishables[0].shelfLifeMs"),
  ecoPolicy("shelf-life-out-of-range", ".perishables[0].shelfLifeMs"),
  ecoPolicy("threshold-negative", ".plants[0].stages[1].thresholdMs"),
  ecoPolicy("threshold-out-of-range", ".plants[0].stages[1].thresholdMs"),
  ecoPolicy("sources-too-many", ".sources"),
  ecoPolicy("perishables-too-many", ".perishables"),
  ecoPolicy("plants-too-many", ".plants"),
  ecoPolicy("bands-too-many", ".plants[0].growingLightBands"),
  ecoPolicy("bands-empty", ".plants[0].growingLightBands"),
  ecoPolicy("stages-too-few", ".plants[0].stages"),
  ecoPolicy("stages-too-many", ".plants[0].stages"),
  ecoPolicy("first-stage-not-zero", ".plants[0].stages[0].thresholdMs"),
  ecoPolicy("thresholds-not-increasing", ".plants[0].stages[2].thresholdMs"),
  ecoPolicy("duplicate-stage-name", ".plants[0].stages[1].name"),
  ecoPolicy("duplicate-source-id", ".sources[1].objectId"),
  ecoPolicy("duplicate-perishable-id", ".perishables[1].objectId"),
  ecoPolicy("duplicate-plant-id", ".plants[1].objectId"),
  ecoPolicy("plant-also-source", ".plants[0].objectId"),
  ecoPolicy("plant-also-perishable", ".plants[0].objectId"),
  ecoPolicy("unknown-light-band", ".plants[0].growingLightBands[0]"),
  ecoState("state-null"),
  ecoState("state-wrong-type"),
  ecoState("state-missing-field", ".plants"),
  ecoState("state-extra-field", ".extra"),
  ecoState("perishable-entry-null", ".perishables[0]"),
  ecoState("perishable-entry-missing-field", ".perishables[0].arrivedAt"),
  ecoState("perishable-entry-extra-field", ".perishables[0].extra"),
  ecoState("perishable-entry-wrong-type", ".perishables[0].arrivedAt"),
  ecoState("plant-entry-null", ".plants[0]"),
  ecoState("plant-entry-missing-field", ".plants[0].stage"),
  ecoState("plant-entry-extra-field", ".plants[0].extra"),
  ecoState("plant-entry-wrong-type", ".plants[0].stage"),
  ecoDisagrees("state-without-policy", "state.ecology"),
  ecoDisagrees("policy-without-state", "state.ecology"),
  ecoDisagrees("perishables-count-differs", "state.ecology.perishables"),
  ecoDisagrees("plants-count-differs", "state.ecology.plants"),
  ecoDisagrees("perishable-id-differs", "state.ecology.perishables[0].objectId"),
  ecoDisagrees("plant-id-differs", "state.ecology.plants[0].objectId"),
  ecoDisagrees("source-object-missing", "policy.ecology.sources[1].objectId"),
  ecoDisagrees("source-kind-differs", "policy.ecology.sources[1].kind"),
  ecoDisagrees("source-without-resource", "policy.ecology.sources[1].kind"),
  ecoDisagrees("perishable-object-missing", "state.ecology.perishables[1].objectId"),
  ecoDisagrees("perishable-not-food", "state.ecology.perishables[1].objectId"),
  ecoDisagrees("plant-object-missing", "state.ecology.plants[0].objectId"),
  ecoDisagrees("arrival-on-empty-holder", "state.ecology.perishables[1].arrivedAt"),
  ecoDisagrees("arrival-absent-with-food", "state.ecology.perishables[0].arrivedAt"),
  ecoDisagrees("arrival-after-state-time", "state.ecology.perishables[0].arrivedAt"),
  ecoDisagrees("spoilage-time-passed", "state.ecology.perishables[0].arrivedAt"),
  ecoDisagrees("plant-integrated-after-time", "state.ecology.plants[0].integratedAt"),
  ecoDisagrees("plant-stage-disagrees", "state.ecology.plants[0].stage"),
  ecoInvariant("invariant-advance"),
  ecoInvariant("invariant-weather-set"),
  ecoInvariant("invariant-containment"),
  ecoInvariant("invariant-movement"),
  sched("perishable-offer", "precondition-failed", "payload.objectId", ECOLOGY_BATCH_CHECK),
  sched("perishable-transfer", "precondition-failed", "payload.toObjectId", ECOLOGY_BATCH_CHECK),
  sched("system-exception", "check-error", "request.systems[0]", "catch-up.system@1"),
  sched("handler-exception", "handler-failed", "handler"),
  sched("reducer-exception", "reducer-failed", "events[1]"),
];

/** Targeted engine calls that Node and Workers must both record (`targeted:<name>:<call index>`). */
const ECOLOGY_TARGETED_RUNS = [
  "skip-appearance",
  "skip-appearance-eat",
  "skip-appearance-later",
  "consume-partial",
  "consume-to-zero",
  "transfer-advance",
  "transfer-from-perishable",
  "transfer-from-plain",
  "dry-daylight",
  "wet-at-night",
  "decision-probe",
  "order-through",
  "order-target",
  "stage-through",
  "stage-target",
  "weather-set-plants-first",
] as const;

/** Retrying a consume against its post-state must conflict on the expected revision. */
const ECOLOGY_RETRY_LABELS = [
  "case:food-retry-food-partial",
  "case:food-retry-water-all",
  "case:food-retry-food-zero",
  "case:food-retry-water-again",
] as const;

function totalsProblems(
  value: unknown,
  at: string,
  bad: (at: string, why: string) => void,
): Record<string, bigint> | null {
  if (!isRecord(value) || ECOLOGY_KINDS.some((kind) => !decimal(value[kind]))) {
    bad(at, "decimal food and water totals required");
    return null;
  }
  return { food: BigInt(value.food as string), water: BigInt(value.water as string) };
}

/** Executable schema of the `ecology` evidence section; returns every violation (empty = valid). */
export function ecologyEvidenceProblems(value: unknown, path = "ecology"): string[] {
  const problems: string[] = [];
  const bad = (at: string, why: string) => problems.push(`${at}: ${why}`);
  if (!isRecord(value)) return [`${path}: must be a record`];
  if (value.schemaVersion !== 1) bad(`${path}.schemaVersion`, "must be 1");
  if (!isRecord(value.seed) || typeof value.seed.seed !== "string")
    bad(`${path}.seed`, "seed record required");
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    bad(`${path}.entries`, "non-empty array required");
    return problems;
  }
  const labels = new Map<string, Record<string, unknown>>();
  const refusalCodes = new Set<string>();
  const refusalChecks = new Set<string>();
  const eventTypes = new Set<string>();
  const seen = { incomplete: false, generated: false, success: false };
  for (const [index, entry] of value.entries.entries()) {
    const at = `${path}.entries[${index}]`;
    if (!isRecord(entry) || typeof entry.label !== "string") {
      bad(at, "label required");
      continue;
    }
    if (labels.has(entry.label)) bad(at, `duplicate label ${entry.label}`);
    if (entry.label.startsWith("generated:")) seen.generated = true;
    const input = entry.input;
    const output = entry.output;
    if (!isRecord(input)) bad(`${at}.input`, "record required");
    else {
      for (const key of ["type", "commandId"])
        if (input[key] !== null && typeof input[key] !== "string")
          bad(`${at}.input.${key}`, "string or null required");
      if (input.version !== null && !Number.isSafeInteger(input.version))
        bad(`${at}.input.version`, "null or safe integer required");
      if (!ENCODINGS.includes(input.encoding as string))
        bad(`${at}.input.encoding`, "canonical-v1 or malformed-input-v1 required");
      for (const key of ["inputHash", "preStateHash", "schedulesHash", "policyHash"])
        if (!hex(input[key])) bad(`${at}.input.${key}`, "64 lowercase hex characters required");
      if (input.targetTime !== null && !decimal(input.targetTime))
        bad(`${at}.input.targetTime`, "null or decimal time required");
      for (const key of ["maxInputs", "maxEvents"])
        if (input[key] !== null && !Number.isSafeInteger(input[key]))
          bad(`${at}.input.${key}`, "null or safe integer required");
    }
    if (!isRecord(output)) {
      bad(`${at}.output`, "record required");
      continue;
    }
    labels.set(entry.label, output);
    const conservation = entry.conservation;
    if (!isRecord(conservation)) bad(`${at}.conservation`, "record required");
    else {
      const before = totalsProblems(conservation.before, `${at}.conservation.before`, bad);
      const after = totalsProblems(conservation.after, `${at}.conservation.after`, bad);
      const change = isRecord(conservation.change)
        ? ECOLOGY_KINDS.every(
            (kind) =>
              typeof (conservation.change as Record<string, unknown>)[kind] === "string" &&
              /^-?\d+$/u.test((conservation.change as Record<string, string>)[kind]!),
          )
          ? {
              food: BigInt((conservation.change as Record<string, string>).food!),
              water: BigInt((conservation.change as Record<string, string>).water!),
            }
          : null
        : null;
      if (change === null)
        bad(`${at}.conservation.change`, "integer food and water changes required");
      if (before !== null && after !== null && change !== null)
        for (const kind of ECOLOGY_KINDS) {
          if (before[kind]! < 0n || after[kind]! < 0n)
            bad(`${at}.conservation`, `${kind} total is negative`);
          if (after[kind] !== before[kind]! + change[kind]!)
            bad(
              `${at}.conservation`,
              `${kind} total after must equal total before plus the recorded change`,
            );
        }
    }
    if (output.kind === "success") {
      seen.success = true;
      if (!Array.isArray(output.events)) bad(`${at}.output.events`, "array required");
      else {
        let previousTime = -1n;
        let previousRank = -1;
        for (const [position, event] of output.events.entries()) {
          const where = `${at}.output.events[${position}]`;
          if (
            !isRecord(event) ||
            typeof event.type !== "string" ||
            !(event.type in ECOLOGY_RANK) ||
            !decimal(event.time) ||
            typeof event.eventId !== "string" ||
            event.eventId.length === 0 ||
            !hex(event.payloadHash)
          ) {
            bad(where, "material event type, decimal time, event id and payload hash required");
            continue;
          }
          const time = BigInt(event.time as string);
          const rank = ECOLOGY_RANK[event.type] ?? 0;
          if (time < previousTime) bad(where, "events must be in simulation-time order");
          else if (time === previousTime && rank < previousRank)
            bad(
              where,
              "same-time order must be phase/weather, exposure, spoilage, appearance, stage change, then decision",
            );
          previousTime = time;
          previousRank = rank;
          eventTypes.add(event.type);
        }
      }
      if (!strings(output.eventTypes)) bad(`${at}.output.eventTypes`, "event type array required");
      else for (const type of output.eventTypes) eventTypes.add(type);
      if (!hex(output.postStateHash))
        bad(`${at}.output.postStateHash`, "64 lowercase hex characters required");
      if (typeof output.complete !== "boolean") bad(`${at}.output.complete`, "boolean required");
      if (output.continuationHash !== null && !hex(output.continuationHash))
        bad(`${at}.output.continuationHash`, "null or 64 lowercase hex characters required");
      else if ((output.continuationHash === null) !== (output.complete === true))
        bad(
          `${at}.output.continuationHash`,
          "a continuation exists exactly when the call is incomplete",
        );
      if (output.complete === false && hex(output.continuationHash)) seen.incomplete = true;
    } else if (output.kind === "refusal") {
      if (typeof output.code !== "string" || typeof output.path !== "string")
        bad(`${at}.output`, "refusal code and path required");
      else refusalCodes.add(output.code);
      if (output.check !== null && typeof output.check !== "string")
        bad(`${at}.output.check`, "check name or null required");
      else if (typeof output.check === "string") refusalChecks.add(output.check);
    } else bad(`${at}.output.kind`, "success or refusal required");
  }
  if (!seen.success) bad(`${path}.coverage`, "no successful call was recorded");
  for (const type of ECOLOGY_EVENT_TYPES)
    if (!eventTypes.has(type)) bad(`${path}.coverage`, `no entry carries ${type}`);
  if (!seen.incomplete)
    bad(`${path}.coverage`, "no incomplete call with a continuation was recorded");
  if (!seen.generated) bad(`${path}.generated`, "missing generated entries");
  for (const name of ECOLOGY_TARGETED_RUNS) {
    const output = labels.get(`targeted:${name}:0`);
    if (output === undefined || output.kind !== "success")
      bad(`${path}.targeted.${name}`, "targeted call must be recorded as a success");
  }
  for (const label of ECOLOGY_RETRY_LABELS) {
    const output = labels.get(label);
    if (output === undefined || output.kind !== "refusal" || output.code !== "revision-conflict")
      bad(
        `${path}.retries.${label}`,
        "retrying a consume against its post-state must be a revision-conflict",
      );
  }
  for (const refusalCase of ECOLOGY_REFUSAL_CASES) {
    const output = labels.get(`refusal:${refusalCase.name}`);
    if (output === undefined) {
      bad(`${path}.refusals.${refusalCase.name}`, "missing refusal case");
      continue;
    }
    if (
      output.kind !== "refusal" ||
      output.code !== refusalCase.code ||
      output.path !== refusalCase.path ||
      output.check !== refusalCase.check
    )
      bad(
        `${path}.refusals.${refusalCase.name}`,
        `must refuse with ${refusalCase.code} at ${refusalCase.path}`,
      );
  }
  for (const code of new Set(ECOLOGY_REFUSAL_CASES.map((item) => item.code)))
    if (!refusalCodes.has(code)) bad(`${path}.refusalCodes`, `missing refusal code ${code}`);
  for (const check of new Set(
    ECOLOGY_REFUSAL_CASES.flatMap((item) => (item.check === null ? [] : [item.check])),
  ))
    if (!refusalChecks.has(check)) bad(`${path}.refusalChecks`, `missing refusal check ${check}`);
  if (!Array.isArray(value.pairs)) bad(`${path}.pairs`, "array required");
  else {
    const names = new Map<string, number>();
    for (const [index, pair] of value.pairs.entries()) {
      const at = `${path}.pairs[${index}]`;
      if (!isRecord(pair) || typeof pair.name !== "string") {
        bad(at, "pair name required");
        continue;
      }
      names.set(pair.name, (names.get(pair.name) ?? 0) + 1);
      if (pair.equivalence !== ECOLOGY_EQUIVALENCE)
        bad(`${at}.equivalence`, `must declare ${ECOLOGY_EQUIVALENCE}`);
      for (const key of ["leftHash", "rightHash"])
        if (!hex(pair[key])) bad(`${at}.${key}`, "64 lowercase hex characters required");
      if (pair.leftHash !== pair.rightHash) bad(at, "pair hashes differ");
    }
    for (const name of ECOLOGY_PAIR_NAMES)
      if (names.get(name) !== 1) bad(`${path}.pairs.${name}`, "exactly one entry required");
    for (const name of names.keys())
      if (!(ECOLOGY_PAIR_NAMES as readonly string[]).includes(name))
        bad(`${path}.pairs.${name}`, "unknown pair");
  }
  if (!Array.isArray(value.goldens)) bad(`${path}.goldens`, "array required");
  else
    for (const expected of ECOLOGY_GOLDENS) {
      const golden = value.goldens.find(
        (item: unknown) => isRecord(item) && item.name === expected.name,
      );
      if (!isRecord(golden)) {
        bad(`${path}.goldens.${expected.name}`, "golden entry required");
        continue;
      }
      for (const key of ["materialEventHash", "finalStateHash"] as const) {
        if (!hex(golden[key]))
          bad(`${path}.goldens.${expected.name}.${key}`, "64 lowercase hex characters required");
        else if (golden[key] !== expected[key])
          bad(
            `${path}.goldens.${expected.name}.${key}`,
            `must equal the committed literal (recorded ${String(golden[key])})`,
          );
      }
    }
  if (Array.isArray(value.goldens) && value.goldens.length !== ECOLOGY_GOLDENS.length)
    bad(`${path}.goldens`, "exactly the declared goldens are required");
  return problems;
}

/** Cross-runtime comparison summary of the ecology section. */
export function ecologyComparisonProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["comparison.ecology: must be a record"];
  if (value.equal !== true) problems.push("comparison.ecology.equal: must be true");
  for (const key of ["nodeHash", "workersHash"])
    if (!hex(value[key]))
      problems.push(`comparison.ecology.${key}: 64 lowercase hex characters required`);
  if (value.nodeHash !== value.workersHash)
    problems.push("comparison.ecology: node and workers hashes differ");
  if (!Array.isArray(value.goldens)) problems.push("comparison.ecology.goldens: array required");
  else
    for (const expected of ECOLOGY_GOLDENS) {
      const golden = value.goldens.find(
        (item: unknown) => isRecord(item) && item.name === expected.name,
      );
      if (
        !isRecord(golden) ||
        golden.materialEventHash !== expected.materialEventHash ||
        golden.finalStateHash !== expected.finalStateHash
      )
        problems.push(
          `comparison.ecology.goldens.${expected.name}: hashes must equal the committed literals`,
        );
    }
  for (const key of ["entryCount", "refusalCount"])
    if (!Number.isInteger(value[key]) || (value[key] as number) < 1)
      problems.push(`comparison.ecology.${key}: positive integer required`);
  if (value.pairCount !== ECOLOGY_PAIR_NAMES.length)
    problems.push("comparison.ecology.pairCount: must equal the differential pair count");
  return problems;
}

/** Validates the three written report bodies together for the ecology section. */
export function ecologyReportProblems(
  node: unknown,
  workers: unknown,
  comparison: unknown,
): string[] {
  const nodeSection = isRecord(node) && isRecord(node.evidence) ? node.evidence.ecology : undefined;
  const workersSection =
    isRecord(workers) && isRecord(workers.evidence) ? workers.evidence.ecology : undefined;
  const summary = isRecord(comparison) ? comparison.ecology : undefined;
  const problems = [
    ...(nodeSection === undefined
      ? ["node.json: ecology section missing"]
      : ecologyEvidenceProblems(nodeSection, "node.ecology")),
    ...(workersSection === undefined
      ? ["workers.json: ecology section missing"]
      : ecologyEvidenceProblems(workersSection, "workers.ecology")),
    ...ecologyComparisonProblems(summary),
  ];
  if (
    nodeSection !== undefined &&
    workersSection !== undefined &&
    JSON.stringify(nodeSection) !== JSON.stringify(workersSection)
  )
    problems.push("node and workers ecology bodies differ");
  if (isRecord(summary)) {
    const sha = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (nodeSection !== undefined && summary.nodeHash !== sha(nodeSection))
      problems.push("comparison.ecology.nodeHash does not match node.json");
    if (workersSection !== undefined && summary.workersHash !== sha(workersSection))
      problems.push("comparison.ecology.workersHash does not match workers.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.entries) &&
      summary.entryCount !== nodeSection.entries.length
    )
      problems.push("comparison.ecology.entryCount does not match node.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.entries) &&
      summary.refusalCount !==
        nodeSection.entries.filter(
          (entry: unknown) =>
            isRecord(entry) && isRecord(entry.output) && entry.output.kind === "refusal",
        ).length
    )
      problems.push("comparison.ecology.refusalCount does not match node.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.pairs) &&
      summary.pairCount !== nodeSection.pairs.length
    )
      problems.push("comparison.ecology.pairCount does not match node.json");
    if (
      isRecord(nodeSection) &&
      JSON.stringify(summary.goldens) !== JSON.stringify(nodeSection.goldens)
    )
      problems.push("comparison.ecology.goldens do not match node.json");
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// RW-0108a: needs, comfort and health (`wellbeing` section)
// ---------------------------------------------------------------------------------------------

export const WELLBEING_PAIR_NAMES = [
  "live-steps-vs-fast-forward",
  "bounded-continuation-vs-unbounded",
  "scheduled-decisions-vs-advance",
] as const;
export const WELLBEING_EQUIVALENCE = "material-wellbeing";
export const WELLBEING_EVENT_TYPES = [
  "wellbeing.integrated",
  "needs.threshold-crossed",
  "comfort.changed",
  "health.threshold-crossed",
] as const;
/** Same-time rank of the material events: the RW-0107b order, then needs, comfort, health, the decision. */
const WELLBEING_RANK: Readonly<Record<string, number>> = {
  "environment.phase-changed": 0,
  "weather.transitioned": 1,
  "exposure.threshold-crossed": 2,
  "resource.spoiled": 3,
  "resource.appeared": 4,
  "growth.stage-changed": 5,
  "needs.threshold-crossed": 6,
  "comfort.changed": 7,
  "health.threshold-crossed": 8,
  "routine.selected": 9,
};
const WELLBEING_CHECK = "wellbeing.state-matches-policy@1";
const FIRST_DUE_CHECK = "world.decision.first-due@1";

/** Committed literals of the `comfort-and-health` golden; any change here is a reviewed change. */
export const WELLBEING_GOLDEN = {
  name: "comfort-and-health",
  materialEventHash: "f757f14b5c28c22191b216d844fd2fe3fa36002987deedfec506bebaca6ccf5f",
  finalStateHash: "75a95c4adca018ca1550755d14f3157477d15845702955d431619131aeb9ad9f",
} as const;

const WB_POLICY = "pack.pack.policy.wellbeing";
const WB_STATE = "partition.state.wellbeing";
const wbPolicy = (name: string, suffix = ""): SchedulerRefusalCase =>
  sched(name, "invalid-input", `${WB_POLICY}${suffix}`);
const wbState = (name: string, suffix = ""): SchedulerRefusalCase =>
  sched(name, "invalid-input", `${WB_STATE}${suffix}`);
const wbDisagrees = (name: string, path: string): SchedulerRefusalCase =>
  sched(name, "precondition-failed", path, WELLBEING_CHECK);
const wbInvariant = (name: string): SchedulerRefusalCase =>
  sched(name, "invariant-violated", "state.wellbeing.entries[0].comfort", WELLBEING_CHECK);
const wbScheduled = (name: string, suffix = "", code = "invalid-input"): SchedulerRefusalCase =>
  sched(name, code, `input.scheduled${suffix}`);

/** Fixed named refusal cases; every one must appear as an entry labelled `refusal:<name>`. */
export const WELLBEING_REFUSAL_CASES: readonly SchedulerRefusalCase[] = [
  wbPolicy("policy-null"),
  wbPolicy("policy-wrong-type"),
  wbPolicy("policy-missing-field", ".thirstPerInterval"),
  wbPolicy("policy-extra-field", ".extra"),
  wbPolicy("unknown-version", ".schemaVersion"),
  wbPolicy("policy-without-environment"),
  wbPolicy("thirst-rate-negative", ".thirstPerInterval"),
  wbPolicy("thirst-rate-out-of-range", ".thirstPerInterval"),
  wbPolicy("thirst-rate-non-integer", ".thirstPerInterval"),
  wbPolicy("thirst-rate-wrong-type", ".thirstPerInterval"),
  wbPolicy("loss-out-of-range", ".healthLossPerInterval"),
  wbPolicy("recovery-out-of-range", ".healthRecoveryPerInterval"),
  wbPolicy("urgent-hunger-zero", ".urgentHunger"),
  wbPolicy("urgent-hunger-out-of-range", ".urgentHunger"),
  wbPolicy("urgent-thirst-zero", ".urgentThirst"),
  wbPolicy("critical-health-zero", ".criticalHealth"),
  wbPolicy("critical-health-out-of-range", ".criticalHealth"),
  wbState("state-null"),
  wbState("state-wrong-type"),
  wbState("state-missing-field", ".entries"),
  wbState("state-extra-field", ".extra"),
  wbState("entry-null", ".entries[0]"),
  wbState("entry-missing-field", ".entries[0].health"),
  wbState("entry-extra-field", ".entries[0].extra"),
  wbState("entry-wrong-type", ".entries[0].thirst"),
  wbState("entry-health-out-of-range", ".entries[0].health"),
  wbState("entry-remainder-negative", ".entries[0].thirstRemainder"),
  wbState("entry-remainder-wrong-type", ".entries[0].healthRemainder"),
  wbState("entry-unsupported-comfort", ".entries[0].comfort"),
  wbState("entry-time-wrong-type", ".entries[0].integratedAt"),
  wbState("entries-out-of-order", ".entries[1].objectId"),
  wbDisagrees("state-without-policy", "state.wellbeing"),
  wbDisagrees("policy-without-state", "state.wellbeing"),
  wbDisagrees("entries-count-differs", "state.wellbeing.entries"),
  wbDisagrees("entry-id-differs", "state.wellbeing.entries[0].objectId"),
  wbDisagrees("entry-integrated-at-differs", "state.wellbeing.entries[0].integratedAt"),
  wbDisagrees("entry-thirst-remainder-too-large", "state.wellbeing.entries[0].thirstRemainder"),
  wbDisagrees("entry-health-remainder-too-large", "state.wellbeing.entries[0].healthRemainder"),
  wbDisagrees("entry-comfort-disagrees", "state.wellbeing.entries[0].comfort"),
  wbInvariant("invariant-advance"),
  wbInvariant("invariant-weather-set"),
  wbInvariant("invariant-containment"),
  wbScheduled("scheduled-null"),
  wbScheduled("scheduled-missing-key", ".payload"),
  wbScheduled("scheduled-extra-key", ".extra"),
  wbScheduled("scheduled-unknown-type", ".type", "unknown-command-version"),
  wbScheduled("scheduled-unknown-version", ".schemaVersion", "unknown-command-version"),
  wbScheduled("unknown-schedule", ".scheduleId"),
  wbScheduled("payload-null", ".payload"),
  wbScheduled("payload-extra-key", ".payload.extra"),
  wbScheduled("payload-missing-field", ".payload.objectId"),
  wbScheduled("payload-version", ".payload.schemaVersion"),
  wbScheduled("payload-wrong-object", ".payload.objectId"),
  wbScheduled("foreign-command-id", ".commandId"),
  sched("seed-command-id", "invalid-input", "ids.seed.commandId"),
  sched("continuation", "invalid-input", "continuation"),
  sched("not-first-due", "precondition-failed", "input.scheduled.scheduleId", FIRST_DUE_CHECK),
  sched("unsupported-stimulus", "unsupported-input", "input.kind"),
  sched("scheduled-stale-retry", "invalid-input", "input.scheduled.commandId"),
  sched(
    "scheduled-not-first",
    "precondition-failed",
    "input.scheduled.scheduleId",
    FIRST_DUE_CHECK,
  ),
  sched(
    "scheduled-brought-forward",
    "precondition-failed",
    "input.scheduled.scheduleId",
    FIRST_DUE_CHECK,
  ),
  sched("system-exception", "check-error", "request.systems[0]", "catch-up.system@1"),
  sched("handler-exception", "handler-failed", "handler"),
  sched("reducer-exception", "reducer-failed", "events[6]"),
];

/** Targeted engine calls that Node and Workers must both record (`targeted:<name>:<call index>`). */
const WELLBEING_TARGETED_RUNS = [
  "same-before",
  "same-target",
  "same-through",
  "thirst-through",
  "health-before",
  "health-target",
  "same-tight-8",
  "weather-set-wellbeing-first",
  "scheduled-accepted",
  "scheduled-early-first",
  "scheduled-early-advance",
] as const;

/** Executable schema of the `wellbeing` evidence section; returns every violation (empty = valid). */
export function wellbeingEvidenceProblems(value: unknown, path = "wellbeing"): string[] {
  const problems: string[] = [];
  const bad = (at: string, why: string) => problems.push(`${at}: ${why}`);
  if (!isRecord(value)) return [`${path}: must be a record`];
  if (value.schemaVersion !== 1) bad(`${path}.schemaVersion`, "must be 1");
  if (!isRecord(value.seed) || typeof value.seed.seed !== "string")
    bad(`${path}.seed`, "seed record required");
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    bad(`${path}.entries`, "non-empty array required");
    return problems;
  }
  const labels = new Map<string, Record<string, unknown>>();
  const refusalCodes = new Set<string>();
  const refusalChecks = new Set<string>();
  const eventTypes = new Set<string>();
  const directions = new Set<string>();
  const seen = {
    incomplete: false,
    generated: false,
    success: false,
    earlier: false,
    accepted: false,
  };
  for (const [index, entry] of value.entries.entries()) {
    const at = `${path}.entries[${index}]`;
    if (!isRecord(entry) || typeof entry.label !== "string") {
      bad(at, "label required");
      continue;
    }
    if (labels.has(entry.label)) bad(at, `duplicate label ${entry.label}`);
    if (entry.label.startsWith("generated:")) seen.generated = true;
    const input = entry.input;
    const output = entry.output;
    if (!isRecord(input)) bad(`${at}.input`, "record required");
    else {
      for (const key of ["stimulus", "type", "commandId", "scheduleId"])
        if (input[key] !== null && typeof input[key] !== "string")
          bad(`${at}.input.${key}`, "string or null required");
      if (input.version !== null && !Number.isSafeInteger(input.version))
        bad(`${at}.input.version`, "null or safe integer required");
      if (!ENCODINGS.includes(input.encoding as string))
        bad(`${at}.input.encoding`, "canonical-v1 or malformed-input-v1 required");
      for (const key of ["inputHash", "preStateHash", "schedulesHash", "policyHash"])
        if (!hex(input[key])) bad(`${at}.input.${key}`, "64 lowercase hex characters required");
      if (input.targetTime !== null && !decimal(input.targetTime))
        bad(`${at}.input.targetTime`, "null or decimal time required");
      for (const key of ["maxInputs", "maxEvents"])
        if (input[key] !== null && !Number.isSafeInteger(input[key]))
          bad(`${at}.input.${key}`, "null or safe integer required");
    }
    if (!isRecord(output)) {
      bad(`${at}.output`, "record required");
      continue;
    }
    labels.set(entry.label, output);
    if (output.kind === "success") {
      seen.success = true;
      if (isRecord(input) && input.stimulus === "scheduled" && input.type === "world.decision")
        seen.accepted = true;
      if (!Array.isArray(output.events)) bad(`${at}.output.events`, "array required");
      else {
        let previousTime = -1n;
        let previousRank = -1;
        for (const [position, event] of output.events.entries()) {
          const where = `${at}.output.events[${position}]`;
          if (
            !isRecord(event) ||
            typeof event.type !== "string" ||
            !(event.type in WELLBEING_RANK) ||
            !decimal(event.time) ||
            typeof event.eventId !== "string" ||
            event.eventId.length === 0 ||
            !hex(event.payloadHash) ||
            (event.detail !== null && typeof event.detail !== "string")
          ) {
            bad(
              where,
              "material event type, decimal time, event id, payload hash and detail required",
            );
            continue;
          }
          const time = BigInt(event.time as string);
          const rank = WELLBEING_RANK[event.type] ?? 0;
          if (time < previousTime) bad(where, "events must be in simulation-time order");
          else if (time === previousTime && rank < previousRank)
            bad(
              where,
              "same-time order must be phase, weather, exposure, spoilage, appearance, stage, needs, comfort, health, then decision",
            );
          previousTime = time;
          previousRank = rank;
          eventTypes.add(event.type);
          if (event.type === "health.threshold-crossed" && typeof event.detail === "string")
            directions.add(event.detail);
        }
      }
      if (!strings(output.eventTypes)) bad(`${at}.output.eventTypes`, "event type array required");
      else for (const type of output.eventTypes) eventTypes.add(type);
      if (!Array.isArray(output.upserts)) bad(`${at}.output.upserts`, "array required");
      else
        for (const [position, upsert] of output.upserts.entries()) {
          const where = `${at}.output.upserts[${position}]`;
          if (
            !Array.isArray(upsert) ||
            upsert.length !== 3 ||
            typeof upsert[0] !== "string" ||
            !decimal(upsert[1]) ||
            (upsert[2] !== null && !decimal(upsert[2]))
          ) {
            bad(where, "[schedule id, due time, queued due time or null] required");
            continue;
          }
          if (upsert[2] !== null && BigInt(upsert[1] as string) < BigInt(upsert[2] as string))
            seen.earlier = true;
        }
      if (!hex(output.postStateHash))
        bad(`${at}.output.postStateHash`, "64 lowercase hex characters required");
      if (typeof output.complete !== "boolean") bad(`${at}.output.complete`, "boolean required");
      if (output.continuationHash !== null && !hex(output.continuationHash))
        bad(`${at}.output.continuationHash`, "null or 64 lowercase hex characters required");
      else if ((output.continuationHash === null) !== (output.complete === true))
        bad(
          `${at}.output.continuationHash`,
          "a continuation exists exactly when the call is incomplete",
        );
      if (output.complete === false && hex(output.continuationHash)) seen.incomplete = true;
    } else if (output.kind === "refusal") {
      if (typeof output.code !== "string" || typeof output.path !== "string")
        bad(`${at}.output`, "refusal code and path required");
      else refusalCodes.add(output.code);
      if (output.check !== null && typeof output.check !== "string")
        bad(`${at}.output.check`, "check name or null required");
      else if (typeof output.check === "string") refusalChecks.add(output.check);
    } else bad(`${at}.output.kind`, "success or refusal required");
  }
  if (!seen.success) bad(`${path}.coverage`, "no successful call was recorded");
  for (const type of WELLBEING_EVENT_TYPES)
    if (!eventTypes.has(type)) bad(`${path}.coverage`, `no entry carries ${type}`);
  for (const direction of ["entered", "left"])
    if (!directions.has(direction)) bad(`${path}.coverage`, `no health crossing ${direction}`);
  if (!seen.earlier)
    bad(`${path}.coverage`, "no decision upsert earlier than its queued due time was recorded");
  if (!seen.accepted)
    bad(`${path}.coverage`, "no accepted scheduled world.decision input was recorded");
  if (!seen.incomplete)
    bad(`${path}.coverage`, "no incomplete call with a continuation was recorded");
  if (!seen.generated) bad(`${path}.generated`, "missing generated entries");
  for (const name of WELLBEING_TARGETED_RUNS) {
    const output = labels.get(`targeted:${name}:0`);
    if (output === undefined || output.kind !== "success")
      bad(`${path}.targeted.${name}`, "targeted call must be recorded as a success");
  }
  for (const refusalCase of WELLBEING_REFUSAL_CASES) {
    const output = labels.get(`refusal:${refusalCase.name}`);
    if (output === undefined) {
      bad(`${path}.refusals.${refusalCase.name}`, "missing refusal case");
      continue;
    }
    if (
      output.kind !== "refusal" ||
      output.code !== refusalCase.code ||
      output.path !== refusalCase.path ||
      output.check !== refusalCase.check
    )
      bad(
        `${path}.refusals.${refusalCase.name}`,
        `must refuse with ${refusalCase.code} at ${refusalCase.path} (recorded ${String(output.code)} at ${String(output.path)})`,
      );
  }
  for (const code of new Set(WELLBEING_REFUSAL_CASES.map((item) => item.code)))
    if (!refusalCodes.has(code)) bad(`${path}.refusalCodes`, `missing refusal code ${code}`);
  for (const check of new Set(
    WELLBEING_REFUSAL_CASES.flatMap((item) => (item.check === null ? [] : [item.check])),
  ))
    if (!refusalChecks.has(check)) bad(`${path}.refusalChecks`, `missing refusal check ${check}`);
  if (!Array.isArray(value.pairs)) bad(`${path}.pairs`, "array required");
  else {
    const names = new Map<string, number>();
    for (const [index, pair] of value.pairs.entries()) {
      const at = `${path}.pairs[${index}]`;
      if (!isRecord(pair) || typeof pair.name !== "string") {
        bad(at, "pair name required");
        continue;
      }
      names.set(pair.name, (names.get(pair.name) ?? 0) + 1);
      if (pair.equivalence !== WELLBEING_EQUIVALENCE)
        bad(`${at}.equivalence`, `must declare ${WELLBEING_EQUIVALENCE}`);
      for (const key of ["leftHash", "rightHash"])
        if (!hex(pair[key])) bad(`${at}.${key}`, "64 lowercase hex characters required");
      if (pair.leftHash !== pair.rightHash) bad(at, "pair hashes differ");
    }
    for (const name of WELLBEING_PAIR_NAMES)
      if (names.get(name) !== 1) bad(`${path}.pairs.${name}`, "exactly one entry required");
    for (const name of names.keys())
      if (!(WELLBEING_PAIR_NAMES as readonly string[]).includes(name))
        bad(`${path}.pairs.${name}`, "unknown pair");
  }
  const golden = value.golden;
  if (!isRecord(golden)) bad(`${path}.golden`, "record required");
  else {
    if (golden.name !== WELLBEING_GOLDEN.name)
      bad(`${path}.golden.name`, `must be ${WELLBEING_GOLDEN.name}`);
    for (const key of ["materialEventHash", "finalStateHash"] as const) {
      if (!hex(golden[key])) bad(`${path}.golden.${key}`, "64 lowercase hex characters required");
      else if (golden[key] !== WELLBEING_GOLDEN[key])
        bad(
          `${path}.golden.${key}`,
          `must equal the committed literal (recorded ${String(golden[key])})`,
        );
    }
  }
  return problems;
}

/** Cross-runtime comparison summary of the wellbeing section. */
export function wellbeingComparisonProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["comparison.wellbeing: must be a record"];
  if (value.equal !== true) problems.push("comparison.wellbeing.equal: must be true");
  for (const key of ["nodeHash", "workersHash", "goldenMaterialEventHash", "goldenFinalStateHash"])
    if (!hex(value[key]))
      problems.push(`comparison.wellbeing.${key}: 64 lowercase hex characters required`);
  if (value.nodeHash !== value.workersHash)
    problems.push("comparison.wellbeing: node and workers hashes differ");
  if (value.goldenName !== WELLBEING_GOLDEN.name)
    problems.push("comparison.wellbeing.goldenName: must name the golden");
  if (
    value.goldenMaterialEventHash !== WELLBEING_GOLDEN.materialEventHash ||
    value.goldenFinalStateHash !== WELLBEING_GOLDEN.finalStateHash
  )
    problems.push("comparison.wellbeing: golden hashes must equal the committed literals");
  for (const key of ["entryCount", "refusalCount"])
    if (!Number.isInteger(value[key]) || (value[key] as number) < 1)
      problems.push(`comparison.wellbeing.${key}: positive integer required`);
  if (value.pairCount !== WELLBEING_PAIR_NAMES.length)
    problems.push("comparison.wellbeing.pairCount: must equal the differential pair count");
  return problems;
}

/** Validates the three written report bodies together for the wellbeing section. */
export function wellbeingReportProblems(
  node: unknown,
  workers: unknown,
  comparison: unknown,
): string[] {
  const nodeSection =
    isRecord(node) && isRecord(node.evidence) ? node.evidence.wellbeing : undefined;
  const workersSection =
    isRecord(workers) && isRecord(workers.evidence) ? workers.evidence.wellbeing : undefined;
  const summary = isRecord(comparison) ? comparison.wellbeing : undefined;
  const problems = [
    ...(nodeSection === undefined
      ? ["node.json: wellbeing section missing"]
      : wellbeingEvidenceProblems(nodeSection, "node.wellbeing")),
    ...(workersSection === undefined
      ? ["workers.json: wellbeing section missing"]
      : wellbeingEvidenceProblems(workersSection, "workers.wellbeing")),
    ...wellbeingComparisonProblems(summary),
  ];
  if (
    nodeSection !== undefined &&
    workersSection !== undefined &&
    JSON.stringify(nodeSection) !== JSON.stringify(workersSection)
  )
    problems.push("node and workers wellbeing bodies differ");
  if (isRecord(summary)) {
    const sha = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (nodeSection !== undefined && summary.nodeHash !== sha(nodeSection))
      problems.push("comparison.wellbeing.nodeHash does not match node.json");
    if (workersSection !== undefined && summary.workersHash !== sha(workersSection))
      problems.push("comparison.wellbeing.workersHash does not match workers.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.entries) &&
      summary.entryCount !== nodeSection.entries.length
    )
      problems.push("comparison.wellbeing.entryCount does not match node.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.entries) &&
      summary.refusalCount !==
        nodeSection.entries.filter(
          (entry: unknown) =>
            isRecord(entry) && isRecord(entry.output) && entry.output.kind === "refusal",
        ).length
    )
      problems.push("comparison.wellbeing.refusalCount does not match node.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.pairs) &&
      summary.pairCount !== nodeSection.pairs.length
    )
      problems.push("comparison.wellbeing.pairCount does not match node.json");
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// RW-0108b: utility decisions and movement choice (`decisions` section)
// ---------------------------------------------------------------------------------------------

export const DECISIONS_PAIR_NAMES = WELLBEING_PAIR_NAMES;
export const DECISIONS_EQUIVALENCE = "material-decisions";
export const DECISIONS_EVENT_TYPES = [
  "movement.started",
  "movement.region-entered",
  "movement.region-exited",
  "movement.interrupted",
  "movement.replanned",
  "movement.completed",
  "location.changed",
  "resource.consumed",
  "needs.relieved",
] as const;
const DECISIONS_VERSION = "clockgrove.routine-utility@1";
const PLAN_CHECK = "utility.plan-matches-action@1";
const SELECTED_TIERS = ["utility", "reflex"] as const;
const EXCLUSIONS = [
  "outside-current-space-or-frame",
  "not-perceived",
  "unavailable",
  "no-rain-protection",
  "unreachable",
] as const;

/** Committed literals of the `favorite-snack-house` golden; any change here is a reviewed change. */
export const DECISIONS_GOLDEN = {
  name: "favorite-snack-house",
  materialEventHash: "f5d3895045f6183481893a9447a54e074a62634107a2f5e20f60d1d6fe05c3db",
  traceHash: "f4fd76a538132ee6fc0e90f34a63b614ae2d9ca098370f7f7848a5f80605ca9e",
  finalStateHash: "782d938a93353e05bc0f6784ce26f3b5ee2cbbe5b2365bba0a31b5bf587a7deb",
} as const;

const UT_POLICY = "pack.pack.policy.utility";
const UT_STATE = "partition.state.scriptedCognition";
const utPolicy = (name: string, suffix = ""): SchedulerRefusalCase =>
  sched(name, "invalid-input", `${UT_POLICY}${suffix}`);
const utState = (name: string, suffix = ""): SchedulerRefusalCase =>
  sched(name, "invalid-input", `${UT_STATE}${suffix}`);
const utPlan = (name: string): SchedulerRefusalCase =>
  sched(name, "precondition-failed", "state.entities[0].movement", PLAN_CHECK);
const utInvariant = (name: string): SchedulerRefusalCase =>
  sched(name, "invariant-violated", "state.entities[0].movement", PLAN_CHECK);

/** Fixed named refusal cases; every one must appear as an entry labelled `refusal:<name>`. */
export const DECISIONS_REFUSAL_CASES: readonly SchedulerRefusalCase[] = [
  utPolicy("utility-null"),
  utPolicy("utility-wrong-type"),
  utPolicy("missing-field", ".travelWeight"),
  utPolicy("extra-field", ".extra"),
  utPolicy("unknown-version", ".schemaVersion"),
  utPolicy("unknown-scorer", ".scorer"),
  utPolicy("unknown-scorer-version", ".scorerVersion"),
  utPolicy("utility-without-wellbeing"),
  utPolicy("thirst-weight-out-of-range", ".thirstWeight"),
  utPolicy("expectation-weight-negative", ".expectationWeight"),
  utPolicy("travel-weight-non-integer", ".travelWeight"),
  utPolicy("speed-zero", ".unitsPerSecond"),
  utPolicy("speed-wrong-type", ".unitsPerSecond"),
  utPolicy("range-negative", ".perceptionRange"),
  utPolicy("range-wrong-type", ".perceptionRange"),
  utPolicy("bite-zero", ".biteQuantity"),
  utPolicy("bite-non-integer", ".biteQuantity"),
  utPolicy("hunger-relief-zero", ".hungerReliefPerUnit"),
  utPolicy("hunger-relief-out-of-range", ".hungerReliefPerUnit"),
  utPolicy("thirst-relief-zero", ".thirstReliefPerUnit"),
  utPolicy("thirst-relief-out-of-range", ".thirstReliefPerUnit"),
  utPolicy("ambiguity-null", ".ambiguity"),
  utPolicy("ambiguity-unknown-version", ".ambiguity.schemaVersion"),
  utPolicy("ambiguity-no-conditions", ".ambiguity.conditions"),
  utPolicy("ambiguity-unknown-condition", ".ambiguity.conditions[0].kind"),
  utPolicy("ambiguity-out-of-order", ".ambiguity.conditions[1].kind"),
  utPolicy("ambiguity-duplicate", ".ambiguity.conditions[1].kind"),
  utPolicy("ambiguity-margin-negative", ".ambiguity.conditions[0].maxMargin"),
  utPolicy("ambiguity-margin-wrong-type", ".ambiguity.conditions[0].maxMargin"),
  utPolicy("ambiguity-condition-extra-field", ".ambiguity.conditions[0].maxMargin"),
  utState("state-null"),
  utState("state-wrong-type"),
  utState("state-missing-field", ".entries"),
  utState("state-extra-field", ".extra"),
  utState("state-unknown-version", ".schemaVersion"),
  utState("source-not-scripted", ".source"),
  utState("entries-wrong-type", ".entries"),
  utState("entries-over-bound", ".entries"),
  utState("entry-null", ".entries[0]"),
  utState("entry-missing-field", ".entries[0].value"),
  utState("entry-extra-field", ".entries[0].extra"),
  utState("entry-ref-prefix", ".entries[0].ref"),
  utState("entries-out-of-order", ".entries[1].ref"),
  utState("entries-duplicate-ref", ".entries[1].ref"),
  utState("entry-kind-unsupported", ".entries[0].kind"),
  utState("entry-actor-wrong-type", ".entries[0].actorId"),
  utState("entry-value-out-of-range", ".entries[0].value"),
  utState("entry-effective-at-negative", ".entries[0].effectiveAt"),
  utState("entry-effective-at-wrong-type", ".entries[0].effectiveAt"),
  utState("state-without-policy"),
  utState("entry-actor-unknown", ".entries[0].actorId"),
  utState("entry-actor-not-needs", ".entries[0].actorId"),
  utState("entry-target-unknown", ".entries[0].targetObjectId"),
  utState("entry-target-not-seekable", ".entries[0].targetObjectId"),
  utPlan("plan-mismatch"),
  utInvariant("invariant-advance"),
  utInvariant("invariant-weather-set"),
  utInvariant("invariant-containment"),
  wbScheduled("scheduled-null"),
  wbScheduled("scheduled-missing-key", ".payload"),
  wbScheduled("scheduled-extra-key", ".extra"),
  wbScheduled("scheduled-unknown-type", ".type", "unknown-command-version"),
  wbScheduled("scheduled-unknown-version", ".schemaVersion", "unknown-command-version"),
  wbScheduled("unknown-schedule", ".scheduleId"),
  wbScheduled("payload-null", ".payload"),
  wbScheduled("payload-extra-key", ".payload.extra"),
  wbScheduled("payload-missing-field", ".payload.objectId"),
  wbScheduled("payload-version", ".payload.schemaVersion"),
  wbScheduled("payload-wrong-object", ".payload.objectId"),
  wbScheduled("foreign-command-id", ".commandId"),
  sched("seed-command-id", "invalid-input", "ids.seed.commandId"),
  sched("continuation", "invalid-input", "continuation"),
  sched("not-first-due", "precondition-failed", "input.scheduled.scheduleId", FIRST_DUE_CHECK),
  sched("unsupported-stimulus", "unsupported-input", "input.kind"),
  sched("scheduled-stale-retry", "invalid-input", "input.scheduled.commandId"),
  sched(
    "scheduled-not-first",
    "precondition-failed",
    "input.scheduled.scheduleId",
    FIRST_DUE_CHECK,
  ),
  sched(
    "scheduled-brought-forward",
    "precondition-failed",
    "input.scheduled.scheduleId",
    FIRST_DUE_CHECK,
  ),
  sched("system-exception", "check-error", "request.systems[0]", "catch-up.system@1"),
  sched("handler-exception", "handler-failed", "handler"),
  sched("reducer-exception", "reducer-failed", "events[10]"),
];

/** Targeted engine calls that Node and Workers must both record (`targeted:<name>:0`). */
const DECISIONS_TARGETED_RUNS = [
  "seek-food",
  "seek-water",
  "seek-shelter",
  "stay",
  "immediate",
  "emptied-before-arrival",
  "continued",
  "replan",
  "interrupt",
  "leave-shelter",
  "shelter-exposure",
  "shelter-absent",
  "region",
  "scripted-timing",
  "reflex",
  "scheduled-seek",
  "exclusions",
  "seek-food-tight",
] as const;

/** Executable schema of the `decisions` evidence section; returns every violation (empty = valid). */
export function decisionsEvidenceProblems(value: unknown, path = "decisions"): string[] {
  const problems: string[] = [];
  const bad = (at: string, why: string) => problems.push(`${at}: ${why}`);
  if (!isRecord(value)) return [`${path}: must be a record`];
  for (const key of Object.keys(value))
    if (!["schemaVersion", "seed", "entries", "pairs", "golden", "traces"].includes(key))
      bad(`${path}.${key}`, "unexpected field");
  if (value.schemaVersion !== 1) bad(`${path}.schemaVersion`, "must be 1");
  if (!isRecord(value.seed) || typeof value.seed.seed !== "string")
    bad(`${path}.seed`, "seed record required");
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    bad(`${path}.entries`, "non-empty array required");
    return problems;
  }
  const labels = new Map<string, Record<string, unknown>>();
  const refusalCodes = new Set<string>();
  const refusalChecks = new Set<string>();
  const eventTypes = new Set<string>();
  const tiers = new Set<string>();
  const actions = new Set<string>();
  const seen = {
    incomplete: false,
    generated: false,
    success: false,
    golden: false,
    control: false,
    withLinks: false,
    accepted: false,
  };
  const reasonsSeen = new Set<string>();
  const traceHashes = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    const at = `${path}.entries[${index}]`;
    if (!isRecord(entry) || typeof entry.label !== "string") {
      bad(at, "label required");
      continue;
    }
    if (labels.has(entry.label)) bad(at, `duplicate label ${entry.label}`);
    if (entry.label.startsWith("generated:")) seen.generated = true;
    if (entry.label.startsWith("case:snack-scheduled-")) seen.golden = true;
    if (entry.label.startsWith("case:snack-control-")) seen.control = true;
    const input = entry.input;
    const output = entry.output;
    if (!isRecord(input)) bad(`${at}.input`, "record required");
    else {
      for (const key of ["stimulus", "type", "commandId", "scheduleId"])
        if (input[key] !== null && typeof input[key] !== "string")
          bad(`${at}.input.${key}`, "string or null required");
      if (input.version !== null && !Number.isSafeInteger(input.version))
        bad(`${at}.input.version`, "null or safe integer required");
      if (!ENCODINGS.includes(input.encoding as string))
        bad(`${at}.input.encoding`, "canonical-v1 or malformed-input-v1 required");
      for (const key of ["inputHash", "preStateHash", "schedulesHash", "policyHash"])
        if (!hex(input[key])) bad(`${at}.input.${key}`, "64 lowercase hex characters required");
      if (input.targetTime !== null && !decimal(input.targetTime))
        bad(`${at}.input.targetTime`, "null or decimal time required");
      for (const key of ["maxInputs", "maxEvents"])
        if (input[key] !== null && !Number.isSafeInteger(input[key]))
          bad(`${at}.input.${key}`, "null or safe integer required");
    }
    if (!isRecord(output)) {
      bad(`${at}.output`, "record required");
      continue;
    }
    labels.set(entry.label, output);
    if (!Array.isArray(entry.decisions)) bad(`${at}.decisions`, "array required");
    else
      for (const [position, decision] of entry.decisions.entries()) {
        const where = `${at}.decisions[${position}]`;
        if (output.kind !== "success") {
          bad(where, "a refusal records no decisions");
          continue;
        }
        if (
          !isRecord(decision) ||
          typeof decision.objectId !== "string" ||
          !decimal(decision.time) ||
          typeof decision.policyVersion !== "string" ||
          !decision.policyVersion.endsWith(`/${DECISIONS_VERSION}`) ||
          !(SELECTED_TIERS as readonly string[]).includes(decision.tier as string) ||
          !isRecord(decision.action) ||
          typeof decision.action.kind !== "string" ||
          (decision.action.targetObjectId !== null &&
            typeof decision.action.targetObjectId !== "string") ||
          !Number.isSafeInteger(decision.candidateCount) ||
          !Number.isSafeInteger(decision.excludedCount) ||
          (decision.excludedCount as number) >= (decision.candidateCount as number) ||
          !strings(decision.outcomeLinks) ||
          !strings(decision.exclusionReasons) ||
          (decision.exclusionReasons as string[]).length > (decision.excludedCount as number) ||
          (decision.exclusionReasons as string[]).some(
            (reason) => !(EXCLUSIONS as readonly string[]).includes(reason),
          ) ||
          (decision.excludedCount as number) > 0 !==
            (decision.exclusionReasons as string[]).length > 0 ||
          !hex(decision.traceHash)
        ) {
          bad(
            where,
            "decision with object, time, versioned policy, tier, action, counts, exclusion reasons, outcome links and trace hash required",
          );
          continue;
        }
        for (const reason of decision.exclusionReasons as string[]) reasonsSeen.add(reason);
        tiers.add(decision.tier as string);
        actions.add(String((decision.action as Record<string, unknown>).kind));
        traceHashes.add(decision.traceHash as string);
        if ((decision.outcomeLinks as string[]).length > 0) seen.withLinks = true;
      }
    if (output.kind === "success") {
      seen.success = true;
      if (isRecord(input) && input.stimulus === "scheduled" && input.type === "world.decision")
        seen.accepted = true;
      if (!Array.isArray(output.events)) bad(`${at}.output.events`, "array required");
      else {
        let previousTime = -1n;
        for (const [position, event] of output.events.entries()) {
          const where = `${at}.output.events[${position}]`;
          if (
            !isRecord(event) ||
            typeof event.type !== "string" ||
            !(event.type in WELLBEING_RANK) ||
            !decimal(event.time) ||
            typeof event.eventId !== "string" ||
            event.eventId.length === 0 ||
            !hex(event.payloadHash) ||
            (event.detail !== null && typeof event.detail !== "string")
          ) {
            bad(
              where,
              "material event type, decimal time, event id, payload hash and detail required",
            );
            continue;
          }
          const time = BigInt(event.time as string);
          if (time < previousTime) bad(where, "events must be in simulation-time order");
          previousTime = time;
        }
      }
      if (!strings(output.eventTypes)) bad(`${at}.output.eventTypes`, "event type array required");
      else for (const type of output.eventTypes) eventTypes.add(type);
      if (!Array.isArray(output.upserts)) bad(`${at}.output.upserts`, "array required");
      if (!hex(output.postStateHash))
        bad(`${at}.output.postStateHash`, "64 lowercase hex characters required");
      if (typeof output.complete !== "boolean") bad(`${at}.output.complete`, "boolean required");
      if (output.continuationHash !== null && !hex(output.continuationHash))
        bad(`${at}.output.continuationHash`, "null or 64 lowercase hex characters required");
      else if ((output.continuationHash === null) !== (output.complete === true))
        bad(
          `${at}.output.continuationHash`,
          "a continuation exists exactly when the call is incomplete",
        );
      if (output.complete === false && hex(output.continuationHash)) seen.incomplete = true;
    } else if (output.kind === "refusal") {
      if (typeof output.code !== "string" || typeof output.path !== "string")
        bad(`${at}.output`, "refusal code and path required");
      else refusalCodes.add(output.code);
      if (output.check !== null && typeof output.check !== "string")
        bad(`${at}.output.check`, "check name or null required");
      else if (typeof output.check === "string") refusalChecks.add(output.check);
    } else bad(`${at}.output.kind`, "success or refusal required");
  }
  if (!seen.success) bad(`${path}.coverage`, "no successful call was recorded");
  for (const type of DECISIONS_EVENT_TYPES)
    if (!eventTypes.has(type)) bad(`${path}.coverage`, `no entry carries ${type}`);
  for (const tier of SELECTED_TIERS)
    if (!tiers.has(tier)) bad(`${path}.coverage`, `no decision with tier ${tier}`);
  for (const kind of ["stay", "seek-food", "seek-water", "seek-shelter"])
    if (!actions.has(kind)) bad(`${path}.coverage`, `no decision selects ${kind}`);
  for (const reason of EXCLUSIONS)
    if (!reasonsSeen.has(reason))
      bad(`${path}.coverage`, `no decision excludes a candidate as ${reason}`);
  if (!seen.accepted)
    bad(`${path}.coverage`, "no accepted scheduled world.decision input was recorded");
  if (!seen.withLinks) bad(`${path}.coverage`, "no decision records outcome links");
  if (!seen.incomplete)
    bad(`${path}.coverage`, "no incomplete call with a continuation was recorded");
  if (!seen.generated) bad(`${path}.generated`, "missing generated entries");
  if (!seen.golden) bad(`${path}.golden`, "missing the scheduled golden entries");
  if (!seen.control) bad(`${path}.golden`, "missing the control entries");
  for (const name of DECISIONS_TARGETED_RUNS) {
    const output = labels.get(`targeted:${name}:0`);
    if (output === undefined || output.kind !== "success")
      bad(`${path}.targeted.${name}`, "targeted call must be recorded as a success");
  }
  for (const refusalCase of DECISIONS_REFUSAL_CASES) {
    const output = labels.get(`refusal:${refusalCase.name}`);
    if (output === undefined) {
      bad(`${path}.refusals.${refusalCase.name}`, "missing refusal case");
      continue;
    }
    if (
      output.kind !== "refusal" ||
      output.code !== refusalCase.code ||
      output.path !== refusalCase.path ||
      output.check !== refusalCase.check
    )
      bad(
        `${path}.refusals.${refusalCase.name}`,
        `must refuse with ${refusalCase.code} at ${refusalCase.path} (recorded ${String(output.code)} at ${String(output.path)})`,
      );
  }
  for (const code of new Set(DECISIONS_REFUSAL_CASES.map((item) => item.code)))
    if (!refusalCodes.has(code)) bad(`${path}.refusalCodes`, `missing refusal code ${code}`);
  for (const check of new Set(
    DECISIONS_REFUSAL_CASES.flatMap((item) => (item.check === null ? [] : [item.check])),
  ))
    if (!refusalChecks.has(check)) bad(`${path}.refusalChecks`, `missing refusal check ${check}`);
  if (!Array.isArray(value.pairs)) bad(`${path}.pairs`, "array required");
  else {
    const names = new Map<string, number>();
    for (const [index, pair] of value.pairs.entries()) {
      const at = `${path}.pairs[${index}]`;
      if (!isRecord(pair) || typeof pair.name !== "string") {
        bad(at, "pair name required");
        continue;
      }
      names.set(pair.name, (names.get(pair.name) ?? 0) + 1);
      if (pair.equivalence !== DECISIONS_EQUIVALENCE)
        bad(`${at}.equivalence`, `must declare ${DECISIONS_EQUIVALENCE}`);
      for (const key of ["leftHash", "rightHash"])
        if (!hex(pair[key])) bad(`${at}.${key}`, "64 lowercase hex characters required");
      if (pair.leftHash !== pair.rightHash) bad(at, "pair hashes differ");
    }
    for (const name of DECISIONS_PAIR_NAMES)
      if (names.get(name) !== 1) bad(`${path}.pairs.${name}`, "exactly one entry required");
    for (const name of names.keys())
      if (!(DECISIONS_PAIR_NAMES as readonly string[]).includes(name))
        bad(`${path}.pairs.${name}`, "unknown pair");
  }
  const golden = value.golden;
  if (!isRecord(golden)) bad(`${path}.golden`, "record required");
  else {
    if (golden.name !== DECISIONS_GOLDEN.name)
      bad(`${path}.golden.name`, `must be ${DECISIONS_GOLDEN.name}`);
    for (const key of ["materialEventHash", "traceHash", "finalStateHash"] as const) {
      if (!hex(golden[key])) bad(`${path}.golden.${key}`, "64 lowercase hex characters required");
      else if (golden[key] !== DECISIONS_GOLDEN[key])
        bad(
          `${path}.golden.${key}`,
          `must equal the committed literal (recorded ${String(golden[key])})`,
        );
    }
  }
  if (!Array.isArray(value.traces) || value.traces.length === 0)
    bad(`${path}.traces`, "non-empty array of full traces required");
  else {
    let hasExpectation = false;
    let hasAllRefs = false;
    for (const [index, trace] of value.traces.entries()) {
      const at = `${path}.traces[${index}]`;
      if (
        !isRecord(trace) ||
        typeof trace.policyVersion !== "string" ||
        !trace.policyVersion.endsWith(`/${DECISIONS_VERSION}`) ||
        !Array.isArray(trace.candidates) ||
        trace.candidates.length === 0 ||
        !Array.isArray(trace.randomDraws) ||
        trace.randomDraws.length !== 0 ||
        !strings(trace.perceptionRefs) ||
        !strings(trace.beliefRefs) ||
        !strings(trace.memoryRefs) ||
        !strings(trace.outcomeLinks)
      ) {
        bad(at, "full versioned trace with candidates, empty random draws and ref lists required");
        continue;
      }
      if (
        (trace.perceptionRefs as string[]).length > 0 &&
        (trace.beliefRefs as string[]).length > 0 &&
        (trace.memoryRefs as string[]).length > 0
      )
        hasAllRefs = true;
      for (const candidate of trace.candidates as unknown[])
        if (
          isRecord(candidate) &&
          isRecord(candidate.features) &&
          typeof candidate.features.expectation === "string" &&
          candidate.features.expectation !== "0"
        )
          hasExpectation = true;
      if (
        (trace.beliefRefs as string[]).length + (trace.memoryRefs as string[]).length > 0 &&
        !hasExpectation
      )
        bad(at, "a trace with scripted refs must carry an expectation feature");
      if (
        trace.candidates.some(
          (c: unknown) =>
            isRecord(c) &&
            typeof c.excludedReason === "string" &&
            !(EXCLUSIONS as readonly string[]).includes(c.excludedReason),
        )
      )
        bad(at, "unknown exclusion reason");
    }
    if (traceHashes.size === 0) bad(`${path}.traces`, "no decision hashes recorded");
    if (!hasExpectation) bad(`${path}.traces`, "no golden trace carries a nonzero expectation");
    if (!hasAllRefs)
      bad(`${path}.traces`, "no golden trace carries perception, belief and memory refs");
  }
  return problems;
}

/** Cross-runtime comparison summary of the decisions section. */
export function decisionsComparisonProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["comparison.decisions: must be a record"];
  if (value.equal !== true) problems.push("comparison.decisions.equal: must be true");
  for (const key of [
    "nodeHash",
    "workersHash",
    "goldenMaterialEventHash",
    "goldenTraceHash",
    "goldenFinalStateHash",
  ])
    if (!hex(value[key]))
      problems.push(`comparison.decisions.${key}: 64 lowercase hex characters required`);
  if (value.nodeHash !== value.workersHash)
    problems.push("comparison.decisions: node and workers hashes differ");
  if (value.goldenName !== DECISIONS_GOLDEN.name)
    problems.push("comparison.decisions.goldenName: must name the golden");
  if (
    value.goldenMaterialEventHash !== DECISIONS_GOLDEN.materialEventHash ||
    value.goldenTraceHash !== DECISIONS_GOLDEN.traceHash ||
    value.goldenFinalStateHash !== DECISIONS_GOLDEN.finalStateHash
  )
    problems.push("comparison.decisions: golden hashes must equal the committed literals");
  for (const key of ["entryCount", "refusalCount"])
    if (!Number.isInteger(value[key]) || (value[key] as number) < 1)
      problems.push(`comparison.decisions.${key}: positive integer required`);
  if (value.pairCount !== DECISIONS_PAIR_NAMES.length)
    problems.push("comparison.decisions.pairCount: must equal the differential pair count");
  return problems;
}

/** Validates the three written report bodies together for the decisions section. */
export function decisionsReportProblems(
  node: unknown,
  workers: unknown,
  comparison: unknown,
): string[] {
  const nodeSection =
    isRecord(node) && isRecord(node.evidence) ? node.evidence.decisions : undefined;
  const workersSection =
    isRecord(workers) && isRecord(workers.evidence) ? workers.evidence.decisions : undefined;
  const summary = isRecord(comparison) ? comparison.decisions : undefined;
  const problems = [
    ...(nodeSection === undefined
      ? ["node.json: decisions section missing"]
      : decisionsEvidenceProblems(nodeSection, "node.decisions")),
    ...(workersSection === undefined
      ? ["workers.json: decisions section missing"]
      : decisionsEvidenceProblems(workersSection, "workers.decisions")),
    ...decisionsComparisonProblems(summary),
  ];
  if (
    nodeSection !== undefined &&
    workersSection !== undefined &&
    JSON.stringify(nodeSection) !== JSON.stringify(workersSection)
  )
    problems.push("node and workers decisions bodies differ");
  if (isRecord(summary)) {
    const sha = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (nodeSection !== undefined && summary.nodeHash !== sha(nodeSection))
      problems.push("comparison.decisions.nodeHash does not match node.json");
    if (workersSection !== undefined && summary.workersHash !== sha(workersSection))
      problems.push("comparison.decisions.workersHash does not match workers.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.entries) &&
      summary.entryCount !== nodeSection.entries.length
    )
      problems.push("comparison.decisions.entryCount does not match node.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.entries) &&
      summary.refusalCount !==
        nodeSection.entries.filter(
          (entry: unknown) =>
            isRecord(entry) && isRecord(entry.output) && entry.output.kind === "refusal",
        ).length
    )
      problems.push("comparison.decisions.refusalCount does not match node.json");
    if (
      isRecord(nodeSection) &&
      Array.isArray(nodeSection.pairs) &&
      summary.pairCount !== nodeSection.pairs.length
    )
      problems.push("comparison.decisions.pairCount does not match node.json");
    if (isRecord(nodeSection) && isRecord(nodeSection.golden)) {
      if (summary.goldenMaterialEventHash !== nodeSection.golden.materialEventHash)
        problems.push("comparison.decisions.goldenMaterialEventHash does not match node.json");
      if (summary.goldenTraceHash !== nodeSection.golden.traceHash)
        problems.push("comparison.decisions.goldenTraceHash does not match node.json");
      if (summary.goldenFinalStateHash !== nodeSection.golden.finalStateHash)
        problems.push("comparison.decisions.goldenFinalStateHash does not match node.json");
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Whole report-directory check. Each section lives in its own bounded file; this validates the
// directory listing plus every parsed body, reusing the per-section report checks on adapters.
// ---------------------------------------------------------------------------------------------

export const REPORT_SECTION_FILES = [
  "spatial",
  "perception",
  "scheduler",
  "environment",
  "ecology",
  "decisions",
  "lifecycle",
] as const;
export const REPORT_FILE_NAMES = [
  "node.json",
  "workers.json",
  "comparison.json",
  ...REPORT_SECTION_FILES.map((name) => `${name}.json`),
  "wellbeing-node.json",
  "wellbeing-workers.json",
] as const;
const RUNTIME_EVIDENCE_KEYS = [
  "schemaVersion",
  "composition",
  "components",
  "historical",
  "packs",
  "executor",
  "containment",
];
const COMPARISON_KEYS = [
  "schemaVersion",
  "node",
  "workers",
  "wrangler",
  "miniflare",
  "nativeRuntimeVersion",
  "canonicalBytesEqual",
  "nodeHash",
  "workersHash",
  "comparisons",
  "packComparisons",
  "containment",
  "executor",
  "wellbeing",
];

const SECTION_REPORT_CHECKS: Record<
  (typeof REPORT_SECTION_FILES)[number],
  (node: unknown, workers: unknown, comparison: unknown) => string[]
> = {
  spatial: spatialReportProblems,
  perception: perceptionReportProblems,
  scheduler: schedulerReportProblems,
  environment: environmentReportProblems,
  ecology: ecologyReportProblems,
  decisions: decisionsReportProblems,
  lifecycle: lifecycleReportProblems,
};

function exactKeys(value: unknown, keys: readonly string[], at: string): string[] {
  if (!isRecord(value)) return [`${at}: must be a record`];
  const problems: string[] = [];
  for (const key of keys) if (!(key in value)) problems.push(`${at}: missing field ${key}`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) problems.push(`${at}: unexpected field ${key}`);
  return problems;
}

/**
 * Validates a whole written report directory: `listing` is the directory's file names (readdir) and
 * `files` maps each name to its parsed JSON body. Returns every violation (empty = valid).
 */
export function reportDirectoryProblems(
  listing: readonly string[],
  files: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = [];
  const sha = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const names: readonly string[] = REPORT_FILE_NAMES;
  for (const name of names)
    if (!listing.includes(name)) problems.push(`${name}: file missing from the report directory`);
  for (const name of listing)
    if (!names.includes(name)) problems.push(`${name}: unexpected file in the report directory`);
  if (new Set(listing).size !== listing.length)
    problems.push("report directory: duplicate listing entries");
  for (const name of names)
    if (listing.includes(name) && !(name in files))
      problems.push(`${name}: no parsed body supplied`);
  const get = (name: string): unknown => (listing.includes(name) ? files[name] : undefined);

  const node = get("node.json");
  const workers = get("workers.json");
  const comparison = get("comparison.json");
  if (node !== undefined) problems.push(...exactKeys(node, ["runtime", "evidence"], "node.json"));
  if (workers !== undefined)
    problems.push(...exactKeys(workers, ["runtime", "evidence"], "workers.json"));
  if (comparison !== undefined)
    problems.push(...exactKeys(comparison, COMPARISON_KEYS, "comparison.json"));
  const nodeEvidence = isRecord(node) ? node.evidence : undefined;
  const workersEvidence = isRecord(workers) ? workers.evidence : undefined;
  if (isRecord(node) && typeof node.runtime !== "string")
    problems.push("node.json.runtime: string required");
  if (isRecord(workers) && typeof workers.runtime !== "string")
    problems.push("workers.json.runtime: string required");
  if (isRecord(node))
    problems.push(...exactKeys(nodeEvidence, RUNTIME_EVIDENCE_KEYS, "node.json.evidence"));
  if (isRecord(workers))
    problems.push(...exactKeys(workersEvidence, RUNTIME_EVIDENCE_KEYS, "workers.json.evidence"));
  if (isRecord(nodeEvidence) && isRecord(workersEvidence)) {
    for (const key of RUNTIME_EVIDENCE_KEYS) {
      if (
        key in nodeEvidence &&
        key in workersEvidence &&
        JSON.stringify(nodeEvidence[key]) !== JSON.stringify(workersEvidence[key])
      )
        problems.push(`node and workers ${key} bodies differ`);
    }
  }
  if (isRecord(comparison)) {
    if (comparison.schemaVersion !== 1) problems.push("comparison.json.schemaVersion: must be 1");
    for (const key of ["nodeHash", "workersHash"])
      if (!hex(comparison[key]))
        problems.push(`comparison.json.${key}: 64 lowercase hex characters required`);
    for (const key of ["executor", "containment"] as const) {
      const summary = comparison[key];
      if (!isRecord(summary)) {
        problems.push(`comparison.${key}: must be a record`);
        continue;
      }
      if (summary.equal !== true) problems.push(`comparison.${key}.equal: must be true`);
      if (
        isRecord(nodeEvidence) &&
        key in nodeEvidence &&
        summary.nodeHash !== sha(nodeEvidence[key])
      )
        problems.push(`comparison.${key}.nodeHash does not match node.json`);
      if (
        isRecord(workersEvidence) &&
        key in workersEvidence &&
        summary.workersHash !== sha(workersEvidence[key])
      )
        problems.push(`comparison.${key}.workersHash does not match workers.json`);
    }
  }

  for (const section of REPORT_SECTION_FILES) {
    const file = get(`${section}.json`);
    if (file === undefined) continue;
    const at = `${section}.json`;
    problems.push(
      ...exactKeys(file, ["schemaVersion", "section", "node", "workers", "comparison"], at),
    );
    if (!isRecord(file)) continue;
    if (file.schemaVersion !== 1) problems.push(`${at}.schemaVersion: must be 1`);
    if (file.section !== section) problems.push(`${at}.section: must be ${section}`);
    problems.push(...exactKeys(file.node, ["runtime", "evidence"], `${at}.node`));
    problems.push(...exactKeys(file.workers, ["runtime", "evidence"], `${at}.workers`));
    if (isRecord(file.node) && isRecord(node) && file.node.runtime !== node.runtime)
      problems.push(`${at}.node.runtime does not match node.json`);
    if (isRecord(file.workers) && isRecord(workers) && file.workers.runtime !== workers.runtime)
      problems.push(`${at}.workers.runtime does not match workers.json`);
    problems.push(
      ...SECTION_REPORT_CHECKS[section](
        { evidence: { [section]: isRecord(file.node) ? file.node.evidence : undefined } },
        { evidence: { [section]: isRecord(file.workers) ? file.workers.evidence : undefined } },
        { [section]: file.comparison },
      ),
    );
  }

  const wellbeingNode = get("wellbeing-node.json");
  const wellbeingWorkers = get("wellbeing-workers.json");
  for (const [at, file, runtime] of [
    ["wellbeing-node.json", wellbeingNode, isRecord(node) ? node.runtime : undefined],
    ["wellbeing-workers.json", wellbeingWorkers, isRecord(workers) ? workers.runtime : undefined],
  ] as const) {
    if (file === undefined) continue;
    problems.push(...exactKeys(file, ["schemaVersion", "section", "runtime", "evidence"], at));
    if (!isRecord(file)) continue;
    if (file.schemaVersion !== 1) problems.push(`${at}.schemaVersion: must be 1`);
    if (file.section !== "wellbeing") problems.push(`${at}.section: must be wellbeing`);
    if (file.runtime !== runtime) problems.push(`${at}.runtime does not match its runtime file`);
  }
  if (wellbeingNode !== undefined || wellbeingWorkers !== undefined) {
    problems.push(
      ...wellbeingReportProblems(
        { evidence: { wellbeing: isRecord(wellbeingNode) ? wellbeingNode.evidence : undefined } },
        {
          evidence: {
            wellbeing: isRecord(wellbeingWorkers) ? wellbeingWorkers.evidence : undefined,
          },
        },
        { wellbeing: isRecord(comparison) ? comparison.wellbeing : undefined },
      ),
    );
  }
  return problems;
}
