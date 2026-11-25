import {
  AuthorizationRefusedError,
  isSnapshotCompatible,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  JournalReadIntegrityError,
  JournalRouteNotFoundError,
  NO_PRIVACY_CEILING,
  type ProjectionReplayPorts,
  ReplayIntegrityError,
  type RuntimeAuthorizationDenial,
  replayToSequence,
  snapshotCompatibility,
} from "@clockgrove/application";
import { ContractDecodeError, decodeBrowserScope, type PrincipalId } from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import {
  type InspectorAccess,
  type PostgreSqlClient,
  PostgreSqlInspectorAudit,
  PostgreSqlJournalRangeSource,
  PostgreSqlObjectHistoryReader,
  PostgreSqlRuntimeStateReader,
  PostgreSqlSnapshotStore,
} from "@clockgrove/persistence";
import { INSPECT_GRANT } from "./inspector.js";
import type { RuntimeScope } from "./types.js";
import { assertWorldCommandContext, worldAuthorization } from "./world-commands.js";

/** The journal inspection's route (`docs/protocols/living-yard-observation.md`). */
export const JOURNAL_ROUTES = ["/v1/runtime/journal"] as const;

/**
 * Strict `{ schemaVersion: 1, tenantId, worldId, timelineId, spaceId }` plus, optionally,
 * `beforeSequence` (a page cursor) and `replayTo` (a partition sequence to replay to), each a
 * positive decimal string.
 */
export interface JournalInput {
  readonly scope: RuntimeScope;
  readonly beforeSequence?: bigint;
  readonly replayTo?: bigint;
}

/** One journal event and its recorded cause, as the envelope holds them; no payload. */
export interface JournalEventRow {
  readonly eventId: string;
  readonly type: string;
  readonly partitionSequence: string;
  readonly simulationTime: string;
  readonly recordedAt: string;
  readonly privacyClass: string;
  readonly commandId: string;
  readonly causationId: string | null;
  readonly effectiveActorId: string;
  readonly causalRootActionId: string;
  readonly ruleFiringId: string | null;
  readonly decisionTraceId: string | null;
}

/** The world as replay rebuilt it at `to`, from its birth or a snapshot; public scene fields only. */
export type JournalReplay =
  | {
      readonly status: "replayed";
      readonly to: string;
      readonly start: string;
      readonly eventsApplied: number;
      readonly stateHash: string;
      readonly revision: string;
      readonly simulationTime: string;
      readonly rainIntensity: number;
      /** Present when `to` is the projection's covered head: whether replay reproduced it. */
      readonly matchesLive?: boolean;
      readonly entities: readonly {
        readonly objectId: string;
        readonly locationId: string | null;
        readonly selectedAction: string | null;
      }[];
    }
  | { readonly status: "unavailable"; readonly to: string; readonly reason: string };

export interface JournalPage {
  readonly schemaVersion: 1;
  readonly journalHead: string;
  /** Newest first: every event of one window of partition positions the caller may read. */
  readonly events: readonly JournalEventRow[];
  /** The cursor of the next older window, or null at the start of the journal. */
  readonly beforeSequence: string | null;
  readonly replay?: JournalReplay;
}

/**
 * Decision: one replay folds at most 2,000 events past its start, the snapshot sweep's interval
 * (`SNAPSHOT_INTERVAL_EVENTS`, cloudflare-entry.ts) and one replay page (`REPLAY_PAGE`,
 * partition-replay.ts). Where the sweep runs, every position is within it of a snapshot; where it
 * does not (the local hosts run no Cron Trigger), a position further from birth is unavailable
 * instead of a fold of the whole journal in one request.
 */
const REPLAY_LIMIT_EVENTS = 2_000n;

const KEYS = ["schemaVersion", "tenantId", "worldId", "timelineId", "spaceId"];
const OPTIONAL = ["beforeSequence", "replayTo"];

function sequence(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value))
    throw new ContractDecodeError(path, "positive decimal string required");
  return BigInt(value);
}

export function decodeJournalInput(value: unknown): JournalInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ContractDecodeError("request", "object required");
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    !KEYS.every((key) => key in input) ||
    !Object.keys(input).every((key) => KEYS.includes(key) || OPTIONAL.includes(key))
  )
    throw new ContractDecodeError("request", "invalid envelope");
  const scope = decodeBrowserScope({
    tenantId: input.tenantId,
    worldId: input.worldId,
    timelineId: input.timelineId,
    spaceId: input.spaceId,
  });
  return {
    scope,
    ...(input.beforeSequence === undefined
      ? {}
      : { beforeSequence: sequence(input.beforeSequence, "request.beforeSequence") }),
    ...(input.replayTo === undefined
      ? {}
      : { replayTo: sequence(input.replayTo, "request.replayTo") }),
  };
}

/**
 * The world debugger's journal (issue 327): one window of the space's journal, newest first, every
 * event type the caller's ceiling may read, each with the cause its envelope records; and, on
 * request, a replay to one journal position. The causal chain's `runtime:world-inspect` grant and
 * `operator_evidence` ceiling, rate limit and audit, with subject `journal`. Reads under the
 * caller's own authority, so a row above its ceiling is absent and a replay across one is
 * unavailable; it writes nothing but the audit row.
 */
export class PostgreSqlJournalInspector {
  private readonly audit: PostgreSqlInspectorAudit;
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly replayPorts: ProjectionReplayPorts,
  ) {
    this.audit = new PostgreSqlInspectorAudit(client);
  }

  async inspect(input: JournalInput, context: TrustedExecutionContext): Promise<JournalPage> {
    try {
      assertWorldCommandContext(context, input.scope, INSPECT_GRANT);
      if (!context.privacyCeiling.allowedCategories.includes("operator_evidence"))
        throw new AuthorizationRefusedError("inspection ceiling refused");
    } catch (error) {
      await this.deny(input, context.principalId, undefined);
      throw error;
    }
    const authorization = worldAuthorization(context);
    await this.audit.admit(authorization);
    let reasonCode: InspectorAccess["reasonCode"] = "failed";
    try {
      const { placement } = await new PostgreSqlRuntimeStateReader(this.client).read(
        authorization,
        input.scope,
      );
      const partition = {
        tenantId: input.scope.tenantId,
        worldId: input.scope.worldId,
        timelineId: input.scope.timelineId,
        partitionId: placement.partitionId,
      };
      const head = placement.journalHead;
      const before =
        input.beforeSequence === undefined || input.beforeSequence > head + 1n
          ? head + 1n
          : input.beforeSequence;
      const window = await new PostgreSqlObjectHistoryReader(this.client).read(
        authorization,
        partition,
        before,
      );
      const replay =
        input.replayTo === undefined
          ? undefined
          : await this.replay(
              authorization,
              partition,
              input.scope.spaceId,
              input.replayTo,
              placement,
            );
      reasonCode = "served";
      return {
        schemaVersion: 1,
        journalHead: head.toString(),
        events: window.events.map((event) => ({
          eventId: event.eventId,
          type: event.type,
          partitionSequence: event.partitionSequence.toString(),
          simulationTime: event.simulationTime.toString(),
          recordedAt: event.recordedAt,
          privacyClass: event.privacyClass,
          commandId: event.commandId,
          causationId: event.causationId ?? null,
          effectiveActorId: event.attribution.effectiveActorId,
          causalRootActionId: event.attribution.causalRootActionId,
          ruleFiringId: event.ruleFiringId ?? null,
          decisionTraceId: event.decisionTraceId ?? null,
        })),
        beforeSequence: window.beforeSequence?.toString() ?? null,
        ...(replay === undefined ? {} : { replay }),
      };
    } catch (error) {
      if (error instanceof JournalRouteNotFoundError) reasonCode = "not-found";
      throw error;
    } finally {
      await this.audit.record(authorization, access(input, "allow", reasonCode));
    }
  }

  /** Records a refused access under the requested tenant, whether or not the principal is a member. */
  deny(
    input: JournalInput,
    principalId: PrincipalId,
    denial: RuntimeAuthorizationDenial | undefined,
  ): Promise<void> {
    return this.audit.record(
      { tenantId: input.scope.tenantId, principalId, privacyCeiling: NO_PRIVACY_CEILING },
      access(input, "deny", denial?.reasonCode ?? "authority-mismatch"),
    );
  }

  private async replay(
    authorization: ReturnType<typeof worldAuthorization>,
    partition: Parameters<typeof replayToSequence>[1],
    spaceId: string,
    to: bigint,
    placement: { readonly coveredHeadSequence: bigint },
  ): Promise<JournalReplay> {
    const unavailable = (reason: string): JournalReplay => ({
      status: "unavailable",
      to: to.toString(),
      reason,
    });
    if (to > placement.coveredHeadSequence)
      return unavailable("past the projection's covered head");
    const snapshots = this.replayPorts.snapshots;
    const committed = await snapshots.readCommitted(authorization, partition);
    if (committed === undefined) return unavailable("no committed state readable");
    const compatibility = snapshotCompatibility(committed.packContentHash);
    const start =
      (await snapshots.list(authorization, partition, to)).findLast((ref) =>
        isSnapshotCompatible(ref.compatibility, compatibility),
      )?.coveredPartitionSequence ?? 0n;
    if (to - start > REPLAY_LIMIT_EVENTS)
      return unavailable(
        `${to - start} events past ${start === 0n ? "the world's birth" : `the snapshot at #${start}`}; a replay folds at most ${REPLAY_LIMIT_EVENTS} events and no snapshot is nearer`,
      );
    try {
      const replayed = await replayToSequence(
        authorization,
        partition,
        to,
        committed.packContentHash,
        {
          ...this.replayPorts,
          events: new JournalRangeReader(
            new PostgreSqlJournalRangeSource(this.client, authorization),
            JOURNAL_EVENT_REGISTRY,
          ),
        },
      );
      const { state } = replayed;
      return {
        status: "replayed",
        to: to.toString(),
        start: replayed.start,
        eventsApplied: replayed.eventsApplied,
        stateHash: replayed.stateHash,
        revision: state.revision.toString(),
        simulationTime: state.simulationTime.toString(),
        rainIntensity: state.weather.rainIntensity,
        ...(to === committed.coveredPartitionSequence
          ? { matchesLive: replayed.stateHash === committed.stored.stateHash }
          : {}),
        entities: state.entities
          .filter((entity) => entity.spaceId === spaceId)
          .map((entity) => ({
            objectId: entity.objectId,
            locationId: entity.locationId ?? null,
            selectedAction:
              entity.selectedAction === undefined
                ? null
                : `${entity.selectedAction.kind} → ${entity.selectedAction.targetObjectId ?? "None"}`,
          })),
      };
    } catch (error) {
      // A row above the caller's ceiling is a gap to its reader, so only a gap may be the ceiling;
      // every other reason is a damaged journal or an unregistered event, and says so.
      if (error instanceof JournalReadIntegrityError)
        return unavailable(
          error.reason === "sequence-gap"
            ? "journal sequence-gap: an event above your privacy ceiling, or a missing one"
            : `journal integrity failure (${error.reason})`,
        );
      if (error instanceof ReplayIntegrityError) return unavailable(`replay ${error.reason}`);
      throw error;
    }
  }
}

/** The snapshot store a journal replay starts from; the rest comes from the caller. */
export function journalReplayPorts(
  client: PostgreSqlClient,
  ports: Omit<ProjectionReplayPorts, "snapshots">,
): ProjectionReplayPorts {
  return { ...ports, snapshots: new PostgreSqlSnapshotStore(client) };
}

function access(
  input: JournalInput,
  decision: InspectorAccess["decision"],
  reasonCode: InspectorAccess["reasonCode"],
): InspectorAccess {
  const { worldId, timelineId, spaceId } = input.scope;
  return { subject: "journal", worldId, timelineId, spaceId, decision, reasonCode };
}
