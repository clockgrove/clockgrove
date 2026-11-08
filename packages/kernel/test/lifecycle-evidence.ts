import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------------------------
// RW-0109: executable schema of the `lifecycle` evidence section (one `lifecycle.json` file).
// ---------------------------------------------------------------------------------------------

export const LIFECYCLE_EQUIVALENCE_NAME = "material-lifecycle";
export const LIFECYCLE_PAIR_NAMES = [
  "live-steps-vs-fast-forward",
  "bounded-continuation-vs-unbounded",
  "single-season-vs-no-hook",
  "weather-perturbed-vs-baseline",
] as const;
export const LIFECYCLE_RUN_NAMES = [
  "household-generations",
  "sure",
  "young",
  "cap",
  "no-co-parent",
  "pair",
  "season",
  "sick",
  "coincide",
] as const;
export const LIFECYCLE_LONG_RUN_NAMES = ["lifecycle-30-day", "lifecycle-one-year"] as const;
export const LIFECYCLE_EVENT_NAMES = [
  "lifecycle.conceived",
  "lifecycle.gestation-milestone",
  "lifecycle.born",
  "lifecycle.stage-changed",
  "lifecycle.died",
  "lifecycle.successor-intended",
] as const;

/** Committed literal hashes of the test-owned `household-generations` golden. */
export const LIFECYCLE_GOLDEN = {
  name: "household-generations",
  materialEventHash: "d1703558f6974162610e09c628fae390f385f90aa25aa4e6baccb75efcf05aba",
  finalStateHash: "1063028eea6d63d5b8988ff385e4162e1ff68cc921b22c376f9768f858e43f9e",
} as const;

/** Committed literal hashes of the long-run summaries. */
export const LIFECYCLE_LONG_HASHES: Readonly<
  Record<string, { populationHash: string; lifecycleHash: string; resourceHash: string }>
> = {
  "lifecycle-30-day": {
    populationHash: "c0e61d2a9cf027537322e03703c66b7a25bfea6198c1df78bef71faa2de17c15",
    lifecycleHash: "fce2af50cdc33267b92b0656fff487c6289bceb3aafee186ff156625eb6ed74e",
    resourceHash: "ae8172ef968f64caa8a675a4bb9d8dbcc66facb3db90b5a56b17ebbb5e5dd516",
  },
  "lifecycle-one-year": {
    populationHash: "3b2513b5b41d43dc299fc884666f0d20b4f231c3c41dbac7eeda2f4bf0a49433",
    lifecycleHash: "2d8d85629e5668f9d390720840c9de09039db897945baf044ab9c34cdc7456fb",
    resourceHash: "396602efbc4ddc331582a32d9fdf71a7b416969e99c5c66ea0ab445b11a1759d",
  },
};

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hex = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const decimal = (value: unknown): boolean =>
  typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value);
const sha = (body: unknown): string =>
  createHash("sha256").update(JSON.stringify(body)).digest("hex");

const EVIDENCE_KEYS = [
  "schemaVersion",
  "seed",
  "versions",
  "runs",
  "longRuns",
  "pairs",
  "assertions",
  "golden",
];
const RUN_KEYS = [
  "name",
  "engine",
  "commands",
  "events",
  "scheduleMutations",
  "remainingDeadlines",
  "conception",
  "finalProjection",
  "streamBefore",
  "streamAfter",
  "finalStateHash",
  "materialEventHash",
  "eventCounts",
];
const LONG_KEYS = [
  "name",
  "days",
  "stepDays",
  "logicalCalls",
  "kernelCalls",
  "eventTotal",
  "decisions",
  "material",
  "eventBound",
  "counts",
  "maxLiving",
  "finalLiving",
  "finalDead",
  "born",
  "died",
  "problems",
  "populationHash",
  "lifecycleHash",
  "resourceHash",
  "finalStateHash",
  "streamBefore",
  "streamAfter",
];

function exactKeys(
  value: unknown,
  keys: readonly string[],
  at: string,
  problems: string[],
): value is Rec {
  if (!isRecord(value)) {
    problems.push(`${at}: must be a record`);
    return false;
  }
  for (const key of keys) if (!(key in value)) problems.push(`${at}: missing field ${key}`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) problems.push(`${at}: unexpected field ${key}`);
  return true;
}

/** Executable schema of the lifecycle evidence section; returns every violation (empty = valid). */
export function lifecycleEvidenceProblems(value: unknown, path = "lifecycle"): string[] {
  const problems: string[] = [];
  const bad = (at: string, message: string): void => {
    problems.push(`${at}: ${message}`);
  };
  if (!exactKeys(value, EVIDENCE_KEYS, path, problems)) return problems;
  if (value.schemaVersion !== 1) bad(`${path}.schemaVersion`, "must be 1");
  if (!isRecord(value.seed) || typeof value.seed.seed !== "string")
    bad(`${path}.seed`, "seed record required");

  const versions = value.versions;
  if (
    exactKeys(
      versions,
      ["kernelRegistryHash", "lifecycleReducers", "prng", "pack", "policy"],
      `${path}.versions`,
      problems,
    )
  ) {
    if (!hex(versions.kernelRegistryHash))
      bad(`${path}.versions.kernelRegistryHash`, "64 lowercase hex characters required");
    const reducers = Array.isArray(versions.lifecycleReducers) ? versions.lifecycleReducers : [];
    for (const type of LIFECYCLE_EVENT_NAMES)
      if (
        reducers.filter((entry) => Array.isArray(entry) && entry[0] === type && entry[1] === 1)
          .length !== 1
      )
        bad(
          `${path}.versions.lifecycleReducers`,
          `exactly one version 1 reducer for ${type} required`,
        );
    if (exactKeys(versions.prng, ["contract", "algorithm"], `${path}.versions.prng`, problems)) {
      if (typeof versions.prng.contract !== "string" || typeof versions.prng.algorithm !== "string")
        bad(`${path}.versions.prng`, "contract and algorithm strings required");
    }
    if (
      exactKeys(
        versions.pack,
        ["packId", "packVersion", "contentHash"],
        `${path}.versions.pack`,
        problems,
      )
    ) {
      if (!hex(versions.pack.contentHash))
        bad(`${path}.versions.pack.contentHash`, "64 lowercase hex characters required");
    }
    if (
      exactKeys(versions.policy, ["version", "contentHash"], `${path}.versions.policy`, problems)
    ) {
      if (!hex(versions.policy.contentHash))
        bad(`${path}.versions.policy.contentHash`, "64 lowercase hex characters required");
    }
  }

  const runs = Array.isArray(value.runs) ? value.runs : undefined;
  if (runs === undefined) bad(`${path}.runs`, "must be a list");
  else {
    const names = runs.map((run) => (isRecord(run) ? run.name : undefined));
    for (const name of LIFECYCLE_RUN_NAMES)
      if (names.filter((candidate) => candidate === name).length !== 1)
        bad(`${path}.runs.${name}`, "exactly one entry required");
    runs.forEach((run, index) => {
      const at = `${path}.runs[${index}]`;
      if (!exactKeys(run, RUN_KEYS, at, problems)) return;
      if (!hex(run.finalStateHash))
        bad(`${at}.finalStateHash`, "64 lowercase hex characters required");
      if (!hex(run.materialEventHash))
        bad(`${at}.materialEventHash`, "64 lowercase hex characters required");
      if (typeof run.engine !== "string") bad(`${at}.engine`, "runtime identifier required");
      for (const key of [
        "commands",
        "events",
        "scheduleMutations",
        "remainingDeadlines",
        "conception",
      ])
        if (!Array.isArray(run[key])) bad(`${at}.${key}`, "must be a list");
      if (!isRecord(run.eventCounts)) bad(`${at}.eventCounts`, "must be a record");
      else {
        const total = Object.values(run.eventCounts).reduce<number>(
          (sum, count) => sum + (typeof count === "number" ? count : 0),
          0,
        );
        if (Array.isArray(run.events) && total !== run.events.length)
          bad(`${at}.eventCounts`, "must sum to the event list length");
      }
      if (Array.isArray(run.events))
        for (const event of run.events)
          if (
            !Array.isArray(event) ||
            typeof event[0] !== "string" ||
            event[1] !== 1 ||
            !decimal(event[2])
          )
            bad(`${at}.events`, "entries must be [type, reducerVersion 1, decimal time]");
      for (const key of ["streamBefore", "streamAfter"]) {
        const stream = run[key];
        if (exactKeys(stream, ["draws", "hash"], `${at}.${key}`, problems)) {
          if (!decimal(stream.draws)) bad(`${at}.${key}.draws`, "decimal text required");
          if (!hex(stream.hash)) bad(`${at}.${key}.hash`, "64 lowercase hex characters required");
        }
      }
      if (Array.isArray(run.conception))
        for (const entry of run.conception) {
          const ok =
            Array.isArray(entry) &&
            entry.length === 7 &&
            typeof entry[0] === "string" &&
            decimal(entry[1]) &&
            (entry[2] === null || typeof entry[2] === "string") &&
            ["excluded", "conceived", "not-conceived"].includes(String(entry[4])) &&
            (entry[2] === null) === (entry[3] !== null) &&
            Array.isArray(entry[6]) &&
            entry[6].length === 3 &&
            typeof entry[6][0] === "number" &&
            typeof entry[6][1] === "string" &&
            typeof entry[6][2] === "number";
          if (!ok)
            bad(
              `${at}.conception`,
              "entries must be [object, time, exclusion, draw, outcome, child, features]",
            );
        }
      const projection = run.finalProjection;
      if (
        exactKeys(
          projection,
          ["simulationTime", "entities", "households", "entries"],
          `${at}.finalProjection`,
          problems,
        )
      ) {
        if (!decimal(projection.simulationTime))
          bad(`${at}.finalProjection.simulationTime`, "decimal text required");
        for (const key of ["entities", "households", "entries"])
          if (!Array.isArray(projection[key]))
            bad(`${at}.finalProjection.${key}`, "must be a list");
      }
    });
    const golden = runs.find((run) => isRecord(run) && run.name === LIFECYCLE_GOLDEN.name);
    if (isRecord(golden)) {
      if (golden.finalStateHash !== LIFECYCLE_GOLDEN.finalStateHash)
        bad(
          `${path}.runs.${LIFECYCLE_GOLDEN.name}.finalStateHash`,
          "must equal the committed literal",
        );
      if (golden.materialEventHash !== LIFECYCLE_GOLDEN.materialEventHash)
        bad(
          `${path}.runs.${LIFECYCLE_GOLDEN.name}.materialEventHash`,
          "must equal the committed literal",
        );
      if (isRecord(golden.eventCounts))
        for (const type of LIFECYCLE_EVENT_NAMES)
          if (
            typeof golden.eventCounts[type] !== "number" ||
            (golden.eventCounts[type] as number) < 1
          )
            bad(`${path}.runs.${LIFECYCLE_GOLDEN.name}.eventCounts`, `golden must emit ${type}`);
    }
  }

  const longs = Array.isArray(value.longRuns) ? value.longRuns : undefined;
  if (longs === undefined) bad(`${path}.longRuns`, "must be a list");
  else {
    for (const name of LIFECYCLE_LONG_RUN_NAMES)
      if (longs.filter((run) => isRecord(run) && run.name === name).length !== 1)
        bad(`${path}.longRuns.${name}`, "exactly one entry required");
    longs.forEach((run, index) => {
      const at = `${path}.longRuns[${index}]`;
      if (!exactKeys(run, LONG_KEYS, at, problems)) return;
      for (const key of ["populationHash", "lifecycleHash", "resourceHash", "finalStateHash"])
        if (!hex(run[key])) bad(`${at}.${key}`, "64 lowercase hex characters required");
      if (!Array.isArray(run.problems) || run.problems.length !== 0)
        bad(`${at}.problems`, "must be empty");
      if (
        typeof run.eventTotal !== "number" ||
        typeof run.eventBound !== "number" ||
        run.eventTotal > run.eventBound
      )
        bad(`${at}.eventTotal`, "must not exceed the declared event bound");
      if (typeof run.maxLiving !== "number" || run.maxLiving < 1 || run.maxLiving > 6)
        bad(`${at}.maxLiving`, "must be within the population cap");
      const literal = typeof run.name === "string" ? LIFECYCLE_LONG_HASHES[run.name] : undefined;
      if (literal !== undefined)
        for (const key of ["populationHash", "lifecycleHash", "resourceHash"] as const)
          if (run[key] !== literal[key]) bad(`${at}.${key}`, "must equal the committed literal");
      for (const key of ["streamBefore", "streamAfter"])
        if (!hex(run[key])) bad(`${at}.${key}`, "64 lowercase hex characters required");
    });
  }

  const pairs = Array.isArray(value.pairs) ? value.pairs : undefined;
  if (pairs === undefined) bad(`${path}.pairs`, "must be a list");
  else {
    const names = pairs.map((pair) => (isRecord(pair) ? pair.name : undefined));
    for (const name of LIFECYCLE_PAIR_NAMES)
      if (names.filter((candidate) => candidate === name).length !== 1)
        bad(`${path}.pairs.${name}`, "exactly one entry required");
    pairs.forEach((pair, index) => {
      const at = `${path}.pairs[${index}]`;
      if (!exactKeys(pair, ["name", "equivalence", "leftHash", "rightHash"], at, problems)) return;
      if (!(LIFECYCLE_PAIR_NAMES as readonly unknown[]).includes(pair.name))
        bad(`${at}.name`, "unknown pair");
      if (pair.equivalence !== LIFECYCLE_EQUIVALENCE_NAME)
        bad(`${at}.equivalence`, `must declare ${LIFECYCLE_EQUIVALENCE_NAME}`);
      if (!hex(pair.leftHash) || !hex(pair.rightHash))
        bad(`${at}`, "64 lowercase hex hashes required");
      else if (pair.leftHash !== pair.rightHash) bad(`${at}`, "pair hashes must be equal");
    });
  }

  const assertions = Array.isArray(value.assertions) ? value.assertions : undefined;
  if (assertions === undefined || assertions.length === 0)
    bad(`${path}.assertions`, "non-empty list required");
  else
    assertions.forEach((entry, index) => {
      const at = `${path}.assertions[${index}]`;
      if (exactKeys(entry, ["name", "ok"], at, problems) && entry.ok !== true)
        bad(at, "assertion must pass");
    });

  if (
    exactKeys(
      value.golden,
      ["name", "materialEventHash", "finalStateHash"],
      `${path}.golden`,
      problems,
    )
  ) {
    if (value.golden.name !== LIFECYCLE_GOLDEN.name)
      bad(`${path}.golden.name`, `must be ${LIFECYCLE_GOLDEN.name}`);
    if (
      value.golden.materialEventHash !== LIFECYCLE_GOLDEN.materialEventHash ||
      value.golden.finalStateHash !== LIFECYCLE_GOLDEN.finalStateHash
    )
      bad(`${path}.golden`, "hashes must equal the committed literals");
  }
  return problems;
}

/** Cross-runtime comparison summary of the lifecycle section. */
export function lifecycleComparisonProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["comparison.lifecycle: must be a record"];
  if (value.equal !== true) problems.push("comparison.lifecycle.equal: must be true");
  for (const key of ["nodeHash", "workersHash", "goldenMaterialEventHash", "goldenFinalStateHash"])
    if (!hex(value[key]))
      problems.push(`comparison.lifecycle.${key}: 64 lowercase hex characters required`);
  if (value.nodeHash !== value.workersHash)
    problems.push("comparison.lifecycle: node and workers hashes differ");
  if (value.goldenName !== LIFECYCLE_GOLDEN.name)
    problems.push("comparison.lifecycle.goldenName: must name the golden");
  if (
    value.goldenMaterialEventHash !== LIFECYCLE_GOLDEN.materialEventHash ||
    value.goldenFinalStateHash !== LIFECYCLE_GOLDEN.finalStateHash
  )
    problems.push("comparison.lifecycle: golden hashes must equal the committed literals");
  for (const key of ["runCount", "longRunCount", "pairCount", "assertionCount"])
    if (!Number.isInteger(value[key]) || (value[key] as number) < 1)
      problems.push(`comparison.lifecycle.${key}: positive integer required`);
  if (value.pairCount !== LIFECYCLE_PAIR_NAMES.length)
    problems.push("comparison.lifecycle.pairCount: must equal the pair count");
  if (value.longRunCount !== LIFECYCLE_LONG_RUN_NAMES.length)
    problems.push("comparison.lifecycle.longRunCount: must equal the long-run count");
  return problems;
}

/** Validates the three written report bodies together for the lifecycle section. */
export function lifecycleReportProblems(
  node: unknown,
  workers: unknown,
  comparison: unknown,
): string[] {
  const nodeSection =
    isRecord(node) && isRecord(node.evidence) ? node.evidence.lifecycle : undefined;
  const workersSection =
    isRecord(workers) && isRecord(workers.evidence) ? workers.evidence.lifecycle : undefined;
  const summary = isRecord(comparison) ? comparison.lifecycle : undefined;
  const problems = [
    ...(nodeSection === undefined
      ? ["node.json: lifecycle section missing"]
      : lifecycleEvidenceProblems(nodeSection, "node.lifecycle")),
    ...(workersSection === undefined
      ? ["workers.json: lifecycle section missing"]
      : lifecycleEvidenceProblems(workersSection, "workers.lifecycle")),
    ...lifecycleComparisonProblems(summary),
  ];
  if (
    nodeSection !== undefined &&
    workersSection !== undefined &&
    JSON.stringify(nodeSection) !== JSON.stringify(workersSection)
  )
    problems.push("node and workers lifecycle bodies differ");
  if (isRecord(summary)) {
    if (nodeSection !== undefined && summary.nodeHash !== sha(nodeSection))
      problems.push("comparison.lifecycle.nodeHash does not match node.json");
    if (workersSection !== undefined && summary.workersHash !== sha(workersSection))
      problems.push("comparison.lifecycle.workersHash does not match workers.json");
    if (isRecord(nodeSection)) {
      if (Array.isArray(nodeSection.runs) && summary.runCount !== nodeSection.runs.length)
        problems.push("comparison.lifecycle.runCount does not match node.json");
      if (
        Array.isArray(nodeSection.longRuns) &&
        summary.longRunCount !== nodeSection.longRuns.length
      )
        problems.push("comparison.lifecycle.longRunCount does not match node.json");
      if (Array.isArray(nodeSection.pairs) && summary.pairCount !== nodeSection.pairs.length)
        problems.push("comparison.lifecycle.pairCount does not match node.json");
      if (
        Array.isArray(nodeSection.assertions) &&
        summary.assertionCount !== nodeSection.assertions.length
      )
        problems.push("comparison.lifecycle.assertionCount does not match node.json");
      if (isRecord(nodeSection.golden)) {
        if (summary.goldenMaterialEventHash !== nodeSection.golden.materialEventHash)
          problems.push("comparison.lifecycle.goldenMaterialEventHash does not match node.json");
        if (summary.goldenFinalStateHash !== nodeSection.golden.finalStateHash)
          problems.push("comparison.lifecycle.goldenFinalStateHash does not match node.json");
      }
    }
  }
  return problems;
}
