import {
  createPartitionSnapshot,
  decodeCanonicalNode,
  executeWorldCommand,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  replayBirth,
  replayPartition,
} from "@clockgrove/application";
import { decodeFlashback, decodeOpaqueId, type Flashback } from "@clockgrove/contracts";
import {
  PostgreSqlArtifactStore,
  PostgreSqlJournalRangeSource,
  PostgreSqlSnapshotStore,
  PostgreSqlWorldCommandJournal,
  PostgreSqlWorldProvisioningStore,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { PostgreSqlFlashbackReader } from "../src/flashback.js";
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
      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("a flashback cannot route a command");
        },
        flashback: new PostgreSqlFlashbackReader(client, inspector, { artifacts, decodeResource }),
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
      expect(flashback.summary.map((line) => line.kind)).toContain("cause");
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
          }
        }
      }

      // "And before that…": each cause is a further flashback, until the record goes no further.
      let chained = flashback;
      const walked: string[] = [];
      while (chained.before.length > 0 && walked.length < 16) {
        chained = await read({ commandId: chained.before[0] });
        walked.push(chained.moment.commandId);
      }
      expect(walked.length).toBeGreaterThan(0);
      expect(chained.before).toEqual([]);
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
      auth.revoke();
      const refused = await post({ eventId });
      expect([refused.status, await refused.json()]).toEqual([
        403,
        { error: "authorization_refused" },
      ]);
    });
  });
}, 300_000);
