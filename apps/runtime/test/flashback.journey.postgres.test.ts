import {
  createPartitionSnapshot,
  decodeCanonicalNode,
  executeWorldCommand,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  replayBirth,
  replayPartition,
} from "@clockgrove/application";
import {
  ContractDecodeError,
  decodeFlashback,
  decodeOpaqueId,
  FLASHBACK_BOUNDS,
  type Flashback,
} from "@clockgrove/contracts";
import {
  PostgreSqlArtifactStore,
  PostgreSqlJournalRangeSource,
  PostgreSqlSnapshotStore,
  PostgreSqlWorldCommandJournal,
  PostgreSqlWorldProvisioningStore,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { expect, it, vi } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { flashbackWindowRange, PostgreSqlFlashbackReader } from "../src/flashback.js";
import { PostgreSqlCausalInspector } from "../src/inspector.js";
import { livingSceneOf } from "../src/observation.js";
import { RuntimeWorker } from "../src/worker.js";
import { livingHallAuthentication } from "./living-hall-fixture.js";
import {
  advanceCommand,
  commandRequest,
  type DatabaseFixture,
  provisionTestWorld,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

it("replays a past moment read-only from a snapshot, with cited context and causes, chains to its causes and refuses what the observer may not see", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-flashback");
    const auth = livingHallAuthentication(provisioned);
    const truth = truthOf(fixture);
    await withClient(fixture.environment, async (client) => {
      const journal = new PostgreSqlWorldCommandJournal(client);
      const step = world.behavior.policy.decisionIntervalMs;
      const advance = async (n: number) =>
        expect(
          (
            await executeWorldCommand(
              commandRequest(
                provisioned,
                advanceCommand(
                  world,
                  `flashback-${n}`,
                  world.birth.state.simulationTime + step * BigInt(n),
                  null,
                ),
              ),
              { journal, behavior: provisioned.behavior },
            )
          ).outcome,
        ).toBe("committed");
      const partition = {
        ...provisioned.partition.target,
        partitionId: provisioned.partition.route.partitionId,
      };
      const artifacts = new PostgreSqlArtifactStore(client);
      await advance(1);
      const snapshot = await createPartitionSnapshot(provisioned.authorization, partition, {
        snapshots: new PostgreSqlSnapshotStore(client),
        artifacts,
      });
      for (let n = 2; n <= 11; n += 1) await advance(n);

      const inspector = new PostgreSqlCausalInspector(client);
      const flashbackReader = new PostgreSqlFlashbackReader(client, inspector, {
        artifacts,
        decodeResource,
      });
      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("a flashback cannot route a command");
        },
        flashback: flashbackReader,
      });
      const post = (fields: object) =>
        worker.fetch(
          new Request("http://local.test/v1/runtime/flashback", {
            method: "POST",
            headers: { authorization: "Bearer hall-inspect", "content-type": "application/json" },
            body: JSON.stringify({ version: 1, ...auth.scope, ...fields }),
          }),
        );
      const read = async (fields: object): Promise<Flashback> => {
        const response = await post(fields);
        expect(response.status).toBe(200);
        return decodeFlashback(await response.json());
      };
      const canonical =
        "SELECT jsonb_build_object('state',(SELECT jsonb_agg(to_jsonb(s) ORDER BY partition_id) FROM clockgrove.partition_states s),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM clockgrove.command_receipts r),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM clockgrove.events e),'schedules',(SELECT jsonb_agg(to_jsonb(q) ORDER BY schedule_id,idempotency_key) FROM clockgrove.partition_schedules q),'snapshots',(SELECT jsonb_agg(to_jsonb(n) ORDER BY snapshot_id) FROM clockgrove.snapshots n))::text";
      const before = await truth(canonical);

      // The moment: a feed-worthy routine choice of the tenth advance.
      const eventId = await truth(
        "SELECT event_id FROM clockgrove.events WHERE command_id = 'flashback-10' AND event_type = 'routine.selected' ORDER BY partition_sequence LIMIT 1",
      );
      const flashback = await read({ eventId });
      expect(flashback.entry).toEqual({ eventId });
      expect(flashback.moment.commandId).toBe("flashback-10");
      expect(flashback.replay).toEqual({
        status: "replayed",
        start: snapshot.snapshotId,
        eventsReplayed: expect.any(Number),
        truncated: false,
        positionsBetweenFrames: "not-recorded",
      });
      // One frame per journaled command, eight before the moment's and the one after, plus the
      // moment itself at its own event inside its command.
      const commands = (
        await truth(
          "SELECT string_agg(command_id, ',' ORDER BY last) FROM (SELECT command_id, max(partition_sequence) AS last FROM clockgrove.events WHERE partition_sequence > (SELECT max(partition_sequence) FROM clockgrove.events WHERE command_id = 'flashback-1') GROUP BY command_id) AS c",
        )
      ).split(",");
      const moment = commands.indexOf("flashback-10");
      expect(flashback.frames.map((frame) => frame.commandId)).toEqual([
        ...commands.slice(moment - 8, moment),
        "flashback-10",
        ...commands.slice(moment, moment + 2),
      ]);
      expect(flashback.frames.find((frame) => frame.moment)).toMatchObject({
        partitionSequence: await truth(
          `SELECT partition_sequence FROM clockgrove.events WHERE event_id = '${eventId}'`,
        ),
        eventIds: [eventId],
      });
      expect(flashback.frames.filter((frame) => frame.moment).map((f) => f.commandId)).toEqual([
        "flashback-10",
      ]);

      // Each frame is the state a full replay from the stored birth reaches at that sequence.
      const reader = new JournalRangeReader(
        new PostgreSqlJournalRangeSource(client, provisioned.authorization),
        JOURNAL_EVENT_REGISTRY,
      );
      const ports = {
        events: reader,
        birth: new PostgreSqlWorldProvisioningStore(client),
        decodeResource,
      };
      let reached = await replayBirth(provisioned.authorization, partition, ports);
      let atMoment: Awaited<ReturnType<typeof replayPartition>>["state"] | undefined;
      for (const frame of flashback.frames) {
        const replayed = await replayPartition(
          partition,
          reached,
          BigInt(frame.partitionSequence),
          ports,
        );
        reached = {
          state: replayed.state,
          coveredPartitionSequence: BigInt(frame.partitionSequence),
        };
        if (frame.moment) atMoment = replayed.state;
        const scene = livingSceneOf(auth.scope, replayed.state);
        expect([frame.projection.revision, frame.projection.simulationTime]).toEqual([
          replayed.state.revision,
          replayed.state.simulationTime,
        ]);
        expect(JSON.parse(JSON.stringify(frame.projection.entities))).toEqual(scene.entities);
      }
      // The last frame is the live head the stored projection covers.
      expect(flashback.frames.at(-1)!.projection.revision.toString()).toBe(
        await truth("SELECT revision FROM clockgrove.partition_states"),
      );

      // Context comes from the moment's replayed state; every summary line cites the record.
      const momentFrame = flashback.frames.find((frame) => frame.moment)!;
      expect(flashback.context?.revision).toBe(momentFrame.projection.revision.toString());
      expect(flashback.context?.present.map((entity) => entity.objectId)).toEqual(
        momentFrame.projection.entities.map((entity) => entity.objectId),
      );
      // Exact values: the context is the independently replayed moment state, and the cause and
      // influence lines are the actor's retained draft of the moment's command, read from its receipt.
      const actorId = flashback.moment.objectId!;
      const state = atMoment!;
      const dayLength = world.behavior.policy.environment?.dayLengthMs;
      expect(dayLength).toBeDefined();
      const time = state.simulationTime;
      const momentScene = livingSceneOf(auth.scope, state);
      const label = (id: string) =>
        momentScene.entities.find((entity) => entity.objectId === id)?.presentation.label ?? id;
      const entity = state.entities.find((item) => item.objectId === actorId)!;
      const wellbeing = state.wellbeing?.entries.find((entry) => entry.objectId === actorId);
      expect(flashback.context).toEqual({
        revision: state.revision.toString(),
        simulationTime: time.toString(),
        day: (time / dayLength! + 1n).toString(),
        timeOfDayMs: (time % dayLength!).toString(),
        rainIntensity: state.weather.rainIntensity,
        present: momentScene.entities.map((item) => ({
          objectId: item.objectId,
          label: item.presentation.label,
        })),
        actor: {
          objectId: actorId,
          label: label(actorId),
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
        },
      });
      const minutes = (time % dayLength!) / 60_000n;
      const frameCite = [`frame:${momentFrame.partitionSequence}`];
      const actorState = [
        ...(entity.needs === undefined
          ? []
          : [`hunger ${entity.needs.hunger}`, `wetness ${entity.needs.wetness}`]),
        ...(wellbeing === undefined
          ? []
          : [`thirst ${wellbeing.thirst}`, `health ${wellbeing.health}`, wellbeing.comfort]),
      ];
      expect(flashback.summary).toEqual(
        expect.arrayContaining([
          {
            kind: "context",
            text: `It was day ${time / dayLength! + 1n}, ${minutes / 60n}:${(minutes % 60n).toString().padStart(2, "0")} into the day.`,
            cites: frameCite,
          },
          {
            kind: "context",
            text:
              state.weather.rainIntensity > 0
                ? `It was raining (intensity ${state.weather.rainIntensity} of 10000).`
                : "It was dry.",
            cites: frameCite,
          },
          {
            kind: "context",
            text: `Present: ${momentScene.entities.map((item) => item.presentation.label).join(", ")}.`,
            cites: frameCite,
          },
          ...(actorState.length === 0
            ? []
            : [
                {
                  kind: "context",
                  text: `${label(actorId)} had ${actorState.join(", ")}.`,
                  cites: frameCite,
                },
              ]),
        ]),
      );
      // The receipt's retained drafts: the actor's, recorded at or before the moment, are its causes.
      type RetainedCandidate = {
        readonly action: { readonly kind: string; readonly targetObjectId?: string };
        readonly features: Readonly<Record<string, bigint>>;
        readonly score: bigint;
        readonly excludedReason?: string | null;
      };
      type RetainedDraft = {
        readonly decision: {
          readonly objectId: string;
          readonly simulationTime: bigint;
          readonly selectionTier: string;
          readonly selectedAction: { readonly kind: string; readonly targetObjectId?: string };
          readonly candidates: readonly RetainedCandidate[];
        };
      };
      const retained = (
        decodeCanonicalNode(
          JSON.parse(
            await truth(
              "SELECT result->'projectionDelta'->'decisionTraces'->'drafts' FROM clockgrove.command_receipts WHERE command_id = 'flashback-10'",
            ),
          ),
        ) as readonly RetainedDraft[]
      )
        .map((draft, index) => ({ draft: draft.decision, index }))
        .filter(
          ({ draft }) =>
            draft.objectId === actorId &&
            draft.simulationTime <= BigInt(flashback.moment.simulationTime),
        );
      expect(retained.length).toBeGreaterThan(0);
      const expectedCauses = retained.flatMap(({ draft, index }) => {
        const cites = [`draft:flashback-10#${index}`];
        const action = draft.selectedAction;
        const chosen = draft.candidates.find(
          (candidate) =>
            (candidate.excludedReason ?? null) === null &&
            candidate.action.kind === action.kind &&
            (candidate.action.targetObjectId ?? null) === (action.targetObjectId ?? null),
        );
        const others = draft.candidates.filter((candidate) => candidate !== chosen).length;
        const features = Object.entries(chosen?.features ?? {});
        return [
          {
            kind: "cause",
            text: `${label(draft.objectId)} chose to ${action.kind.replaceAll("-", " ")}${
              action.targetObjectId === undefined ? "" : ` at ${label(action.targetObjectId)}`
            } (${draft.selectionTier}${chosen === undefined ? "" : `, score ${chosen.score}`}) over ${others} other option${others === 1 ? "" : "s"}.`,
            cites,
          },
          ...(features.length === 0
            ? []
            : [
                {
                  kind: "influence",
                  text: `It weighed ${features.map(([name, value]) => `${name} ${value}`).join(", ")}.`,
                  cites,
                },
              ]),
        ];
      });
      expect(
        flashback.summary.filter((line) => line.cites.some((cite) => cite.startsWith("draft:"))),
      ).toEqual(expectedCauses);
      // Causes are the moment entity's own: another entity of the same step, which decided nothing
      // there, gets no borrowed reason, only "unknown".
      const actor = flashback.moment.objectId!;
      const drafted = new Set(
        flashback.why.traces.status === "available"
          ? flashback.why.traces.drafts.map((draft) => draft.objectId)
          : [],
      );
      const bystander = flashback.context!.present.find((item) => !drafted.has(item.objectId))!;
      const unrelated = await read({ commandId: "flashback-10", objectId: bystander.objectId });
      expect(unrelated.moment.objectId).toBe(bystander.objectId);
      expect(unrelated.summary.filter((line) => line.kind === "unknown")).toHaveLength(1);
      expect(
        unrelated.summary.flatMap((line) => line.cites).filter((c) => c.startsWith("draft:")),
      ).toEqual([]);
      for (const line of flashback.summary) {
        expect(line.cites.length).toBeGreaterThan(0);
        for (const cite of line.cites) {
          const [kind, id] = [cite.slice(0, cite.indexOf(":")), cite.slice(cite.indexOf(":") + 1)];
          if (kind === "frame")
            expect(flashback.frames.map((frame) => frame.partitionSequence)).toContain(id);
          else if (kind === "event")
            expect(
              await truth(`SELECT count(*) FROM clockgrove.events WHERE event_id = '${id}'`),
            ).toBe("1");
          else if (kind === "command")
            expect(
              await truth(
                `SELECT count(*) FROM clockgrove.command_receipts WHERE command_id = '${id}'`,
              ),
            ).toBe("1");
          else {
            expect(kind).toBe("draft");
            const [command, index] = id.split("#");
            const drafts = decodeCanonicalNode(
              JSON.parse(
                await truth(
                  `SELECT result->'projectionDelta'->'decisionTraces'->'drafts' FROM clockgrove.command_receipts WHERE command_id = '${command}'`,
                ),
              ),
            ) as readonly unknown[];
            expect(drafts.length).toBeGreaterThan(Number(index));
            expect(
              flashback.why.traces.status === "available" &&
                flashback.why.traces.drafts.find((draft) => `${draft.draftIndex}` === index)
                  ?.objectId,
            ).toBe(actor);
          }
        }
      }

      // "And before that…": each cause is a further flashback following the same actor, until the
      // record goes no further.
      let chained = flashback;
      const walked: string[] = [];
      while (chained.before.length > 0 && walked.length < 16) {
        chained = await read({ commandId: chained.before[0], objectId: chained.moment.objectId });
        walked.push(chained.moment.commandId);
        expect(chained.moment.objectId).toBe(actor);
        if (chained.context?.actor) expect(chained.context.actor.objectId).toBe(actor);
        const drafts = chained.why.traces.status === "available" ? chained.why.traces.drafts : [];
        const cited = chained.summary
          .flatMap((line) => line.cites)
          .filter((cite) => cite.startsWith("draft:"))
          .map((cite) => drafts.find((draft) => `${draft.draftIndex}` === cite.split("#")[1]));
        for (const draft of cited) expect(draft?.objectId).toBe(actor);
        const ownCauses = (chained.why.resourceCauses ?? []).filter(
          (cause) => cause.objectId === actor || cause.fromObjectId === actor,
        );
        if (!drafts.some((draft) => draft.objectId === actor) && ownCauses.length === 0)
          expect(chained.summary.map((line) => line.kind)).toContain("unknown");
      }
      expect(walked.length).toBeGreaterThan(0);
      expect(chained.before).toEqual([]);
      expect(chained.summary.map((line) => line.kind)).toContain("unknown");
      expect(chained.summary.at(-2)).toMatchObject({
        kind: "limit",
        text: "The record goes back no further.",
      });

      // Nothing canonical changed: the flashbacks wrote only inspector audit rows.
      expect(await truth(canonical)).toBe(before);

      // Unknown entries and a caller without the observe grant are refused by their stable codes.
      const unknown = await post({ eventId: "no-such-event" });
      expect([unknown.status, await unknown.json()]).toEqual([404, { error: "event_not_found" }]);
      const foreign = await post({ commandId: decodeOpaqueId("no-such-command", "CommandId") });
      expect([foreign.status, await foreign.json()]).toEqual([404, { error: "command_not_found" }]);
      // A producer defect after the request decoded (a reader or encoder decode error) is the
      // server's failure, never the caller's invalid request.
      for (const failure of [
        new ContractDecodeError("retained", "PRIVATE-INTERNAL-DEFECT"),
        new SyntaxError("PRIVATE-INTERNAL-DEFECT"),
      ]) {
        const seam = vi.spyOn(flashbackReader, "inspect").mockRejectedValueOnce(failure);
        try {
          const failed = await post({ eventId });
          expect([failed.status, await failed.json()]).toEqual([
            500,
            { error: "inspection_failed" },
          ]);
        } finally {
          seam.mockRestore();
        }
      }
      auth.revoke();
      const refused = await post({ eventId });
      expect([refused.status, await refused.json()]).toEqual([
        403,
        { error: "authorization_refused" },
      ]);
    });
  });
}, 300_000);

// The window read the journey's fixture never stretches: a command longer than the bound.
it("reads at most the declared window around a flashback's moment, and says when a long command was cut", () => {
  const size = BigInt(FLASHBACK_BOUNDS.windowEvents);
  const span = (range: { from: bigint; to: bigint }) => range.to - range.from + 1n;
  // A short command: half the bound before it, the rest after, nothing cut.
  const short = flashbackWindowRange(5_000n, 5_069n, 100_000n);
  expect(short).toEqual({ from: 4_000n, to: 5_999n, cut: false });
  // Near the partition's start and head the read shrinks; it never grows.
  expect(flashbackWindowRange(10n, 20n, 30n)).toEqual({ from: 1n, to: 30n, cut: false });
  // A command longer than the rest of the bound is read from its tail, ending at its last event.
  const long = flashbackWindowRange(5_000n, 9_999n, 100_000n);
  expect(long).toEqual({ from: 9_999n - size + 1n, to: 9_999n, cut: true });
  expect(span(long)).toBe(size);
});

// A command longer than the window: the moment event inside it is replayed from a start at or below
// it, never from the snapshot taken at the command's end, so no frame holds events twice or early.
it("replays an event inside a command longer than the window from a start below it, never from that command's end", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-flashback-cut");
    const auth = livingHallAuthentication(provisioned);
    const truth = truthOf(fixture);
    await withClient(fixture.environment, async (client) => {
      const journal = new PostgreSqlWorldCommandJournal(client);
      const step = world.behavior.policy.decisionIntervalMs;
      const outcome = await executeWorldCommand(
        commandRequest(
          provisioned,
          advanceCommand(
            world,
            "flashback-long",
            world.birth.state.simulationTime + step * 40n,
            null,
            { maxInputs: 1_024, maxEvents: 4_096 },
          ),
        ),
        { journal, behavior: provisioned.behavior },
      );
      expect(outcome.outcome).toBe("committed");
      const span = Number(
        await truth("SELECT count(*) FROM clockgrove.events WHERE command_id = 'flashback-long'"),
      );
      expect(span).toBeGreaterThan(FLASHBACK_BOUNDS.windowEvents);
      const partition = {
        ...provisioned.partition.target,
        partitionId: provisioned.partition.route.partitionId,
      };
      const artifacts = new PostgreSqlArtifactStore(client);
      // The snapshot the sweep would take: at the long command's own end.
      const snapshot = await createPartitionSnapshot(provisioned.authorization, partition, {
        snapshots: new PostgreSqlSnapshotStore(client),
        artifacts,
      });

      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("a flashback cannot route a command");
        },
        flashback: new PostgreSqlFlashbackReader(client, new PostgreSqlCausalInspector(client), {
          artifacts,
          decodeResource,
        }),
      });
      // An early event of the long command, before the window read's tail.
      const [eventId, sequence] = (
        await truth(
          "SELECT event_id || ',' || partition_sequence FROM clockgrove.events WHERE command_id = 'flashback-long' ORDER BY partition_sequence LIMIT 1 OFFSET 10",
        )
      ).split(",");
      const response = await worker.fetch(
        new Request("http://local.test/v1/runtime/flashback", {
          method: "POST",
          headers: { authorization: "Bearer hall-inspect", "content-type": "application/json" },
          body: JSON.stringify({ version: 1, ...auth.scope, eventId }),
        }),
      );
      expect(response.status).toBe(200);
      const flashback = decodeFlashback(await response.json());
      expect(flashback.replay).toMatchObject({ status: "replayed", truncated: true });
      expect(flashback.replay.status === "replayed" && flashback.replay.start).not.toBe(
        snapshot.snapshotId,
      );
      // The command's end lies more than the window past the moment event, so replay stops at the
      // moment's frame: from the birth, only the long command's events up to the moment are replayed,
      // and one flashback replays at most the catch-up bound plus the window.
      const end = BigInt(
        await truth("SELECT max(partition_sequence)::text FROM clockgrove.events"),
      );
      expect(end).toBeGreaterThan(BigInt(sequence!) + BigInt(FLASHBACK_BOUNDS.windowEvents));
      expect(flashback.frames.map((frame) => [frame.partitionSequence, frame.moment])).toEqual([
        [sequence, true],
      ]);
      expect(flashback.replay.status === "replayed" && flashback.replay.eventsReplayed).toBe(
        Number(
          await truth(
            `SELECT count(*) FROM clockgrove.events WHERE command_id = 'flashback-long' AND partition_sequence <= ${sequence}`,
          ),
        ),
      );
      expect(
        flashback.replay.status === "replayed" && flashback.replay.eventsReplayed,
      ).toBeLessThanOrEqual(FLASHBACK_BOUNDS.catchUpEvents + FLASHBACK_BOUNDS.windowEvents);
      // The long command holds many decisions by the moment's actor; those recorded after the moment
      // event are not its causes, and the summary says how many it left out.
      const actor = flashback.moment.objectId;
      const momentTime = BigInt(flashback.moment.simulationTime);
      const actorDrafts =
        flashback.why.traces.status === "available"
          ? flashback.why.traces.drafts.filter((draft) => draft.objectId === actor)
          : [];
      const later = actorDrafts.filter((draft) => BigInt(draft.simulationTime) > momentTime);
      expect(later.length).toBeGreaterThan(0);
      const cited = flashback.summary
        .flatMap((line) => line.cites)
        .filter((cite) => cite.startsWith("draft:"))
        .map((cite) => actorDrafts.find((draft) => `${draft.draftIndex}` === cite.split("#")[1]));
      for (const draft of cited)
        expect(BigInt(draft!.simulationTime)).toBeLessThanOrEqual(momentTime);
      expect(
        flashback.summary.some(
          (line) =>
            line.kind === "limit" &&
            line.text.includes(
              `${later.length} decision${later.length === 1 ? "" : "s"} recorded after this moment`,
            ),
        ),
      ).toBe(true);
      expect(flashback.summary.at(-1)?.text).toContain(
        `The window was cut at ${FLASHBACK_BOUNDS.windowEvents} events.`,
      );

      // Each frame, and the moment's context, is the state a replay from birth reaches there.
      const ports = {
        events: new JournalRangeReader(
          new PostgreSqlJournalRangeSource(client, provisioned.authorization),
          JOURNAL_EVENT_REGISTRY,
        ),
        birth: new PostgreSqlWorldProvisioningStore(client),
        decodeResource,
      };
      const birth = await replayBirth(provisioned.authorization, partition, ports);
      for (const frame of flashback.frames) {
        const replayed = await replayPartition(
          partition,
          birth,
          BigInt(frame.partitionSequence),
          ports,
        );
        expect([frame.projection.revision, frame.projection.simulationTime]).toEqual([
          replayed.state.revision,
          replayed.state.simulationTime,
        ]);
        expect(JSON.parse(JSON.stringify(frame.projection.entities))).toEqual(
          livingSceneOf(auth.scope, replayed.state).entities,
        );
      }
      expect(flashback.context?.revision).toBe(flashback.frames[0]!.projection.revision.toString());
    });
  });
}, 300_000);
