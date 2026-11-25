import {
  type ArtifactStore,
  InspectedCommandNotFoundError,
  InspectedEventNotFoundError,
  isSnapshotCompatible,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  JournalReadIntegrityError,
  loadPartitionSnapshot,
  type PartitionReplayPorts,
  type ReplayStart,
  type RuntimeAuthorizationDenial,
  replayBirth,
  replayPartition,
  type StoredEvent,
  snapshotCompatibility,
} from "@clockgrove/application";
import {
  type CommandId,
  FLASHBACK_BOUNDS,
  type Flashback,
  type FlashbackActorState,
  type FlashbackContext,
  type FlashbackEntry,
  type FlashbackFrame,
  type FlashbackLine,
  type FlashbackReplay,
  type FlashbackRequest,
  type ObjectId,
  type PrincipalId,
  type RecordedWhy,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import {
  type WorldBehaviorPolicy,
  type WorldState,
  worldEventFeedCategory,
} from "@clockgrove/domain";
import {
  type HydratedWorldOwner,
  type PostgreSqlClient,
  PostgreSqlJournalRangeSource,
  PostgreSqlSnapshotStore,
  PostgreSqlWorldProvisioningStore,
} from "@clockgrove/persistence";
import type { CausalEntryInput } from "./inspector.js";
import {
  concernedObjectId,
  FEED_FALLBACKS,
  feedSentence,
  kernelPayloadOf,
  livingSceneOf,
  PostgreSqlLivingSceneReader,
  sceneProjectionOf,
} from "./observation.js";
import { decideSceneAudience } from "./scene-audience.js";
import type { ScenePresentationInput } from "./scene-presentation.js";
import { PostgreSqlCommandOwner } from "./world-commands.js";

/** A flashback's audited entry: an event or a command, and for a command the entity it follows. */
export type FlashbackInput = CausalEntryInput & { readonly objectId?: ObjectId };

/** The audited access a flashback's causes and moment come from (`PostgreSqlCausalInspector`). */
export interface FlashbackEvidenceSource {
  flashbackEvidence(
    input: CausalEntryInput,
    context: TrustedExecutionContext,
  ): Promise<{ readonly why: RecordedWhy; readonly events: readonly StoredEvent[] }>;
  deny(
    input: CausalEntryInput,
    principalId: PrincipalId,
    denial: RuntimeAuthorizationDenial | undefined,
  ): Promise<void>;
}

export interface FlashbackReaderOptions {
  readonly artifacts: ArtifactStore;
  readonly decodeResource: PartitionReplayPorts["decodeResource"];
  readonly presentations?: readonly ScenePresentationInput[];
}

/** One journal command's contiguous events in the window; its frame is the state after the last. */
interface CommandBlock {
  readonly commandId: CommandId;
  readonly events: readonly StoredEvent[];
  readonly end: bigint;
}

/** The closed public audience a replayed frame is projected for: no selection, cognition or actions. */
const REPLAY_AUDIENCE_FACTS = {
  categories: ["public_scene"],
  inspect: false,
  command: false,
} as const;

/**
 * A flashback (issue 273): the moment an event or command happened, rebuilt by deterministic replay
 * of the journal from the latest compatible snapshot at or below the window, with its recorded
 * context and causes. Read-only: it writes nothing but the inspector's audit rows, runs no model and
 * shows only journaled states, under the observer's own `public_scene` authorization.
 */
export class PostgreSqlFlashbackReader {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly evidence: FlashbackEvidenceSource,
    private readonly options: FlashbackReaderOptions,
  ) {}

  /** The Worker's audited port: an event or command entry, refused like Why when it is neither. */
  inspect(input: FlashbackInput, context: TrustedExecutionContext): Promise<Flashback> {
    const entry =
      "eventId" in input
        ? { eventId: input.eventId }
        : "commandId" in input
          ? {
              commandId: input.commandId,
              ...(input.objectId === undefined ? {} : { objectId: input.objectId }),
            }
          : undefined;
    if (entry === undefined) throw new RangeError("a flashback entry is an event or a command");
    return this.read({ version: 1, ...input.scope, ...entry }, context);
  }

  /** Records a refused access in the inspector audit, as Why does. */
  deny(
    input: CausalEntryInput,
    principalId: PrincipalId,
    denial: RuntimeAuthorizationDenial | undefined,
  ): Promise<void> {
    return this.evidence.deny(input, principalId, denial);
  }

  async read(request: FlashbackRequest, context: TrustedExecutionContext): Promise<Flashback> {
    const scope = {
      tenantId: request.tenantId,
      worldId: request.worldId,
      timelineId: request.timelineId,
      spaceId: request.spaceId,
    };
    const entry: FlashbackEntry =
      "eventId" in request ? { eventId: request.eventId } : { commandId: request.commandId };
    // The audited access checks the observe grant and the scope, and answers an unknown entry.
    const { why, events } = await this.evidence.flashbackEvidence(
      { scope, ...entry, includeResourceCauses: true },
      context,
    );
    const owner = new PostgreSqlCommandOwner(this.client);
    const { stored, authorization } = await new PostgreSqlLivingSceneReader(
      owner.reader,
    ).hydrateObserved(scope, context);
    const own = events
      .filter(
        (event) =>
          event.partitionId === stored.partitionId &&
          event.partitionSequence <= stored.coveredHeadSequence,
      )
      .toSorted((a, b) => (a.partitionSequence < b.partitionSequence ? -1 : 1));
    const last = own.at(-1);
    if (last === undefined)
      throw "eventId" in entry
        ? new InspectedEventNotFoundError(entry.eventId)
        : new InspectedCommandNotFoundError(entry.commandId);
    const entryEvent =
      "eventId" in entry ? own.find((event) => event.eventId === entry.eventId) : undefined;
    // A followed entity ("and before that…" for the same actor) wins over the command's first.
    const followed = "commandId" in request ? request.objectId : undefined;
    const objectId =
      followed ??
      (entryEvent === undefined ? null : concernedObjectId(entryEvent)) ??
      own.map(concernedObjectId).find((id) => id !== null) ??
      null;
    // The moment is the entry event itself; a command entry's moment is its last event.
    const momentEvent = entryEvent ?? last;
    const { policy } = await owner.behavior(authorization, scope);
    const dayLength = policy.environment?.dayLengthMs;
    const partitionScope = {
      tenantId: scope.tenantId,
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      partitionId: stored.partitionId,
    };
    const reader = new JournalRangeReader(
      new PostgreSqlJournalRangeSource(this.client, authorization),
      JOURNAL_EVENT_REGISTRY,
    );
    const ports = {
      events: reader,
      birth: new PostgreSqlWorldProvisioningStore(this.client),
      decodeResource: this.options.decodeResource,
      snapshots: new PostgreSqlSnapshotStore(this.client),
      artifacts: this.options.artifacts,
    };

    let replay: FlashbackReplay;
    let frames: FlashbackFrame[] = [];
    let momentState: { state: WorldState; sequence: bigint } | undefined;
    try {
      const window = await this.window(reader, partitionScope, stored, own[0]!, last);
      const momentIndex = window.blocks.findIndex((block) => block.end === last.partitionSequence);
      const selected = window.blocks.slice(
        Math.max(0, momentIndex - FLASHBACK_BOUNDS.framesBefore),
        momentIndex + FLASHBACK_BOUNDS.framesAfter + 1,
      );
      const first = selected[0]!;
      // The start covers no event to be shown: not past the first frame's end, nor past the moment
      // event when it lies inside its command (a cut command's block is the first, and a snapshot
      // at its end would already hold the events after the moment).
      const earliest =
        momentEvent.partitionSequence < first.end ? momentEvent.partitionSequence : first.end;
      const start = await this.start(authorization, partitionScope, stored, earliest, ports);
      if (start === undefined) replay = { status: "beyond-catch-up-bound" };
      else {
        // Past the start, replay stops `windowEvents` after `earliest`: a frame ending later (the
        // end of a command longer than the window, after an early moment event) is left out and the
        // replay says it was cut, so one flashback replays at most `catchUpEvents + windowEvents`.
        const limit = earliest + BigInt(FLASHBACK_BOUNDS.windowEvents);
        let cut = false;
        let reached: ReplayStart = start;
        let eventsReplayed = 0;
        const to = async (sequence: bigint) => {
          const result = await replayPartition(partitionScope, reached, sequence, ports);
          eventsReplayed += result.eventsApplied;
          reached = { state: result.state, coveredPartitionSequence: sequence };
          return result.state;
        };
        for (const block of selected) {
          const inBlock = block.commandId === momentEvent.commandId;
          // An event inside its command is shown at its own journaled sequence, then the command's end.
          if (inBlock && momentEvent.partitionSequence < block.end) {
            const state = await to(momentEvent.partitionSequence);
            momentState = { state, sequence: momentEvent.partitionSequence };
            frames.push(
              this.frame(
                stored,
                state,
                momentEvent.partitionSequence,
                block.commandId,
                [momentEvent.eventId],
                true,
                policy,
              ),
            );
          }
          if (block.end > limit) {
            cut = true;
            break;
          }
          const state = await to(block.end);
          const moment = inBlock && momentEvent.partitionSequence === block.end;
          if (moment) momentState = { state, sequence: block.end };
          frames.push(
            this.frame(
              stored,
              state,
              block.end,
              block.commandId,
              block.events.map((event) => event.eventId),
              moment,
              policy,
            ),
          );
        }
        replay = {
          status: "replayed",
          start: start.snapshotId ?? "birth",
          eventsReplayed,
          truncated: window.truncated || cut,
          positionsBetweenFrames: "not-recorded",
        };
      }
    } catch (error) {
      // A window event the observer may not read leaves a gap: never replay under a wider authority.
      if (!(error instanceof JournalReadIntegrityError && error.reason === "sequence-gap"))
        throw error;
      replay = { status: "not-visible" };
      frames = [];
      momentState = undefined;
    }

    const labels = new Map<string, string>();
    const contextView =
      momentState === undefined
        ? null
        : contextOf(scope, momentState.state, objectId, dayLength, labels);
    const nameOf = (id: string): string => labels.get(id) ?? id;
    const before = why.links.parents;
    return {
      version: 1,
      ...scope,
      privacyClass: "public_scene",
      entry,
      moment: {
        commandId: last.commandId,
        eventIds: own.map((event) => event.eventId),
        partitionSequence: momentEvent.partitionSequence.toString(),
        simulationTime: momentEvent.simulationTime.toString(),
        objectId,
      },
      bounds: FLASHBACK_BOUNDS,
      replay,
      frames,
      context: contextView,
      why,
      before,
      summary: summaryOf({
        own,
        entryEvent,
        objectId,
        why,
        replay,
        context: contextView,
        momentSequence: momentState?.sequence,
        momentTime: momentEvent.simulationTime,
        nameOf,
      }),
    };
  }

  /**
   * The command blocks of at most `windowEvents` partition events around the moment
   * (`flashbackWindowRange`). A block cut by the read's upper end is dropped, because its last event
   * read is not its command's last; the moment's own block always ends in the window.
   */
  private async window(
    reader: JournalRangeReader,
    partition: Parameters<JournalRangeReader["readPartition"]>[0],
    stored: HydratedWorldOwner,
    first: StoredEvent,
    last: StoredEvent,
  ): Promise<{ blocks: CommandBlock[]; truncated: boolean }> {
    const head = stored.coveredHeadSequence;
    const { from, to, cut } = flashbackWindowRange(
      first.partitionSequence,
      last.partitionSequence,
      head,
    );
    const read = await reader.readPartition(partition, { from, to });
    const blocks: { commandId: CommandId; events: StoredEvent[]; end: bigint }[] = [];
    for (const event of read) {
      const open = blocks.at(-1);
      if (open !== undefined && open.commandId === event.commandId) {
        open.events.push(event);
        open.end = event.partitionSequence;
      } else
        blocks.push({ commandId: event.commandId, events: [event], end: event.partitionSequence });
    }
    if (to < head && blocks.at(-1)?.end !== last.partitionSequence) blocks.pop();
    const momentIndex = blocks.findIndex((block) => block.end === last.partitionSequence);
    const truncated =
      cut ||
      (from > 1n && momentIndex < FLASHBACK_BOUNDS.framesBefore) ||
      (to < head && blocks.length - momentIndex - 1 < FLASHBACK_BOUNDS.framesAfter);
    return { blocks, truncated };
  }

  /**
   * The latest compatible snapshot at or below `target`, else the birth, when it lies within the
   * declared catch-up bound of `target`; undefined beyond it, so no distant moment replays from birth.
   */
  private async start(
    authorization: Parameters<typeof replayBirth>[0],
    scope: Parameters<typeof replayBirth>[1],
    stored: HydratedWorldOwner,
    target: bigint,
    ports: Parameters<typeof replayBirth>[2] & {
      snapshots: PostgreSqlSnapshotStore;
      artifacts: ArtifactStore;
    },
  ): Promise<ReplayStart | undefined> {
    const pack = stored.packContentHash;
    const since = target - BigInt(FLASHBACK_BOUNDS.catchUpEvents);
    // Newest first, only within the catch-up bound and at most `snapshotRefs` of them.
    const latest =
      pack === undefined
        ? undefined
        : (
            await ports.snapshots.listRecent(
              authorization,
              scope,
              target,
              since > 0n ? since : 0n,
              FLASHBACK_BOUNDS.snapshotRefs,
            )
          ).find(
            (ref) =>
              ref.coveredPartitionSequence <= target &&
              isSnapshotCompatible(ref.compatibility, snapshotCompatibility(pack)),
          );
    const covered = latest?.coveredPartitionSequence ?? 0n;
    if (target - covered > BigInt(FLASHBACK_BOUNDS.catchUpEvents)) return undefined;
    if (latest === undefined || pack === undefined) return replayBirth(authorization, scope, ports);
    const { document } = await loadPartitionSnapshot(authorization, latest, pack, ports);
    return {
      state: document.state,
      coveredPartitionSequence: latest.coveredPartitionSequence,
      snapshotId: latest.snapshotId,
    };
  }

  private frame(
    stored: HydratedWorldOwner,
    state: WorldState,
    sequence: bigint,
    commandId: CommandId,
    eventIds: readonly StoredEvent["eventId"][],
    moment: boolean,
    policy: WorldBehaviorPolicy,
  ): FlashbackFrame {
    const scope = {
      tenantId: state.tenantId,
      worldId: state.worldId,
      timelineId: state.timelineId,
      spaceId: stored.spaceId,
    };
    const decision = decideSceneAudience(
      state,
      {
        ...scope,
        privacyClass: "public_scene",
        interest: { selection: null, conversation: false, operator: false },
      },
      { ...REPLAY_AUDIENCE_FACTS, categories: [...REPLAY_AUDIENCE_FACTS.categories] },
    );
    return {
      partitionSequence: sequence.toString(),
      commandId,
      eventIds,
      moment,
      projection: sceneProjectionOf(
        stored,
        state,
        livingSceneOf(scope, state),
        decision,
        this.options.presentations ?? [],
        sequence,
        policy,
      ),
    };
  }
}

/**
 * The partition range a flashback reads (issue 273), at most `windowEvents` events: half the bound
 * before the moment command's first event, the command, and the rest of the bound after it. A
 * command longer than the rest is read from its tail, so the read never exceeds the bound; `cut`
 * says the command's start or the half before it was left out.
 */
export function flashbackWindowRange(
  first: bigint,
  last: bigint,
  head: bigint,
): { from: bigint; to: bigint; cut: boolean } {
  const size = BigInt(FLASHBACK_BOUNDS.windowEvents);
  const half = size / 2n;
  const wanted = first - half > 0n ? first - half : 1n;
  const span = last - first + 1n;
  const after = half - span > 0n ? half - span : 0n;
  const to = last + after < head ? last + after : head;
  // The command's end is kept; a longer command loses its earliest events, which replay still
  // applies from the start but which get no frame of their own.
  const from = wanted > to - size + 1n ? wanted : to - size + 1n;
  return { from, to, cut: from > wanted };
}

/** The replayed state at the moment: time, weather, who was in the space and the actor's state. */
function contextOf(
  scope: Parameters<typeof livingSceneOf>[0],
  state: WorldState,
  objectId: ObjectId | null,
  dayLength: bigint | undefined,
  labels: Map<string, string>,
): FlashbackContext {
  const scene = livingSceneOf(scope, state);
  for (const entity of scene.entities) labels.set(entity.objectId, entity.presentation.label);
  const time = state.simulationTime;
  const entity =
    objectId === null ? undefined : state.entities.find((item) => item.objectId === objectId);
  const wellbeing = state.wellbeing?.entries.find((entry) => entry.objectId === objectId);
  const actor: FlashbackActorState | null =
    entity === undefined || entity.spaceId !== scope.spaceId || !labels.has(entity.objectId)
      ? null
      : {
          objectId: entity.objectId,
          label: labels.get(entity.objectId) ?? entity.objectId,
          needs:
            entity.needs === undefined
              ? null
              : { hunger: entity.needs.hunger, wetness: entity.needs.wetness },
          wellbeing:
            wellbeing === undefined
              ? null
              : { thirst: wellbeing.thirst, health: wellbeing.health, comfort: wellbeing.comfort },
          selectedAction:
            entity.selectedAction === undefined
              ? null
              : {
                  kind: entity.selectedAction.kind,
                  targetObjectId: entity.selectedAction.targetObjectId ?? null,
                },
        };
  return {
    revision: state.revision.toString(),
    simulationTime: time.toString(),
    day: dayLength === undefined ? null : (time / dayLength + 1n).toString(),
    timeOfDayMs: dayLength === undefined ? null : (time % dayLength).toString(),
    rainIntensity: state.weather.rainIntensity,
    present: scene.entities.map((item) => ({
      objectId: item.objectId,
      label: item.presentation.label,
    })),
    actor,
  };
}

const words = (kind: string): string => kind.replaceAll("-", " ");

/**
 * A closed sentence for an actorless surface moment (issue 267): a repair names its stated reason
 * and what it removed, a band crossing the bands its channel moved into.
 */
function surfaceSentence(type: string, payload: Record<string, unknown>): string | undefined {
  const zone = String(payload.zoneId);
  if (type === "surface.repaired") {
    const removed = (Array.isArray(payload.removed) ? payload.removed : [])
      .filter((item: { amount?: unknown }) => typeof item.amount === "number" && item.amount > 0)
      .map((item: { channel?: unknown; amount?: unknown }) => `${item.amount} ${item.channel}`);
    return `${zone} was repaired (${words(String(payload.reason))})${removed.length === 0 ? "" : `, removing ${removed.join(" and ")}`}.`;
  }
  if (type === "surface.band-crossed" && Array.isArray(payload.bands)) {
    const bands = payload.bands.map(String);
    return `${zone}'s ${String(payload.channel)} ${bands.length === 0 ? "left every band" : `moved into ${bands.join(" and ")}`}.`;
  }
  return undefined;
}

/** Decision: at most eight event and eight decision sentences, so a busy step stays a short read. */
const SUMMARY_EVENTS = 8;

/**
 * The summary: closed sentence templates filled only from the replayed state, the moment's journal
 * events and the recorded Why, each citing what it used. A missing reason is said, never invented.
 */
function summaryOf(input: {
  readonly own: readonly StoredEvent[];
  readonly entryEvent: StoredEvent | undefined;
  readonly objectId: ObjectId | null;
  readonly why: RecordedWhy;
  readonly replay: FlashbackReplay;
  readonly context: FlashbackContext | null;
  readonly momentSequence: bigint | undefined;
  readonly momentTime: bigint;
  readonly nameOf: (objectId: string) => string;
}): FlashbackLine[] {
  const { own, why, replay, context, nameOf, entryEvent, objectId } = input;
  const lines: FlashbackLine[] = [];
  const sentence = (event: StoredEvent): FlashbackLine => {
    const category = worldEventFeedCategory(event.type);
    const payload = kernelPayloadOf(event) as Record<string, unknown> | undefined;
    return {
      kind: "context",
      text:
        event.type === "surface.interacted" && payload !== undefined
          ? `${nameOf(String(payload.actorId))} ${words(String(payload.interactionId))} on ${String(payload.zoneId)}${payload.mark === null ? "" : ", leaving a mark"}.`
          : event.type.startsWith("surface.") && payload !== undefined
            ? (surfaceSentence(event.type, payload) ??
              `A ${words(event.type.replaceAll(".", " "))} event was recorded.`)
            : category === undefined
              ? `A ${words(event.type.replaceAll(".", " "))} event was recorded.`
              : feedSentence(event.type, payload, FEED_FALLBACKS[category], nameOf),
      cites: [`event:${event.eventId}`],
    };
  };
  if (entryEvent !== undefined) lines.push(sentence(entryEvent));
  else {
    // A command's material events as the feed shows them, those about the moment's entity first.
    const shown = own.filter((event) => {
      if (worldEventFeedCategory(event.type) === undefined) return false;
      const payload = kernelPayloadOf(event) as Record<string, unknown> | undefined;
      return !(
        event.type === "resource.weather-integrated" &&
        payload?.collected === 0 &&
        payload?.evaporated === 0
      );
    });
    const about = shown.filter((event) => concernedObjectId(event) === objectId);
    const told = (about.length > 0 ? about : shown).slice(0, SUMMARY_EVENTS);
    lines.push(...told.map(sentence));
    if (shown.length > told.length)
      lines.push({
        kind: "context",
        text: `${shown.length - told.length} more recorded events happened in the same step.`,
        cites: [`command:${why.commandId}`],
      });
  }
  if (context !== null && input.momentSequence !== undefined) {
    const frame = [`frame:${input.momentSequence}`];
    const minutes =
      context.timeOfDayMs === null ? undefined : BigInt(context.timeOfDayMs) / 60_000n;
    lines.push({
      kind: "context",
      text:
        context.day === null || minutes === undefined
          ? `It was ${context.simulationTime} ms into the world.`
          : `It was day ${context.day}, ${minutes / 60n}:${(minutes % 60n).toString().padStart(2, "0")} into the day.`,
      cites: frame,
    });
    lines.push({
      kind: "context",
      text:
        context.rainIntensity > 0
          ? `It was raining (intensity ${context.rainIntensity} of 10000).`
          : "It was dry.",
      cites: frame,
    });
    if (context.present.length > 0)
      lines.push({
        kind: "context",
        text: `Present: ${context.present.map((item) => item.label).join(", ")}.`,
        cites: frame,
      });
    const actor = context.actor;
    if (actor !== null) {
      const state = [
        ...(actor.needs === null
          ? []
          : [`hunger ${actor.needs.hunger}`, `wetness ${actor.needs.wetness}`]),
        ...(actor.wellbeing === null
          ? []
          : [
              `thirst ${actor.wellbeing.thirst}`,
              `health ${actor.wellbeing.health}`,
              actor.wellbeing.comfort,
            ]),
      ];
      if (state.length > 0)
        lines.push({
          kind: "context",
          text: `${actor.label} had ${state.join(", ")}.`,
          cites: frame,
        });
    }
  }
  const recorded = why.traces.status === "available" ? why.traces.drafts : [];
  // Only the moment entity's own decisions and resource causes: another actor's choice in the same
  // step is not this moment's cause, so without its own the cause is unknown. A decision recorded
  // after the moment (a command spanning several decision intervals) is not its cause either; of
  // those at or before it, the latest eight are told, the ones nearest the moment.
  const mine = recorded.filter((draft) => draft.objectId === objectId);
  const prior = mine.filter((draft) => BigInt(draft.simulationTime) <= input.momentTime);
  const drafts = prior.slice(-SUMMARY_EVENTS);
  const causes = (why.resourceCauses ?? []).filter(
    (cause) => cause.objectId === objectId || cause.fromObjectId === objectId,
  );
  for (const draft of drafts) {
    const cite = [`draft:${why.commandId}#${draft.draftIndex}`];
    const action = draft.selectedAction;
    const chosen = draft.candidates.find(
      (candidate) =>
        candidate.excludedReason === null &&
        candidate.action.kind === action.kind &&
        candidate.action.targetObjectId === action.targetObjectId,
    );
    const others = draft.candidates.filter((candidate) => candidate !== chosen).length;
    lines.push({
      kind: "cause",
      text: `${nameOf(draft.objectId)} chose to ${words(action.kind)}${
        action.targetObjectId === null ? "" : ` at ${nameOf(action.targetObjectId)}`
      } (${draft.selectionTier}${chosen === undefined ? "" : `, score ${chosen.score}`}) over ${others} other option${others === 1 ? "" : "s"}.`,
      cites: cite,
    });
    if (chosen !== undefined && chosen.features.length > 0)
      lines.push({
        kind: "influence",
        text: `It weighed ${chosen.features.map((feature) => `${feature.name} ${feature.value}`).join(", ")}.`,
        cites: cite,
      });
  }
  const earlier = prior.length - drafts.length;
  const later = mine.length - prior.length;
  if (earlier > 0 || later > 0)
    lines.push({
      kind: "limit",
      text: [
        ...(earlier > 0
          ? [
              `${earlier} earlier decision${earlier === 1 ? "" : "s"} in the same step ${earlier === 1 ? "is" : "are"} not told.`,
            ]
          : []),
        ...(later > 0
          ? [
              `${later} decision${later === 1 ? "" : "s"} recorded after this moment ${later === 1 ? "is" : "are"} not ${later === 1 ? "its cause" : "its causes"}.`,
            ]
          : []),
      ].join(" "),
      cites: [`command:${why.commandId}`],
    });
  for (const cause of causes)
    lines.push({
      kind: "cause",
      text: `${cause.quantity} ${cause.kind} at ${nameOf(cause.objectId)} came from ${words(cause.cause)}${
        cause.fromObjectId === undefined ? "" : ` from ${nameOf(cause.fromObjectId)}`
      }.`,
      cites: [`event:${cause.eventId}`],
    });
  if (drafts.length === 0 && causes.length === 0)
    lines.push({
      kind: "unknown",
      text:
        why.traces.status !== "available"
          ? "The reason was not recorded; its cause is unknown."
          : objectId === null
            ? "No decision was recorded for this moment; its cause is unknown."
            : `No decision or resource cause was recorded for ${nameOf(objectId)} at this moment; its cause is unknown.`,
      cites: [`command:${why.commandId}`],
    });
  lines.push(
    why.links.parents.length === 0
      ? {
          kind: "limit",
          text: "The record goes back no further.",
          cites: [`command:${why.commandId}`],
        }
      : {
          kind: "cause",
          text: `Before that: ${why.links.parents.length} recorded cause${why.links.parents.length === 1 ? "" : "s"}.`,
          cites: why.links.parents.map((id) => `command:${id}`),
        },
  );
  lines.push({
    kind: "limit",
    text:
      replay.status === "replayed"
        ? `Only journaled states are shown; positions between them were not recorded.${
            replay.truncated
              ? ` The window was cut at ${FLASHBACK_BOUNDS.windowEvents} events.`
              : ""
          }`
        : replay.status === "beyond-catch-up-bound"
          ? `This moment is more than ${FLASHBACK_BOUNDS.catchUpEvents} events from a snapshot, so it is not replayed.`
          : "Part of this moment is not visible to you, so it is not replayed.",
    cites: [`command:${why.commandId}`],
  });
  return lines;
}
