import { executeWorldCommand } from "@clockgrove/application";
import {
  decodeEntitySelection,
  decodeOpaqueId,
  decodeRecordedWhy,
  decodeWorldStatus,
} from "@clockgrove/contracts";
import { PostgreSqlWorldCommandJournal } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import type { Json } from "../../../packages/simulator/test/fixtures/lamp-hall.js";
import { buildSectionHallSource } from "../../../packages/simulator/test/fixtures/section-hall.js";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { PostgreSqlCausalInspector } from "../src/inspector.js";
import {
  PostgreSqlEntitySelectionReader,
  PostgreSqlWorldStatusReader,
} from "../src/observation.js";
import { RuntimeWorker } from "../src/worker.js";
import { livingHallAuthentication } from "./living-hall-fixture.js";
import {
  advanceCommand,
  commandRequest,
  type DatabaseFixture,
  packWorld,
  provisionTestWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

it("shows retained rain, plant, process and outside meal causes through public Why without private attribution or mutations", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const source = await buildSectionHallSource({
      edit: ({ docs, manifest }) => {
        const policy = (docs["policies/behavior.json"] as Json).policy;
        policy.ecology.perishables = [];
        policy.boundaryExchanges = [
          {
            id: "neighbour-bins",
            name: "Neighbour bins",
            kind: "food",
            supply: 1,
            absorb: 0,
            actorIds: ["sec.sprout"],
          },
        ];
        (docs["archetypes/sprout.json"] as Json).traits = [{ id: "sec.needs", version: 1 }];
        for (const key of ["lifecycle", "utility", "wellbeing"]) delete policy[key];
        policy.environment.wetThreshold = 1;
        policy.decisionIntervalMs = 1000n;
        policy.wetnessPerInterval = 1000;
        policy.environment.weatherSegments = [
          { durationMs: 3600000n, rainIntensity: 10000, temperatureBand: "wet" },
        ];
        policy.ecology.waterHolders = [
          { objectId: "sec.pond", capacity: 10, catchment: 3600000, evaporationPerHour: 0 },
          { objectId: "sec.crate", capacity: 10, catchment: 0, evaporationPerHour: 0 },
        ];
        policy.ecology.plants[0].stages = [
          { name: "seed", thresholdMs: 0n },
          { name: "fruit", thresholdMs: 1n, yield: { quantity: 2 } },
        ];
        for (const [id, kind] of [
          ["pond", "water"],
          ["crate", "water"],
          ["sprout", "food"],
        ]) {
          (docs[`archetypes/${id}.json`] as Json).components["clockgrove.resource"] = {
            type: "clockgrove.resource",
            version: 1,
            state: { kind, quantity: 0 },
          };
        }
        policy.processes = [
          {
            id: "household",
            principalId: "PRIVATE-PRINCIPAL-SENTINEL",
            firstAtMs: 100002n,
            periodMs: 1000n,
            command: {
              type: "resource.transfer",
              payload: {
                schemaVersion: 1,
                fromObjectId: "sec.pond",
                toObjectId: "sec.crate",
                kind: "water",
                quantity: 1,
              },
            },
          },
        ];
        manifest.actors = manifest.actors.filter(
          (entry: Json) => !["sec.parent", "sec.child"].includes(entry.id),
        );
        for (const id of ["parent", "child"]) delete docs[`actors/${id}.json`];
        manifest.cognitiveSeeds = [];
        for (const name of ["first", "second", "other"]) delete docs[`cognition/${name}.json`];
      },
    });
    const packed = await packWorld(source);
    if (packed.behavior === null) throw new Error("behavior required");
    const world = { ...packed, behavior: packed.behavior };
    const provisioned = await provisionTestWorld(fixture, world, "principal-resource-why");
    const auth = livingHallAuthentication(provisioned);
    await withClient(fixture.environment, async (client) => {
      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("read cannot command");
        },
        inspector: new PostgreSqlCausalInspector(client),
        observation: {
          observe: async () => Promise.reject(new Error("unexpected scene read")),
          status: (scope, context) => new PostgreSqlWorldStatusReader(client).read(scope, context),
          select: (input, context) =>
            new PostgreSqlEntitySelectionReader(client).select(input, context, 100n),
        },
      });
      const read = async (endpoint: string, fields = {}) => {
        const response = await worker.fetch(
          new Request(`http://local.test/v1/runtime/${endpoint}`, {
            method: "POST",
            headers: { authorization: "Bearer hall-inspect", "content-type": "application/json" },
            body: JSON.stringify({
              version: 1,
              ...auth.scope,
              ...(endpoint === "why" ? { includeResourceCauses: true } : {}),
              ...fields,
            }),
          }),
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      const execute = (command: ReturnType<typeof advanceCommand>) =>
        executeWorldCommand(commandRequest(provisioned, command), {
          journal: new PostgreSqlWorldCommandJournal(client),
          behavior: provisioned.behavior,
        });
      const rain = {
        ...advanceCommand(world, "rain-override", 100000n, world.birth.state.revision),
        type: "world.weather.set",
        payload: { schemaVersion: 2, rainIntensity: 10000 },
      };
      expect((await execute(rain)).outcome).toBe("committed");
      const advanced = await execute(advanceCommand(world, "physical-causes", 100002n, null));
      if (advanced.value.status !== "committed") throw new Error("advance refused");
      const truth = truthOf(fixture);
      const canonical =
        "SELECT jsonb_build_object('states',(SELECT jsonb_agg(to_jsonb(s)) FROM clockgrove.partition_states s),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY partition_sequence) FROM clockgrove.events e),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM clockgrove.command_receipts r))::text";
      const transfer = {
        ...advanceCommand(world, "actor-transfer", 100002n, BigInt(advanced.value.revision)),
        type: "resource.transfer",
        payload: {
          schemaVersion: 1,
          fromObjectId: "sec.pond",
          toObjectId: "sec.crate",
          kind: "water",
          quantity: 1,
        },
      };
      expect((await execute(transfer)).outcome).toBe("committed");
      const outside = {
        ...advanceCommand(world, "outside-meal", 100002n, null),
        type: "boundary.exchange",
        attribution: {
          effectiveActorId: "sec.sprout",
          causalRootActionId: decodeOpaqueId("action-outside-meal", "ActionId"),
        },
        payload: {
          schemaVersion: 1,
          boundaryId: "neighbour-bins",
          actorId: "sec.sprout",
          objectId: "sec.sprout",
          kind: "food",
          direction: "import",
          quantity: 1,
        },
      };
      expect((await execute(outside)).outcome).toBe("committed");
      expect(
        (
          await execute({
            ...advanceCommand(world, "eat-outside-meal", 100002n, null),
            type: "resource.consume",
            payload: { schemaVersion: 1, objectId: "sec.sprout", kind: "food", quantity: 1 },
          })
        ).outcome,
      ).toBe("committed");
      const before = await truth(canonical);
      const boundary = decodeRecordedWhy(await read("why", { commandId: "outside-meal" }));
      const boundaryEventId = await truth(
        "SELECT event_id FROM clockgrove.events WHERE command_id='outside-meal' AND event_type='resource.boundary-exchanged'",
      );
      expect(boundary.resourceCauses).toEqual([
        {
          eventId: boundaryEventId,
          simulationTime: "100002",
          cause: "boundary-exchange",
          kind: "food",
          quantity: 1,
          objectId: "sec.sprout",
          boundaryId: "neighbour-bins",
          boundaryName: "Neighbour bins",
          actorId: "sec.sprout",
          direction: "import",
        },
      ]);
      expect(
        decodeRecordedWhy(await read("why", { eventId: boundaryEventId })).resourceCauses,
      ).toEqual(boundary.resourceCauses);
      const mealHolder = decodeEntitySelection(await read("entity", { objectId: "sec.sprout" }));
      expect(
        mealHolder.history.actions
          .filter((entry) => entry.type === "resource.boundary-exchanged")
          .map((entry) => [entry.eventId, entry.commandId, entry.simulationTime]),
      ).toEqual([[boundaryEventId, "outside-meal", "100002"]]);
      const why = decodeRecordedWhy(await read("why", { commandId: "physical-causes" }));
      expect(why.traces).toEqual({ status: "available", drafts: [] });
      const rows = (value: ReturnType<typeof decodeRecordedWhy>) =>
        value.resourceCauses?.map((cause) => [
          cause.simulationTime,
          cause.cause,
          cause.kind,
          cause.quantity,
          cause.objectId,
          cause.fromObjectId ?? null,
          cause.processId ?? null,
        ]);
      expect(rows(why)).toEqual([
        ["100001", "rain", "water", 1, "sec.pond", null, null],
        ["100002", "rain", "water", 1, "sec.pond", null, null],
        ["100002", "growth", "food", 2, "sec.sprout", null, null],
        ["100002", "transfer", "water", 1, "sec.crate", "sec.pond", "household"],
      ]);
      expect(why.resourceCauses?.map((cause) => cause.eventId)).toEqual(
        JSON.parse(
          await truth(
            "SELECT jsonb_agg(event_id ORDER BY partition_sequence)::text FROM clockgrove.events WHERE command_id='physical-causes' AND event_type IN ('resource.weather-integrated','growth.stage-changed','resource.transferred') AND (event_type <> 'resource.weather-integrated' OR payload::text LIKE '%sec.pond%')",
          ),
        ),
      );
      const actor = decodeRecordedWhy(await read("why", { commandId: "actor-transfer" }));
      expect(rows(actor)).toEqual([
        ["100002", "transfer", "water", 1, "sec.crate", "sec.pond", null],
      ]);
      const { resourceCauses, ...historic } = why;
      expect(decodeRecordedWhy(historic)).toEqual(historic);
      expect(
        await read("why", { commandId: "physical-causes", includeResourceCauses: undefined }),
      ).toEqual(historic);
      expect(JSON.stringify(why)).not.toMatch(/PRIVATE-PRINCIPAL-SENTINEL|authorityDecisionId/);
      const scene = decodeWorldStatus(await read("world-status"));
      expect(
        scene.feed
          .filter((event) => event.text.includes("outside the world"))
          .map((event) => event.text),
      ).toEqual([
        "sec.sprout imported 1 food from outside the world at Neighbour bins into sec.sprout.",
      ]);
      expect(
        scene.feed.filter((event) => event.text.includes("from rain")).map((event) => event.text),
      ).toEqual([
        "sec.pond collected 1 water from rain; 0 evaporated.",
        "sec.pond collected 1 water from rain; 0 evaporated.",
      ]);
      expect(
        await truth(
          "SELECT count(*)::text FROM clockgrove.events WHERE command_id='physical-causes' AND event_type='resource.weather-integrated' AND payload::text LIKE '%sec.crate%' ",
        ),
      ).toBe("2");
      expect(scene.feed.filter((event) => event.text.includes("collected 0"))).toEqual([]);
      const dry = decodeEntitySelection(await read("entity", { objectId: "sec.crate" }));
      expect(
        dry.history.actions.filter((event) => event.type === "resource.weather-integrated"),
      ).toEqual([]);
      const entity = decodeEntitySelection(await read("entity", { objectId: "sec.pond" }));
      expect(
        entity.history.actions
          .filter((event) => event.type === "resource.weather-integrated")
          .map((event) => event.simulationTime),
      ).toEqual(["100002", "100001"]);
      expect(await truth(canonical)).toBe(before);
    });
  });
}, 120_000);
