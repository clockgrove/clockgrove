import { PERCEPTION_MODALITIES, worldRegistryIdentity } from "@clockgrove/kernel";
import { clonePlain, isOneOf, isRecord, type PathSegment, type Rec, refuse } from "./support.js";

export const SCENARIO_KIND = "clockgrove.scenario";
export const SCENARIO_SCHEMA_VERSION = 1;
/** The name of the scenario's own step plan among the runs of a bundle. */
export const MAIN_RUN = "main";

/** Documented bounds; exceeding one is a `SCENARIO_BOUND_EXCEEDED` refusal. */
export const SCENARIO_LIMITS = Object.freeze({
  steps: 256,
  variants: 8,
  equivalences: 16,
  assertions: 64,
  chunksPerAdvance: 4096,
  maxBudget: 100_000,
  dataDepth: 32,
});

export const EQUIVALENCE_FIELDS = [
  "events",
  "eventCounts",
  "finalState",
  "decisions",
  "rules",
] as const;
export type EquivalenceField = (typeof EQUIVALENCE_FIELDS)[number];
/** `full` records every event and record; `summarised` keeps memory bounded over long horizons. */
export const RECORDING_MODES = ["full", "summarised"] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];
export const COMPARE_OPERATORS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;
export type CompareOperator = (typeof COMPARE_OPERATORS)[number];

/** The actor and capability binding (`id@version` in the document) a command is submitted through. */
export interface CapabilityVia {
  readonly actor: string;
  readonly capability: { readonly id: string; readonly version: number };
}
export interface CommandStep {
  readonly kind: "command";
  readonly key: string;
  readonly type: string;
  readonly version: number;
  readonly payload: Rec;
  /** Present only when the document sets it, so steps without it decode unchanged. */
  readonly via?: CapabilityVia;
}
export interface AdvanceStep {
  readonly kind: "advance";
  readonly key: string;
  readonly to: bigint;
  readonly mode: "live" | "fast-forward";
  readonly stepMs: bigint | null;
  readonly maxInputs: number;
  readonly maxEvents: number;
}
export interface RetryStep {
  readonly kind: "retry";
  readonly key: string;
  readonly of: string;
}
export interface RestartStep {
  readonly kind: "restart";
  readonly key: string;
}
export type ScenarioStep = CommandStep | AdvanceStep | RetryStep | RestartStep;

export interface ScenarioVariant {
  readonly name: string;
  readonly steps: readonly ScenarioStep[];
}
export interface ScenarioEquivalence {
  readonly id: string;
  readonly left: string;
  readonly right: string;
  readonly fields: readonly EquivalenceField[];
  /** When non-empty, only these event types are compared. */
  readonly eventTypes: readonly string[];
  readonly ignoreEventTypes: readonly string[];
  readonly ignoreStatePaths: readonly (readonly (string | number)[])[];
}
export interface PathAssertion {
  readonly kind: "path";
  readonly id: string;
  readonly run: string;
  readonly path: readonly PathSegment[];
  readonly operator: CompareOperator;
  readonly value: unknown;
}
export interface EventCountAssertion {
  readonly kind: "eventCount";
  readonly id: string;
  readonly run: string;
  readonly eventType: string | null;
  readonly from: bigint | null;
  readonly to: bigint | null;
  readonly where: readonly { readonly path: readonly PathSegment[]; readonly value: unknown }[];
  readonly operator: CompareOperator;
  readonly value: number;
}
export interface EquivalenceAssertion {
  readonly kind: "equivalence";
  readonly id: string;
  readonly equivalence: string;
  readonly expect: boolean;
}
export type ScenarioAssertion = PathAssertion | EventCountAssertion | EquivalenceAssertion;

export interface ScenarioPerception {
  readonly policy: Rec;
  readonly modality: string;
  readonly modalities: Readonly<Record<string, string>>;
}

export interface ScenarioDocument {
  readonly kind: typeof SCENARIO_KIND;
  readonly schemaVersion: 1;
  readonly name: string;
  readonly pack: { readonly id: string; readonly version: string };
  readonly steps: readonly ScenarioStep[];
  readonly variants: readonly ScenarioVariant[];
  readonly equivalences: readonly ScenarioEquivalence[];
  readonly perception: ScenarioPerception | null;
  readonly assertions: readonly ScenarioAssertion[];
  /** Present only when the document sets it, so documents without it decode unchanged. */
  readonly recording?: RecordingMode;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
/** A capability binding `id@version`; the decoder bounds the version to 1..1000000 like a step's. */
const BINDING = /^(\S{1,256})@([1-9][0-9]{0,6})$/u;

function exact(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Rec {
  if (!isRecord(value)) return refuse("MALFORMED_INPUT", path, "must be a record");
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      refuse("UNKNOWN_FIELD", `${path}.${key}`, "unknown field");
  for (const key of required)
    if (!Object.hasOwn(value, key)) refuse("MISSING_FIELD", `${path}.${key}`, "missing field");
  return value;
}

function text(value: unknown, path: string, max = 128): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value
  )
    return refuse(
      "MALFORMED_INPUT",
      path,
      `must be a non-empty trimmed string of at most ${max} characters`,
    );
  return value;
}

function key(value: unknown, path: string, code = "MALFORMED_INPUT"): string {
  if (typeof value !== "string" || !KEY.test(value))
    return refuse(code, path, "must be 1-64 characters of letters, digits and . _ : -");
  return value;
}

function list(value: unknown, path: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) return refuse("MALFORMED_INPUT", path, "must be an array");
  if (value.length > max)
    return refuse("SCENARIO_BOUND_EXCEEDED", path, `at most ${max} entries are allowed`);
  return value;
}

function int(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return refuse("MALFORMED_INPUT", path, `must be an integer from ${min} to ${max}`);
  return value;
}

function big(value: unknown, path: string, min: bigint): bigint {
  if (typeof value !== "bigint" || value < min)
    return refuse("MALFORMED_INPUT", path, `must be a bigint of at least ${min}`);
  return value;
}

/** Plain data only: null, strings, booleans, bigints, safe integers, arrays and plain records. */
function data(value: unknown, path: string, depth = 0): void {
  if (depth > SCENARIO_LIMITS.dataDepth) refuse("MALFORMED_INPUT", path, "is nested too deeply");
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
    case "bigint":
      return;
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0))
        refuse("MALFORMED_INPUT", path, "numbers must be safe integers");
      return;
    case "object":
      if (Array.isArray(value)) {
        value.forEach((item, index) => data(item, `${path}[${index}]`, depth + 1));
        return;
      }
      if (!isRecord(value)) refuse("MALFORMED_INPUT", path, "must be plain data");
      for (const name of Object.keys(value)) data(value[name], `${path}.${name}`, depth + 1);
      return;
    default:
      refuse("MALFORMED_INPUT", path, "must be plain data");
  }
}

function segments(value: unknown, path: string, code: string): readonly PathSegment[] {
  if (!Array.isArray(value)) return refuse(code, path, "must be an array of path segments");
  return value.map((item: unknown, index): PathSegment => {
    const at = `${path}[${index}]`;
    if (typeof item === "string" && item.length > 0) return item;
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) return item;
    if (isRecord(item)) {
      const selector = exact(item, at, ["key", "equals"]);
      data(selector.equals, `${at}.equals`);
      return { key: text(selector.key, `${at}.key`), equals: selector.equals };
    }
    return refuse(
      code,
      at,
      "a segment is a non-empty string, a non-negative integer or { key, equals }",
    );
  });
}

function stepsOf(
  value: unknown,
  path: string,
  catalog: ReadonlyMap<string, ReadonlySet<number>>,
): readonly ScenarioStep[] {
  const raw = list(value, path, SCENARIO_LIMITS.steps);
  const seen = new Set<string>();
  const commands = new Set<string>();
  let lastTarget = -1n;
  return raw.map((item, index): ScenarioStep => {
    const at = `${path}[${index}]`;
    if (!isRecord(item)) return refuse("MALFORMED_INPUT", at, "a step must be a record");
    if (!Object.hasOwn(item, "kind")) return refuse("MISSING_FIELD", `${at}.kind`, "missing field");
    const kind = item.kind;
    let step: ScenarioStep;
    switch (kind) {
      case "command": {
        const raw = exact(item, at, ["kind", "key", "type", "version", "payload"], ["via"]);
        const type = text(raw.type, `${at}.type`);
        const version = int(raw.version, `${at}.version`, 1, 1_000_000);
        const versions = catalog.get(type);
        if (versions === undefined)
          refuse("UNCATALOGUED_COMMAND", `${at}.type`, `${type} is not in the command catalog`);
        if (type === "world.advance")
          refuse("INVALID_STEP", `${at}.type`, "advance time with an advance step");
        if (!versions.has(version))
          refuse(
            "UNCATALOGUED_COMMAND",
            `${at}.version`,
            `${type} has no catalogued version ${version}`,
          );
        if (!isRecord(raw.payload))
          return refuse("MALFORMED_INPUT", `${at}.payload`, "must be a record");
        data(raw.payload, `${at}.payload`);
        const payload = clonePlain(raw.payload);
        if (!Object.hasOwn(payload, "schemaVersion")) payload.schemaVersion = version;
        else if (payload.schemaVersion !== version)
          refuse(
            "INVALID_STEP",
            `${at}.payload.schemaVersion`,
            "payload version differs from the step version",
          );
        let via: CapabilityVia | undefined;
        if (Object.hasOwn(raw, "via")) {
          const rawVia = exact(raw.via, `${at}.via`, ["actor", "capability"]);
          const actor = text(rawVia.actor, `${at}.via.actor`, 256);
          const binding =
            typeof rawVia.capability === "string" ? BINDING.exec(rawVia.capability) : null;
          const bound = Number(binding?.[2]);
          if (binding === null || bound > 1_000_000)
            return refuse(
              "INVALID_STEP",
              `${at}.via.capability`,
              "a capability binding is id@version, with a version from 1 to 1000000",
            );
          via = { actor, capability: { id: binding[1] as string, version: bound } };
        }
        step = {
          kind,
          key: key(raw.key, `${at}.key`),
          type,
          version,
          payload,
          ...(via === undefined ? {} : { via }),
        };
        commands.add(step.key);
        break;
      }
      case "advance": {
        const raw = exact(
          item,
          at,
          ["kind", "key", "to", "mode"],
          ["stepMs", "maxInputs", "maxEvents"],
        );
        const to = big(raw.to, `${at}.to`, 0n);
        if (to <= lastTarget)
          refuse("INVALID_STEP", `${at}.to`, "advance targets must increase within a plan");
        lastTarget = to;
        if (raw.mode !== "live" && raw.mode !== "fast-forward")
          return refuse("INVALID_STEP", `${at}.mode`, "mode is live or fast-forward");
        let stepMs: bigint | null = null;
        if (raw.mode === "live") {
          if (!Object.hasOwn(raw, "stepMs"))
            return refuse("MISSING_FIELD", `${at}.stepMs`, "live advance needs stepMs");
          stepMs = big(raw.stepMs, `${at}.stepMs`, 1n);
        } else if (Object.hasOwn(raw, "stepMs"))
          refuse("INVALID_STEP", `${at}.stepMs`, "a fast-forward advance takes no stepMs");
        step = {
          kind,
          key: key(raw.key, `${at}.key`),
          to,
          mode: raw.mode,
          stepMs,
          maxInputs: Object.hasOwn(raw, "maxInputs")
            ? int(raw.maxInputs, `${at}.maxInputs`, 1, SCENARIO_LIMITS.maxBudget)
            : 1024,
          maxEvents: Object.hasOwn(raw, "maxEvents")
            ? int(raw.maxEvents, `${at}.maxEvents`, 1, SCENARIO_LIMITS.maxBudget)
            : 4096,
        };
        break;
      }
      case "retry": {
        const raw = exact(item, at, ["kind", "key", "of"]);
        const of = key(raw.of, `${at}.of`);
        if (!commands.has(of))
          refuse("INVALID_STEP", `${at}.of`, "retry names no earlier command step");
        step = { kind, key: key(raw.key, `${at}.key`), of };
        break;
      }
      case "restart": {
        const raw = exact(item, at, ["kind", "key"]);
        step = { kind, key: key(raw.key, `${at}.key`) };
        break;
      }
      default:
        return refuse(
          "UNKNOWN_STEP_KIND",
          `${at}.kind`,
          "step kind is command, advance, retry or restart",
        );
    }
    if (seen.has(step.key))
      refuse("INVALID_STEP", `${at}.key`, "step keys must be unique within a plan");
    seen.add(step.key);
    return step;
  });
}

function comparison(raw: Rec, at: string): { operator: CompareOperator; value: unknown } {
  const operator = raw.operator;
  if (!isOneOf(COMPARE_OPERATORS, operator))
    return refuse(
      "INVALID_ASSERTION",
      `${at}.operator`,
      `operator is one of ${COMPARE_OPERATORS.join(", ")}`,
    );
  data(raw.value, `${at}.value`);
  return { operator, value: clonePlain(raw.value) };
}

/** Strict decoder of a scenario document; refusals carry the path inside the document. */
export function decodeScenario(value: unknown): ScenarioDocument {
  const root = "scenario";
  if (!isRecord(value)) return refuse("MALFORMED_INPUT", root, "scenario must be a record");
  for (const name of Object.keys(value))
    if (
      ![
        "kind",
        "schemaVersion",
        "name",
        "pack",
        "steps",
        "variants",
        "equivalences",
        "perception",
        "assertions",
        "recording",
      ].includes(name)
    )
      refuse("UNKNOWN_FIELD", `${root}.${name}`, "unknown scenario field");
  for (const name of ["kind", "schemaVersion", "name", "pack", "steps"])
    if (!Object.hasOwn(value, name))
      refuse("MISSING_FIELD", `${root}.${name}`, "missing scenario field");
  if (value.kind !== SCENARIO_KIND)
    refuse("UNSUPPORTED_SCENARIO_KIND", `${root}.kind`, `kind must be ${SCENARIO_KIND}`);
  if (value.schemaVersion !== SCENARIO_SCHEMA_VERSION)
    refuse(
      "UNSUPPORTED_SCENARIO_VERSION",
      `${root}.schemaVersion`,
      `schemaVersion must be ${SCENARIO_SCHEMA_VERSION}`,
    );
  const name = text(value.name, `${root}.name`);
  if (Object.hasOwn(value, "recording") && !isOneOf(RECORDING_MODES, value.recording))
    refuse(
      "MALFORMED_INPUT",
      `${root}.recording`,
      `recording is one of ${RECORDING_MODES.join(", ")}`,
    );
  const packRaw = exact(value.pack, `${root}.pack`, ["id", "version"]);
  const pack = {
    id: text(packRaw.id, `${root}.pack.id`, 256),
    version: text(packRaw.version, `${root}.pack.version`, 256),
  };

  const catalog = new Map<string, Set<number>>();
  for (const [type, version] of worldRegistryIdentity().commands) {
    const known = catalog.get(type) ?? new Set<number>();
    known.add(version);
    catalog.set(type, known);
  }
  const steps = stepsOf(value.steps, `${root}.steps`, catalog);

  const variants: ScenarioVariant[] = [];
  const runNames = new Set<string>([MAIN_RUN]);
  list(value.variants ?? [], `${root}.variants`, SCENARIO_LIMITS.variants).forEach(
    (item, index) => {
      const at = `${root}.variants[${index}]`;
      const raw = exact(item, at, ["name", "steps"]);
      const variantName = key(raw.name, `${at}.name`, "INVALID_VARIANT");
      if (runNames.has(variantName))
        refuse("INVALID_VARIANT", `${at}.name`, "variant names must be unique and not 'main'");
      runNames.add(variantName);
      variants.push({ name: variantName, steps: stepsOf(raw.steps, `${at}.steps`, catalog) });
    },
  );

  const equivalences: ScenarioEquivalence[] = [];
  const equivalenceIds = new Set<string>();
  list(value.equivalences ?? [], `${root}.equivalences`, SCENARIO_LIMITS.equivalences).forEach(
    (item, index) => {
      const at = `${root}.equivalences[${index}]`;
      const raw = exact(
        item,
        at,
        ["id", "left", "right", "fields"],
        ["eventTypes", "ignoreEventTypes", "ignoreStatePaths"],
      );
      const id = key(raw.id, `${at}.id`, "INVALID_EQUIVALENCE");
      if (equivalenceIds.has(id))
        refuse("INVALID_EQUIVALENCE", `${at}.id`, "equivalence ids must be unique");
      equivalenceIds.add(id);
      const left = raw.left;
      const right = raw.right;
      if (typeof left !== "string" || !runNames.has(left))
        refuse("INVALID_EQUIVALENCE", `${at}.left`, "must name 'main' or a declared variant");
      if (typeof right !== "string" || !runNames.has(right))
        refuse("INVALID_EQUIVALENCE", `${at}.right`, "must name 'main' or a declared variant");
      if (left === right)
        refuse("INVALID_EQUIVALENCE", `${at}.right`, "left and right must differ");
      if (!Array.isArray(raw.fields) || raw.fields.length === 0)
        refuse("INVALID_EQUIVALENCE", `${at}.fields`, "must be a non-empty array");
      const fields = raw.fields.map((field: unknown, fieldIndex) => {
        if (!isOneOf(EQUIVALENCE_FIELDS, field))
          return refuse(
            "INVALID_EQUIVALENCE",
            `${at}.fields[${fieldIndex}]`,
            `field is one of ${EQUIVALENCE_FIELDS.join(", ")}`,
          );
        return field;
      });
      if (new Set(fields).size !== fields.length)
        refuse("INVALID_EQUIVALENCE", `${at}.fields`, "fields must be unique");
      const eventTypes = list(raw.eventTypes ?? [], `${at}.eventTypes`, 64).map((entry, i) =>
        text(entry, `${at}.eventTypes[${i}]`),
      );
      const ignoreEventTypes = list(raw.ignoreEventTypes ?? [], `${at}.ignoreEventTypes`, 64).map(
        (entry, i) => text(entry, `${at}.ignoreEventTypes[${i}]`),
      );
      const ignoreStatePaths = list(raw.ignoreStatePaths ?? [], `${at}.ignoreStatePaths`, 64).map(
        (entry, i) =>
          segments(entry, `${at}.ignoreStatePaths[${i}]`, "INVALID_EQUIVALENCE").map(
            (segment, s) => {
              if (typeof segment === "object")
                return refuse(
                  "INVALID_EQUIVALENCE",
                  `${at}.ignoreStatePaths[${i}][${s}]`,
                  "selectors are not allowed",
                );
              return segment;
            },
          ),
      );
      equivalences.push({
        id,
        left,
        right,
        fields,
        eventTypes,
        ignoreEventTypes,
        ignoreStatePaths,
      });
    },
  );

  let perception: ScenarioPerception | null = null;
  if (value.perception !== undefined && value.perception !== null) {
    const at = `${root}.perception`;
    const raw = exact(value.perception, at, ["policy"], ["modality", "modalities"]);
    if (!isRecord(raw.policy))
      return refuse("INVALID_PERCEPTION", `${at}.policy`, "policy must be a record");
    data(raw.policy, `${at}.policy`);
    const modalities = new Set<string>(PERCEPTION_MODALITIES);
    const fallback = raw.modality ?? "sight";
    if (typeof fallback !== "string" || !modalities.has(fallback))
      return refuse(
        "INVALID_PERCEPTION",
        `${at}.modality`,
        `modality is one of ${[...modalities].join(", ")}`,
      );
    const byType: Record<string, string> = {};
    if (raw.modalities !== undefined) {
      if (!isRecord(raw.modalities))
        return refuse("INVALID_PERCEPTION", `${at}.modalities`, "must be a record");
      for (const type of Object.keys(raw.modalities)) {
        const modality = raw.modalities[type];
        if (typeof modality !== "string" || !modalities.has(modality))
          return refuse("INVALID_PERCEPTION", `${at}.modalities.${type}`, "unknown modality");
        byType[type] = modality;
      }
    }
    perception = { policy: clonePlain(raw.policy), modality: fallback, modalities: byType };
  }

  const assertions: ScenarioAssertion[] = [];
  const assertionIds = new Set<string>();
  list(value.assertions ?? [], `${root}.assertions`, SCENARIO_LIMITS.assertions).forEach(
    (item, index) => {
      const at = `${root}.assertions[${index}]`;
      if (!isRecord(item)) refuse("MALFORMED_INPUT", at, "an assertion must be a record");
      if (!Object.hasOwn(item, "kind")) refuse("MISSING_FIELD", `${at}.kind`, "missing field");
      const runOf = (raw: Rec): string => {
        if (typeof raw.run !== "string" || !runNames.has(raw.run))
          return refuse("INVALID_ASSERTION", `${at}.run`, "must name 'main' or a declared variant");
        return raw.run;
      };
      let assertion: ScenarioAssertion;
      switch (item.kind) {
        case "path": {
          const raw = exact(item, at, ["kind", "id", "run", "path", "operator", "value"]);
          const { operator, value: expected } = comparison(raw, at);
          assertion = {
            kind: "path",
            id: key(raw.id, `${at}.id`, "INVALID_ASSERTION"),
            run: runOf(raw),
            path: segments(raw.path, `${at}.path`, "INVALID_ASSERTION"),
            operator,
            value: expected,
          };
          break;
        }
        case "eventCount": {
          const raw = exact(
            item,
            at,
            ["kind", "id", "run", "operator", "value"],
            ["eventType", "from", "to", "where"],
          );
          const { operator, value: expected } = comparison(raw, at);
          if (typeof expected !== "number" || expected < 0)
            refuse("INVALID_ASSERTION", `${at}.value`, "an event count is a non-negative integer");
          const where = list(raw.where ?? [], `${at}.where`, 16).map((entry, i) => {
            const clause = exact(entry, `${at}.where[${i}]`, ["path", "value"]);
            data(clause.value, `${at}.where[${i}].value`);
            return {
              path: segments(clause.path, `${at}.where[${i}].path`, "INVALID_ASSERTION"),
              value: clonePlain(clause.value),
            };
          });
          assertion = {
            kind: "eventCount",
            id: key(raw.id, `${at}.id`, "INVALID_ASSERTION"),
            run: runOf(raw),
            eventType: raw.eventType === undefined ? null : text(raw.eventType, `${at}.eventType`),
            from: raw.from === undefined ? null : big(raw.from, `${at}.from`, 0n),
            to: raw.to === undefined ? null : big(raw.to, `${at}.to`, 0n),
            where,
            operator,
            value: expected,
          };
          break;
        }
        case "equivalence": {
          const raw = exact(item, at, ["kind", "id", "equivalence", "expect"]);
          if (typeof raw.equivalence !== "string" || !equivalenceIds.has(raw.equivalence))
            refuse("INVALID_ASSERTION", `${at}.equivalence`, "must name a declared equivalence");
          if (typeof raw.expect !== "boolean")
            refuse("INVALID_ASSERTION", `${at}.expect`, "must be a boolean");
          assertion = {
            kind: "equivalence",
            id: key(raw.id, `${at}.id`, "INVALID_ASSERTION"),
            equivalence: raw.equivalence,
            expect: raw.expect,
          };
          break;
        }
        default:
          refuse(
            "INVALID_ASSERTION",
            `${at}.kind`,
            "assertion kind is path, eventCount or equivalence",
          );
      }
      if (assertionIds.has(assertion.id))
        refuse("INVALID_ASSERTION", `${at}.id`, "assertion ids must be unique");
      assertionIds.add(assertion.id);
      assertions.push(assertion);
    },
  );

  return {
    kind: SCENARIO_KIND,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    name,
    pack,
    steps,
    variants,
    equivalences,
    perception,
    assertions,
    ...(isOneOf(RECORDING_MODES, value.recording) ? { recording: value.recording } : {}),
  };
}
