import { readFile } from "node:fs/promises";
import {
  AuthorizationRefusedError,
  decodeCanonicalNode,
  InMemoryRuntimeMetrics,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  verifyPartitionReplay,
} from "@clockgrove/application";
import {
  type CommandEnvelope,
  decodeFlashback,
  decodeFlashbackMarks,
  decodeOpaqueId,
  type SceneConnectionAttachment,
} from "@clockgrove/contracts";
import {
  PostgreSqlArtifactStore,
  PostgreSqlJournalRangeSource,
  PostgreSqlSnapshotStore,
  PostgreSqlWorldProvisioningStore,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { expect, it } from "vitest";
import { REPO_ROOT } from "../../../packages/simulator/cli/repo.js";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { PostgreSqlFlashbackReader } from "../src/flashback.js";
import { PostgreSqlFlashbackMarksReader } from "../src/flashback-marks.js";
import { PostgreSqlCausalInspector } from "../src/inspector.js";
import { PostgreSqlSceneStreamReader } from "../src/observation.js";
import { decodeScenePresentations } from "../src/scene-presentation.js";
import { RuntimeWorker } from "../src/worker.js";
import { PostgreSqlCommandOwner } from "../src/world-commands.js";
import { livingHallAuthentication } from "./living-hall-fixture.js";
import {
  advanceCommand,
  type DatabaseFixture,
  provisionTestWorld,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

// Issue 267, the completion experience: a keeper scratches the cedar, a companion sees and smells
// it, the flashback names who did it, the bark heals through band crossings alone, the owner
// repairs it under its own principal, and the whole history replays exactly.
it("remembers a scratched cedar, heals it by band crossings, is repaired by its owner and replays exactly", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-remembers");
    const { authorization } = provisioned;
    const auth = livingHallAuthentication(provisioned);
    const truth = truthOf(fixture);
    const runtime = JSON.parse(
      await readFile(`${REPO_ROOT}/worlds/fixture/reference/runtime.json`, "utf8"),
    );
    const presentations = decodeScenePresentations(JSON.stringify(runtime.presentations));
    const authorize = async (grant: string) => {
      const request = new Request("http://local.test/v1/runtime/commands", {
        method: "POST",
        headers: { authorization: "Bearer hall-inspect" },
        body: JSON.stringify({ version: 1, ...auth.scope }),
      });
      const meta = {
        requestId: "remembers",
        correlationId: decodeOpaqueId("remembers", "CorrelationId"),
      };
      return auth.authenticator.authorize(await auth.authenticator.identify(request), meta, grant);
    };
    const observer = await authorize("runtime:world-observe");
    auth.grant("runtime:world-command");
    const commander = await authorize("runtime:world-command");

    await withClient(fixture.environment, async (client) => {
      const owner = new PostgreSqlCommandOwner(client);
      const born = world.birth.state.simulationTime;
      const head = "SELECT revision || state_hash FROM clockgrove.partition_states";
      // Every command goes through the owner as `POST /v1/runtime/commands` does.
      const issue = async (
        key: string,
        type: string,
        payload: object,
        actor = "owner",
        ctx = commander,
      ) => {
        const revision = BigInt(await truth("SELECT revision FROM clockgrove.partition_states"));
        const command = {
          ...advanceCommand(world, key, 0n, type === "world.advance" ? null : revision),
          type,
          payload,
          attribution: { effectiveActorId: actor, causalRootActionId: `action-${key}` },
        } as CommandEnvelope<string, unknown>;
        const epochs = { routingEpoch: 0n, authorityEpoch: 0n };
        return owner.submit({ scope: auth.scope, epochs, command }, ctx, () => 0n);
      };
      const advance = async (key: string, targetTime: bigint) =>
        expect(
          (
            await issue(key, "world.advance", {
              schemaVersion: 1,
              targetTime,
              maxInputs: 1024,
              maxEvents: 4096,
            })
          ).value,
        ).toMatchObject({ status: "committed", complete: true });
      // The journaled events of a type, their kernel records decoded, under their row's event id.
      const events = async (type: string, commandId = "%") =>
        (
          await truth(
            `SELECT coalesce(string_agg(event_id || '|' || payload::text, E'\\n' ORDER BY partition_sequence), '') FROM clockgrove.events WHERE event_type = '${type}' AND command_id LIKE '${commandId}'`,
          )
        )
          .split("\n")
          .filter(Boolean)
          .map((row) => {
            const at = row.indexOf("|");
            // biome-ignore lint/suspicious/noExplicitAny: a decoded journal event is dynamic.
            const kernel = decodeCanonicalNode(JSON.parse(row.slice(at + 1)).kernelEvent) as any;
            return { ...kernel, eventId: row.slice(0, at) };
          });
      const attachment = {
        principalId: authorization.principalId,
        acknowledgedRevision: null,
        connectionVersion: 1,
        audience: {
          ...auth.scope,
          privacyClass: "public_scene",
          interest: { selection: null, conversation: false, operator: false },
        },
      } as SceneConnectionAttachment;
      const facts = { categories: ["public_scene"], command: false, inspect: false } as const;
      const barkSentence = async () =>
        (
          await new PostgreSqlSceneStreamReader(client, presentations).read(
            attachment,
            null,
            observer,
            facts,
          )
        ).projection.surfaces?.zones.find((zone) => zone.zoneId === "cedar-bark")?.sentence;
      const unused = () => {
        throw new Error("unused");
      };
      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: unused,
        flashback: new PostgreSqlFlashbackReader(client, new PostgreSqlCausalInspector(client), {
          artifacts: new PostgreSqlArtifactStore(client),
          decodeResource,
        }),
        observation: {
          observe: unused,
          marks: (request, context) =>
            new PostgreSqlFlashbackMarksReader(client).read(request, context),
        },
      });
      const post = async (path: string, fields: object) => {
        const response = await worker.fetch(
          new Request(`http://local.test/v1/runtime/${path}`, {
            method: "POST",
            headers: { authorization: "Bearer hall-inspect", "content-type": "application/json" },
            body: JSON.stringify({ version: 1, ...auth.scope, ...fields }),
          }),
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      const barkMoments = async () =>
        decodeFlashbackMarks(await post("flashback/marks", { zoneId: "cedar-bark" })).zones[0]!
          .moments;
      const sentenceOf = async (eventId: string) =>
        decodeFlashback(await post("flashback", { eventId })).summary[0]!.text;

      // 1. The keeper scratches the bark.
      await advance("settle", born + 60_000n);
      const scratch = {
        schemaVersion: 1,
        actorId: "fixture.keeper",
        zoneId: "cedar-bark",
        interactionId: "scratch",
        intensity: 10000,
        point: { u: 3000, v: 7000 },
      };
      expect((await issue("scratch", "surface.interact", scratch, "fixture.keeper")).outcome).toBe(
        "committed",
      );
      const [interacted] = await events("surface.interacted", "scratch");
      expect(interacted.payload).toMatchObject({
        zoneId: "cedar-bark",
        channels: [{ value: 300 }, { value: 400 }],
        mark: { actorId: "fixture.keeper", point: { u: 3000, v: 7000 } },
      });
      expect(await barkSentence()).toBe(
        "The cedar's bark is scratched; most recently by Keeper, a resident.",
      );

      // 2. The companion walks to the cedar and notices it by sight and smell.
      await issue("companion-to-cedar", "movement.start", {
        schemaVersion: 1,
        objectId: "fixture.companion",
        destination: { kind: "anchor", anchorId: "tree-base", graphVersion: 1 },
        unitsPerSecond: 1000n,
      });
      await advance("companion-arrives", born + 90_000n);
      const [entered] = (await events("movement.region-entered")).filter(
        (event) => event.payload.objectId === "fixture.companion",
      );
      expect(entered.payload.notices).toMatchObject([
        {
          zoneId: "cedar-bark",
          signals: [
            { modality: "sight", band: "scratched" },
            { modality: "smell", band: "marked" },
          ],
          mark: { actorId: "fixture.keeper" },
        },
      ]);

      // 3. Why: the bark's journaled moments name the keeper's scratch, and it plays as a flashback.
      const [listed] = (await barkMoments()).filter((moment) => moment.kind === "interacted");
      expect(listed).toMatchObject({
        eventId: interacted.eventId,
        actorId: "fixture.keeper",
        interactionId: "scratch",
        leftMark: true,
      });
      expect(await sentenceOf(interacted.eventId)).toBe(
        "fixture.keeper scratch on cedar-bark, leaving a mark.",
      );

      // 4. Days pass: the scent fades, then wear enters scuffed while still scratched and leaves
      // scratched, as three band crossings and no other surface event.
      await advance("days-pass", born + 120_000_000n);
      const surfaceEvents = await truth(
        "SELECT string_agg(event_type, ',' ORDER BY partition_sequence) FROM clockgrove.events WHERE event_type LIKE 'surface.%'",
      );
      expect(surfaceEvents).toBe(
        "surface.interacted,surface.band-crossed,surface.band-crossed,surface.band-crossed",
      );
      const crossings = await events("surface.band-crossed");
      expect(
        crossings.map(({ payload }) => [payload.channel, payload.value, payload.bands]),
      ).toEqual([
        ["scent", 0, []],
        ["wear", 299, ["scuffed", "scratched"]],
        ["wear", 199, ["scuffed"]],
      ]);
      expect(await barkSentence()).toBeNull();

      // 5. The owner repairs the bark under its own principal and `runtime:world-repair`; a member
      // with only `runtime:world-command`, or only observing, is refused and changes nothing.
      const repair = { schemaVersion: 1, zoneId: "cedar-bark", reason: "owner-sweep" };
      const unrepaired = await truth(head);
      for (const [key, ctx] of [
        ["commander-repair", commander],
        ["observer-repair", observer],
      ] as const)
        await expect(issue(key, "surface.repair", repair, "owner", ctx)).rejects.toBeInstanceOf(
          AuthorizationRefusedError,
        );
      expect(await truth(head)).toBe(unrepaired);
      auth.grant("runtime:world-repair");
      const repairer = await authorize("runtime:world-repair");
      expect(
        (await issue("owner-repair", "surface.repair", repair, "owner", repairer)).outcome,
      ).toBe("committed");
      const [repaired] = await events("surface.repaired");
      expect(repaired.payload).toMatchObject({ zoneId: "cedar-bark", reason: "owner-sweep" });
      expect(repaired.attribution.principalId).toBe(authorization.principalId);

      // 6. The repair is listed and read as a sentence, and so is a crossing.
      expect((await barkMoments())[0]).toMatchObject({
        eventId: repaired.eventId,
        kind: "repaired",
        actorId: null,
      });
      expect(await sentenceOf(repaired.eventId)).toBe(
        "cedar-bark was repaired (owner sweep), removing 173 wear.",
      );
      expect(await sentenceOf(crossings[1].eventId)).toBe("cedar-bark's wear moved into scuffed.");
      expect(await sentenceOf(crossings[2].eventId)).toBe("cedar-bark's wear left scratched.");
      expect(await sentenceOf(crossings[0].eventId)).toBe(
        "cedar-bark's scent left marked, now in no band.",
      );

      // 7. The journal replays to the live state exactly.
      const ports = {
        snapshots: new PostgreSqlSnapshotStore(client),
        artifacts: new PostgreSqlArtifactStore(client),
        events: new JournalRangeReader(
          new PostgreSqlJournalRangeSource(client, authorization),
          JOURNAL_EVENT_REGISTRY,
        ),
        birth: new PostgreSqlWorldProvisioningStore(client),
        decodeResource,
        metrics: new InMemoryRuntimeMetrics(),
      };
      const scope = {
        ...provisioned.partition.target,
        partitionId: provisioned.partition.route.partitionId,
      };
      expect(
        (await verifyPartitionReplay(authorization, scope, "exact", ports)).mismatches,
      ).toEqual([]);
    });
  });
}, 300_000);
