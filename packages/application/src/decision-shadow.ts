import {
  type CommandId,
  constructActorAddress,
  decodeOpaqueId,
  type PrivacyClass,
} from "@clockgrove/contracts";
import type {
  AmbiguityDeclaration,
  DecisionPointDeclaration,
  DecisionPointsDeclaration,
  DecisionTrace,
  RoutineCandidate,
} from "@clockgrove/domain";
import {
  actionKey,
  canonicalBytes,
  canonicalSerialize,
  type PlanningRequest,
  planningRequestFor,
  sha256Hex,
} from "@clockgrove/kernel";
import { allowDecision, TRUSTED_ID_PREFIX } from "./authority-decision.js";
import { DECISION_SHADOW_RECORDED } from "./event-registry.js";
import {
  type Journal,
  type JournalExecuteRequest,
  type JournalOutcomeReader,
  readsStoredOutcomes,
} from "./journal.js";
import { computePayloadHash } from "./journal-verification.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";
import { TRUSTED_COMMAND_ISSUED_AT } from "./world-command.js";

/**
 * Shadow-mode decision-model tier. A decision point (pack data) names a trigger, the model alias,
 * a confidence threshold, a budget and the deterministic fallback. The model picks among the
 * kernel's own valid candidates beside the utility choice; the pick is journaled as cognitive
 * evidence and never changes the physical decision. Contract: `docs/protocols/decision-shadow.md`.
 */

export const DECISION_SHADOW_RECORD_VERSION = 1;

/** One bounded model answer, as the runtime adapts it from the ModelGateway `decide` outcome. */
export type ShadowModelOutcome =
  | Readonly<{
      status: "completed";
      label: string;
      confidence: number | null;
      model: string;
      latencyMs: number;
      costMicrousd: number | null;
    }>
  | Readonly<{
      status: "failed";
      code: string;
      model: string;
      latencyMs: number;
      costMicrousd: number | null;
    }>;

/** The application's view of a decision model; the runtime adapts the ModelGateway to it. */
export interface ShadowDecider {
  pick(
    request: Readonly<{
      alias: string;
      callId: string;
      state: string;
      options: Readonly<Record<string, string>>;
      instructions: string;
    }>,
  ): Promise<ShadowModelOutcome>;
}

/** One committed decision: the trace the kernel recorded and the command that dispatched it. */
export interface ShadowSubject {
  readonly commandId: CommandId;
  readonly trace: DecisionTrace;
}

/**
 * `cant-tell`: the model chose the reserved `cant_tell` option. `low-confidence`: it answered a
 * candidate below the point's threshold (or reported none). The two are kept apart so the
 * threshold can be calibrated from data.
 */
export type ShadowStatus = "picked" | "cant-tell" | "low-confidence" | "failed" | "over-budget";

/** The reserved option offered at every decision point; kernel candidate keys always hold a colon. */
export const CANT_TELL_OPTION = "cant_tell";

export interface ShadowCandidate {
  readonly key: string;
  readonly score: string;
  /** Only the features the point shows, as fixed-point decimal strings. */
  readonly features: Readonly<Record<string, string>>;
}

/** The journaled payload. Plain JSON: scores are decimal strings. Never changes the world. */
export interface DecisionShadowRecord {
  readonly schemaVersion: 1;
  readonly pointId: string;
  readonly requestId: string;
  readonly signature: string;
  readonly objectId: string;
  readonly commandId: string;
  readonly simulationTime: string;
  readonly policyVersion: string;
  readonly trigger: Readonly<{
    kind: "score-margin" | "declared-ambiguity";
    margin: string | null;
  }>;
  readonly candidates: readonly ShadowCandidate[];
  /** The utility choice actually taken: the physical decision, unchanged by the shadow. */
  readonly utilityChoice: string;
  readonly shadow: Readonly<{
    status: ShadowStatus;
    /** The model's label for `picked`, `low-confidence` and `cant-tell`; null otherwise. */
    choice: string | null;
    /** Probability of the answer in basis points (0..10000), null when the model reported none. */
    confidenceBp: number | null;
    /** Why the model abstained, failed or was not called. */
    detail: string | null;
  }>;
  readonly modelAlias: string;
  readonly confidenceThreshold: number;
  readonly model: string | null;
  readonly latencyMs: number | null;
  readonly costMicrousd: number | null;
  /** No LLM planning path runs in this wave; the field is where its choice will be recorded. */
  readonly llm: Readonly<{ status: "not-run" }>;
}

export interface DecisionShadowDeclarations {
  readonly ambiguity: AmbiguityDeclaration;
  readonly decisionPoints: DecisionPointsDeclaration;
}

/** The shadow declarations of a utility policy, or undefined when it declares none (tier off). */
export function decisionShadowDeclarations(
  policy: Readonly<{
    ambiguity?: AmbiguityDeclaration;
    decisionPoints?: DecisionPointsDeclaration;
  }>,
): DecisionShadowDeclarations | undefined {
  return policy.ambiguity === undefined || policy.decisionPoints === undefined
    ? undefined
    : { ambiguity: policy.ambiguity, decisionPoints: policy.decisionPoints };
}

/** The first point whose trigger the request meets, or undefined. */
export function matchingDecisionPoint(
  request: PlanningRequest,
  declaration: DecisionPointsDeclaration,
): DecisionPointDeclaration | undefined {
  return declaration.points.find(
    (point) =>
      point.trigger.kind === "declared-ambiguity" ||
      (request.condition.kind === "score-margin" &&
        request.condition.margin <= point.trigger.maxMargin),
  );
}

/**
 * Time-independent identity of a decision situation: the point, the actor, the shown features and
 * scores of the valid candidates and the utility choice. The same situation repeats the same value.
 */
export function decisionSignature(
  pointId: string,
  objectId: string,
  candidates: readonly ShadowCandidate[],
  utilityChoice: string,
): string {
  const sorted = [...candidates].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return `sig_${sha256Hex(canonicalBytes(["clockgrove-decision-signature-v1", pointId, objectId, sorted, utilityChoice])).slice(0, 32)}`;
}

function shownCandidate(candidate: RoutineCandidate, features: readonly string[]): ShadowCandidate {
  const shown: Record<string, string> = {};
  for (const name of features) {
    const value = candidate.features[name];
    if (value !== undefined) shown[name] = value.toString();
  }
  return { key: actionKey(candidate), score: candidate.score.toString(), features: shown };
}

const INSTRUCTIONS =
  "Choose the one routine action this animal should take now. Answer with exactly one option label.";

function describe(candidate: ShadowCandidate): string {
  const features = Object.entries(candidate.features)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
  return `score ${candidate.score}${features === "" ? "" : `; ${features}`} (fixed-point values)`;
}

/**
 * Runs the shadow tier over committed decisions. Pure of the world: it reads traces and calls the
 * decider, never writing physical state. Without a decider (models off) it returns nothing, so the
 * world runs exactly as without the tier. Per-point budgets count calls and spend within one run.
 * Failures, `cant_tell`, low confidence and exhausted budgets each fall back to the
 * deterministic fallback, which is always the utility choice already taken.
 */
export async function runDecisionShadow(input: {
  readonly subjects: readonly ShadowSubject[];
  readonly declarations: DecisionShadowDeclarations;
  readonly decider: ShadowDecider | undefined;
}): Promise<readonly DecisionShadowRecord[]> {
  const { decider, declarations } = input;
  if (decider === undefined) return [];
  const used = new Map<string, { calls: number; microusd: number }>();
  const records: DecisionShadowRecord[] = [];
  for (const subject of input.subjects) {
    const request = planningRequestFor(subject.trace, declarations.ambiguity, subject.commandId);
    if (request === undefined || request.candidates.length < 2) continue;
    const point = matchingDecisionPoint(request, declarations.decisionPoints);
    if (point === undefined) continue;
    const candidates = request.candidates.map((candidate) =>
      shownCandidate(candidate, point.features),
    );
    const utilityChoice = `${request.fallbackAction.kind}:${request.fallbackAction.targetObjectId ?? ""}`;
    const base = {
      schemaVersion: DECISION_SHADOW_RECORD_VERSION,
      pointId: point.id,
      requestId: request.requestId,
      signature: decisionSignature(point.id, request.objectId, candidates, utilityChoice),
      objectId: request.objectId,
      commandId: request.commandId,
      simulationTime: request.simulationTime.toString(),
      policyVersion: request.policyVersion,
      trigger: {
        kind: request.condition.kind === "score-margin" ? point.trigger.kind : "declared-ambiguity",
        margin:
          request.condition.kind === "score-margin" ? request.condition.margin.toString() : null,
      },
      candidates,
      utilityChoice,
      modelAlias: point.modelAlias,
      confidenceThreshold: point.confidenceThreshold,
      llm: { status: "not-run" },
    } as const;
    const spent = used.get(point.id) ?? { calls: 0, microusd: 0 };
    used.set(point.id, spent);
    if (spent.calls >= point.budget.maxCalls || spent.microusd >= point.budget.maxMicrousd) {
      records.push({
        ...base,
        shadow: {
          status: "over-budget",
          choice: null,
          confidenceBp: null,
          detail: spent.calls >= point.budget.maxCalls ? "calls" : "spend",
        },
        model: null,
        latencyMs: null,
        costMicrousd: null,
      } as DecisionShadowRecord);
      continue;
    }
    spent.calls += 1;
    const options = {
      ...Object.fromEntries(candidates.map((candidate) => [candidate.key, describe(candidate)])),
      [CANT_TELL_OPTION]: "none of the candidates can be preferred; defer to the default choice",
    };
    const outcome = await decider.pick({
      alias: point.modelAlias,
      callId: `${request.requestId}:${request.objectId}:${request.simulationTime}:${point.id}`,
      state: `Actor ${request.objectId}. Candidate actions, already valid in the world:\n${candidates.map((candidate) => `- ${candidate.key}: ${describe(candidate)}`).join("\n")}`,
      options,
      instructions: INSTRUCTIONS,
    });
    spent.microusd += outcome.costMicrousd ?? 0;
    const accounting = {
      model: outcome.model,
      latencyMs: Math.round(outcome.latencyMs),
      costMicrousd: outcome.costMicrousd,
    };
    if (outcome.status === "failed") {
      records.push({
        ...base,
        shadow: { status: "failed", choice: null, confidenceBp: null, detail: outcome.code },
        ...accounting,
      } as DecisionShadowRecord);
      continue;
    }
    const known = Object.hasOwn(options, outcome.label);
    const cantTell = outcome.label === CANT_TELL_OPTION;
    const confidenceBp =
      outcome.confidence === null ? null : Math.round(outcome.confidence * 10_000);
    const low = confidenceBp === null || confidenceBp < point.confidenceThreshold;
    records.push({
      ...base,
      shadow: !known
        ? {
            status: "failed",
            choice: null,
            confidenceBp,
            detail: "unknown-label",
          }
        : {
            status: cantTell ? "cant-tell" : low ? "low-confidence" : "picked",
            choice: outcome.label,
            confidenceBp,
            detail: !cantTell && low ? "below-confidence-threshold" : null,
          },
      ...accounting,
    } as DecisionShadowRecord);
  }
  return records;
}

export interface DecisionShadowScope {
  readonly authorization: RuntimeAuthorizationContext;
  readonly tenantId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly partitionId: string;
  readonly spaceId: string;
  readonly streamId: string;
}

/** One identity per decision and point: a command may hold several decisions of several actors. */
function decisionShadowKey(record: DecisionShadowRecord): string {
  const digest = sha256Hex(
    canonicalBytes([
      "clockgrove-decision-shadow-v1",
      record.requestId,
      record.objectId,
      record.simulationTime,
      record.pointId,
    ]),
  );
  return digest.slice(0, 32);
}

/** `trusted:decision-shadow:<digest>`: one journaled record per decision and point. */
export function decisionShadowCommandId(record: DecisionShadowRecord): string {
  return `${TRUSTED_ID_PREFIX}decision-shadow:${decisionShadowKey(record)}`;
}

/**
 * Journals one shadow record as an `operator_evidence` event with no projection delta, so the
 * world's replayed state cannot change. An exact retry returns the stored outcome (idempotent).
 */
export async function journalDecisionShadow(
  journal: Journal,
  scope: DecisionShadowScope,
  record: DecisionShadowRecord,
  outcomes: JournalOutcomeReader | undefined = readsStoredOutcomes(journal) ? journal : undefined,
): Promise<void> {
  const commandId = decodeOpaqueId(decisionShadowCommandId(record), "CommandId");
  const target = constructActorAddress({
    tenantId: scope.tenantId,
    worldId: scope.worldId,
    timelineId: scope.timelineId,
    kind: "space",
    id: scope.spaceId,
  } as never);
  const raw = {
    schemaVersion: 2,
    commandId,
    type: "DecisionShadowRecord",
    target,
    expected: {},
    issuedAt: TRUSTED_COMMAND_ISSUED_AT,
    context: {
      version: 1,
      correlationId: decodeOpaqueId(commandId, "CorrelationId"),
      requestId: commandId,
    },
    attribution: {
      effectiveActorId: "clockgrove:decision-shadow",
      causalRootActionId: decodeOpaqueId(`action:${commandId}`, "ActionId"),
    },
    payload: record,
  };
  const command = raw as unknown as JournalExecuteRequest["command"];
  const authorityDecision = allowDecision({
    tenantId: command.target.tenantId,
    worldId: command.target.worldId,
    timelineId: command.target.timelineId,
    commandId,
    attribution: command.attribution,
    inputs: {
      principalId: scope.authorization.principalId,
      roles: [],
      grants: [],
      privacyCeiling: scope.authorization.privacyCeiling,
    },
  });
  const eventId = decodeOpaqueId(
    `${TRUSTED_ID_PREFIX}decision-shadow-event:${decisionShadowKey(record)}`,
    "EventId",
  );
  const privacyClass = "operator_evidence" as PrivacyClass;
  const commandBytes = new TextEncoder().encode(canonicalSerialize(raw));
  // An exact retry is answered from the stored receipt, as every decided command is.
  if (
    outcomes !== undefined &&
    (await outcomes.storedOutcome(scope.authorization, commandId, commandBytes)) !== undefined
  )
    return;
  await journal.execute({
    authorization: scope.authorization,
    command,
    commandBytes,
    route: {
      partitionId: decodeOpaqueId(scope.partitionId, "PartitionId"),
      spaceId: decodeOpaqueId(scope.spaceId, "SpaceId"),
      streamId: decodeOpaqueId(scope.streamId, "StreamId"),
    },
    authorityDecision,
    events: [
      {
        schemaVersion: 2,
        eventId,
        type: DECISION_SHADOW_RECORDED,
        partitionId: decodeOpaqueId(scope.partitionId, "PartitionId"),
        spaceId: decodeOpaqueId(scope.spaceId, "SpaceId"),
        streamId: decodeOpaqueId(scope.streamId, "StreamId"),
        simulationTime: BigInt(record.simulationTime) as never,
        correlationId: decodeOpaqueId(commandId, "CorrelationId"),
        attribution: {
          ...command.attribution,
          authorityDecisionId: authorityDecision.authorityDecisionId,
        },
        policyVersions: { routine: record.policyVersion },
        privacyClass,
        payloadHash: computePayloadHash(record),
        payload: record,
      },
    ],
    dispatches: [],
    stableResult: { recorded: true },
    projectionDelta: null,
  });
}

export interface DecisionShadowPointReport {
  readonly pointId: string;
  readonly decisions: number;
  /** Records with a candidate answer (picked or low-confidence); `cant-tell` is not an answer. */
  readonly answered: number;
  readonly agreed: number;
  /** `agreed / answered`, or null with no answers. */
  readonly agreementRate: number | null;
  /** Candidate answers below the point's confidence threshold. */
  readonly lowConfidence: number;
  /** The model chose the reserved `cant_tell` option. */
  readonly cantTell: number;
  readonly failed: number;
  readonly overBudget: number;
  readonly costMicrousd: number;
  readonly meanLatencyMs: number | null;
  readonly p95LatencyMs: number | null;
}

export interface DecisionShadowReview {
  readonly signature: string;
  readonly pointId: string;
  readonly repeats: number;
  readonly lowConfidence: number;
  readonly cantTell: number;
  readonly disagreements: number;
}

export interface DecisionShadowReport {
  readonly schemaVersion: 1;
  readonly points: readonly DecisionShadowPointReport[];
  /** Answers that differ from the utility choice, with their candidates, in record order. */
  readonly differing: readonly DecisionShadowRecord[];
  /**
   * Signatures seen at least twice whose answers were low-confidence, `cant_tell` or disagreeing, listed
   * apart from the rates for human review.
   */
  readonly review: readonly DecisionShadowReview[];
}

const EXAMPLE_LIMIT = 10;

const answered = (record: DecisionShadowRecord): boolean =>
  record.shadow.status === "picked" || record.shadow.status === "low-confidence";
const disagrees = (record: DecisionShadowRecord): boolean =>
  answered(record) && record.shadow.choice !== record.utilityChoice;

/** Agreement, cost and latency per decision point, differing examples and repeat signatures. */
export function decisionShadowReport(
  records: readonly DecisionShadowRecord[],
): DecisionShadowReport {
  const byPoint = new Map<string, DecisionShadowRecord[]>();
  for (const record of records)
    byPoint.set(record.pointId, [...(byPoint.get(record.pointId) ?? []), record]);
  const points = [...byPoint.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pointId, rows]): DecisionShadowPointReport => {
      const latencies = rows
        .flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs]))
        .sort((a, b) => a - b);
      const answers = rows.filter(answered);
      const agreed = answers.filter((row) => !disagrees(row)).length;
      return {
        pointId,
        decisions: rows.length,
        answered: answers.length,
        agreed,
        agreementRate: answers.length === 0 ? null : agreed / answers.length,
        lowConfidence: rows.filter((row) => row.shadow.status === "low-confidence").length,
        cantTell: rows.filter((row) => row.shadow.status === "cant-tell").length,
        failed: rows.filter((row) => row.shadow.status === "failed").length,
        overBudget: rows.filter((row) => row.shadow.status === "over-budget").length,
        costMicrousd: rows.reduce((sum, row) => sum + (row.costMicrousd ?? 0), 0),
        meanLatencyMs:
          latencies.length === 0
            ? null
            : latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
        p95LatencyMs:
          latencies.length === 0
            ? null
            : (latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] ??
              null),
      };
    });
  const bySignature = new Map<string, DecisionShadowRecord[]>();
  for (const record of records)
    bySignature.set(record.signature, [...(bySignature.get(record.signature) ?? []), record]);
  const review: DecisionShadowReview[] = [];
  for (const [signature, rows] of bySignature) {
    const lowConfidence = rows.filter((row) => row.shadow.status === "low-confidence").length;
    const cantTell = rows.filter((row) => row.shadow.status === "cant-tell").length;
    const disagreements = rows.filter(disagrees).length;
    if (rows.length >= 2 && (lowConfidence > 0 || cantTell > 0 || disagreements > 0))
      review.push({
        signature,
        pointId: rows[0]?.pointId ?? "",
        repeats: rows.length,
        lowConfidence,
        cantTell,
        disagreements,
      });
  }
  review.sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
  return {
    schemaVersion: 1,
    points,
    differing: records.filter(disagrees).slice(0, EXAMPLE_LIMIT),
    review,
  };
}
