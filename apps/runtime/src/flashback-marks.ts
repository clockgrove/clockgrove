import {
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  JournalReadIntegrityError,
  type StoredEvent,
} from "@clockgrove/application";
import {
  FLASHBACK_MARK_BOUNDS,
  type FlashbackMarkMoment,
  type FlashbackMarks,
  type FlashbackMarksRequest,
  type FlashbackMarkZone,
  type ObjectId,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import { type PostgreSqlClient, PostgreSqlJournalRangeSource } from "@clockgrove/persistence";
import { kernelPayloadOf, livingSceneOf, PostgreSqlLivingSceneReader } from "./observation.js";
import { PostgreSqlCommandOwner } from "./world-commands.js";

/**
 * The journaled moments that changed a surface's zones (issue 273, part 3): a bounded scan of the
 * partition's newest events under the observer's own `public_scene` authority, classified per zone.
 * Read-only; an object-hosted zone is listed only when its host is in the observed space's public scene.
 */
export class PostgreSqlFlashbackMarksReader {
  constructor(private readonly client: PostgreSqlClient) {}

  async read(
    request: FlashbackMarksRequest,
    context: TrustedExecutionContext,
  ): Promise<FlashbackMarks> {
    const scope = {
      tenantId: request.tenantId,
      worldId: request.worldId,
      timelineId: request.timelineId,
      spaceId: request.spaceId,
    };
    const target =
      "zoneId" in request
        ? { zoneId: request.zoneId }
        : "objectId" in request
          ? { objectId: request.objectId }
          : { regionId: request.regionId };
    const owner = new PostgreSqlCommandOwner(this.client);
    const { stored, authorization } = await new PostgreSqlLivingSceneReader(
      owner.reader,
    ).hydrateObserved(scope, context);
    const { policy } = await owner.behavior(authorization, scope);
    const present = new Set<string>(
      livingSceneOf(scope, stored.document.state).entities.map((entity) => entity.objectId),
    );
    const listed = (policy.surfaces?.zones ?? []).flatMap((zone, index) => {
      const matches =
        "zoneId" in request
          ? zone.id === request.zoneId
          : "objectId" in request
            ? zone.host.kind === "object" && zone.host.objectId === request.objectId
            : zone.host.kind === "region" && zone.host.regionId === request.regionId;
      const visible = zone.host.kind === "region" || present.has(zone.host.objectId);
      return matches && visible ? [{ zone, index }] : [];
    });
    const head = stored.coveredHeadSequence;
    const from =
      head > BigInt(FLASHBACK_MARK_BOUNDS.scanEvents)
        ? head - BigInt(FLASHBACK_MARK_BOUNDS.scanEvents) + 1n
        : 1n;
    const found = new Map<string, FlashbackMarkMoment[]>(listed.map(({ zone }) => [zone.id, []]));
    let status: FlashbackMarks["status"] = "read";
    if (listed.length > 0 && head > 0n) {
      const reader = new JournalRangeReader(
        new PostgreSqlJournalRangeSource(this.client, authorization),
        JOURNAL_EVENT_REGISTRY,
      );
      try {
        const events = await reader.readPartition(
          {
            tenantId: scope.tenantId,
            timelineId: scope.timelineId,
            partitionId: stored.partitionId,
          },
          { from, to: head },
        );
        for (const event of events.toSorted((a, b) =>
          a.partitionSequence < b.partitionSequence ? 1 : -1,
        ))
          for (const [zoneId, moment] of momentsOf(event)) found.get(zoneId)?.push(moment);
      } catch (error) {
        // An event the observer may not read leaves a gap: list no moment rather than a partial one.
        if (!(error instanceof JournalReadIntegrityError && error.reason === "sequence-gap"))
          throw error;
        status = "not-visible";
        for (const moments of found.values()) moments.length = 0;
      }
    }
    const zones: FlashbackMarkZone[] = listed.map(({ zone, index }) => {
      const all = found.get(zone.id)!;
      return {
        zoneId: zone.id,
        host: zone.host,
        marks: stored.document.state.surfaces?.zones[index]?.marks.length ?? 0,
        moments: all.slice(0, FLASHBACK_MARK_BOUNDS.moments),
        more: Math.max(0, all.length - FLASHBACK_MARK_BOUNDS.moments),
      };
    });
    return {
      version: 1,
      ...scope,
      privacyClass: "public_scene",
      target,
      bounds: FLASHBACK_MARK_BOUNDS,
      status,
      scanned:
        listed.length === 0 || head === 0n ? null : { from: from.toString(), to: head.toString() },
      reachesStart: listed.length === 0 || from === 1n,
      zones,
    };
  }
}

interface Traffic {
  readonly zoneId: string;
  readonly interactionId: string;
  readonly mark: unknown;
}

/** The zones one journal event changed, each with its moment. */
function momentsOf(event: StoredEvent): [string, FlashbackMarkMoment][] {
  const payload = kernelPayloadOf(event) as Record<string, unknown> | undefined;
  if (payload === undefined) return [];
  const moment = (
    zoneId: unknown,
    kind: FlashbackMarkMoment["kind"],
    actorId: unknown,
    interactionId: unknown,
    mark: unknown,
  ): [string, FlashbackMarkMoment] => [
    String(zoneId),
    {
      eventId: event.eventId,
      commandId: event.commandId,
      partitionSequence: event.partitionSequence.toString(),
      simulationTime: event.simulationTime.toString(),
      kind,
      actorId: typeof actorId === "string" ? (actorId as ObjectId) : null,
      interactionId: typeof interactionId === "string" ? interactionId : null,
      leftMark: mark !== null && mark !== undefined,
    },
  ];
  switch (event.type) {
    case "surface.interacted":
      return [
        moment(payload.zoneId, "interacted", payload.actorId, payload.interactionId, payload.mark),
      ];
    case "surface.band-crossed":
      return [moment(payload.zoneId, "band-crossed", null, null, null)];
    case "surface.repaired":
      return [moment(payload.zoneId, "repaired", null, null, null)];
    case "movement.region-entered":
      return Array.isArray(payload.surfaces)
        ? (payload.surfaces as Traffic[]).map((entry) =>
            moment(entry.zoneId, "worn", payload.objectId, entry.interactionId, entry.mark),
          )
        : [];
    default:
      return [];
  }
}
