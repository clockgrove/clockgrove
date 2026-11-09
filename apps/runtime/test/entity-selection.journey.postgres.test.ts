import { executeWorldCommand } from "@clockgrove/application";
import { decodeEntitySelection, decodeLivingScene, decodeOpaqueId } from "@clockgrove/contracts";
import { PostgreSqlWorldCommandJournal, PostgreSqlWorldOwnerReader } from "@clockgrove/persistence";
import { expect, it, vi } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { Headless3DAdapter } from "../../web/test/headless-3d-adapter.js";
import { sceneSession } from "../../web/test/scene-socket-fixture.js";
import {
  PostgreSqlEntitySelectionReader,
  PostgreSqlLivingSceneReader,
} from "../src/observation.js";
import { RuntimeWorker } from "../src/worker.js";
import { PostgreSqlCommandOwner } from "../src/world-commands.js";
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

it("observes canonical entity state and earned values without writes, pages recorded public actions and isolates superseded selection lifetimes", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-selection");
    const auth = livingHallAuthentication(provisioned);
    const sql = truthOf(fixture);
    await withClient(fixture.environment, async (client) => {
      const owner = new PostgreSqlCommandOwner(client);
      const reader = new PostgreSqlLivingSceneReader(new PostgreSqlWorldOwnerReader(client));
      const selectedReader = new PostgreSqlEntitySelectionReader(client);
      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("selection must not route a command");
        },
        observation: {
          observe: (scope, context) => reader.observe(scope, context),
          select: (input, context) => selectedReader.select(input, context, 100n),
        },
      });
      const request = (objectId: string, extra = {}, credential = "hall-inspect") =>
        new Request("http://local.test/v1/runtime/entity", {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ version: 1, ...auth.scope, objectId, ...extra }),
        });
      const state =
        "SELECT jsonb_build_object('state',(SELECT jsonb_agg(to_jsonb(s)) FROM clockgrove.partition_states s),'receipts',(SELECT jsonb_agg(to_jsonb(r)) FROM clockgrove.command_receipts r),'schedules',(SELECT jsonb_agg(to_jsonb(q) ORDER BY schedule_id,idempotency_key) FROM clockgrove.partition_schedules q))::text";
      const before = await sql(state);
      const pausedResponse = await worker.fetch(request("fixture.companion"));
      expect(pausedResponse.status).toBe(200);
      const paused = decodeEntitySelection(await pausedResponse.json());
      expect([
        paused.objectId,
        paused.revision,
        paused.simulationTime,
        paused.derived.simulationTime,
        paused.derived.canonical,
      ]).toEqual(["fixture.companion", "0", "8640000000", "8640000000", false]);
      expect(paused.physical.needs).toEqual({
        hunger: 3000,
        wetness: 0,
        integratedAt: "8640000000",
        hungerRemainder: "0",
        wetnessRemainder: "0",
      });
      expect(paused.physical.wellbeing).toEqual({
        thirst: 0,
        health: 10000,
        comfort: "comfortable",
        integratedAt: "8640000000",
        thirstRemainder: "0",
        healthRemainder: "0",
      });
      const born = world.birth.state.entities.find(
        (entity) => entity.objectId === "fixture.companion",
      );
      if (born === undefined) throw new Error("fixture requires Companion");
      expect(paused.entity).toEqual({
        objectId: born.objectId,
        archetypeId: born.archetypeId,
        pose: {
          frameId: born.pose.frameId,
          frameVersion: born.pose.frameVersion,
          coordinates: born.pose.coordinates.map(String),
        },
        presentation: { kind: "placeholder", label: "fixture.companion" },
      });
      expect([
        paused.physical.resource,
        paused.physical.shelter,
        paused.physical.locationId,
        paused.physical.selectedAction,
        paused.physical.lifecycle,
      ]).toEqual([
        born.resource ?? null,
        born.shelter ?? null,
        born.locationId ?? null,
        born.selectedAction === undefined
          ? null
          : {
              kind: born.selectedAction.kind,
              targetObjectId: born.selectedAction.targetObjectId ?? null,
            },
        born.lifecycle?.status ?? null,
      ]);
      expect(paused.history).toEqual({ observedRevision: "0", actions: [], beforeSequence: null });
      expect(await sql(state)).toBe(before);
      const resume = {
        ...advanceCommand(world, "selection-clock-resume", 0n, null),
        type: "ResumeWorld",
        payload: { schemaVersion: 1 },
      };
      expect(
        (
          await executeWorldCommand(
            { ...commandRequest(provisioned, resume), trustedWallTime: () => 0n },
            {
              journal: new PostgreSqlWorldCommandJournal(client),
              behavior: provisioned.behavior,
            },
          )
        ).outcome,
      ).toBe("committed");
      const runningBefore = await sql(state);
      const earnedResponse = await worker.fetch(request("fixture.companion"));
      const earned = decodeEntitySelection(await earnedResponse.json());
      expect(earned.derived).toEqual({
        canonical: false,
        simulationTime: "8640000100",
        needs: {
          hunger: 3000,
          wetness: 0,
          integratedAt: "8640000100",
          hungerRemainder: "80000",
          wetnessRemainder: "0",
        },
        wellbeing: {
          thirst: 0,
          health: 10000,
          thirstRemainder: "10000",
          healthRemainder: "0",
        },
        plant: null,
      });
      expect(earned.physical).toEqual(paused.physical);
      const plant = decodeEntitySelection(
        await (await worker.fetch(request("fixture.cedar"))).json(),
      );
      expect(plant.physical.plant).toEqual({
        stage: 0,
        growingMs: "0",
        wetness: 0,
        wetnessRemainder: "0",
        integratedAt: "8640000000",
      });
      expect(plant.derived.plant).toEqual({ growingMs: "0", wetness: 0, wetnessRemainder: "0" });
      expect([plant.derived.needs, plant.derived.wellbeing]).toEqual([null, null]);
      await worker.fetch(request("fixture.companion"));
      expect(await sql(state)).toBe(runningBefore);
      const unknown = await worker.fetch(request("unknown"));
      expect([unknown.status, await unknown.json()]).toEqual([
        409,
        { error: "selection_unavailable" },
      ]);
      const inspect = PostgreSqlCommandOwner.prototype.inspect;
      const unprojectable = vi
        .spyOn(PostgreSqlCommandOwner.prototype, "inspect")
        .mockImplementationOnce(async function (this: PostgreSqlCommandOwner, ...args) {
          const inspected = await inspect.apply(this, args);
          return {
            ...inspected,
            document: {
              ...inspected.document,
              state: {
                ...inspected.document.state,
                entities: inspected.document.state.entities.map((entity) =>
                  entity.objectId === "fixture.companion"
                    ? { ...entity, spaceId: decodeOpaqueId("space-not-projected", "SpaceId") }
                    : entity,
                ),
              },
            },
          };
        });
      try {
        const hidden = await worker.fetch(request("fixture.companion"));
        expect([hidden.status, await hidden.json()]).toEqual([
          409,
          { error: "selection_unavailable" },
        ]);
      } finally {
        unprojectable.mockRestore();
      }
      const foreign = await worker.fetch(
        request("fixture.companion", { spaceId: "foreign-space" }),
      );
      expect([foreign.status, await foreign.json()]).toEqual([
        403,
        { error: "authorization_refused" },
      ]);
      const anonymous = await worker.fetch(request("fixture.companion", {}, "invalid"));
      expect([anonymous.status, await anonymous.json()]).toEqual([
        401,
        { error: "authentication_refused" },
      ]);
      const rainCommand = {
        ...advanceCommand(world, "selection-rain", 0n, null),
        type: "world.weather.set",
        payload: { schemaVersion: 2, rainIntensity: 10000 },
      };
      expect(
        (
          await executeWorldCommand(commandRequest(provisioned, rainCommand), {
            journal: new PostgreSqlWorldCommandJournal(client),
            behavior: provisioned.behavior,
          })
        ).outcome,
      ).toBe("committed");
      const rainyBefore = await sql(state);
      const rainyPlant = decodeEntitySelection(
        await (await worker.fetch(request("fixture.cedar"))).json(),
      );
      expect(rainyPlant.derived.plant).toEqual({
        growingMs: "0",
        wetness: 0,
        wetnessRemainder: "100000000000000",
      });
      expect(rainyPlant.physical.plant).toEqual(plant.physical.plant);
      expect(await sql(state)).toBe(rainyBefore);
      // 102 recorded effects exceed the implementation's 100-sequence read window.
      for (let index = 0; index < 102; index++) {
        const current = await owner.reader.hydrate(provisioned.authorization, auth.scope);
        const command = {
          ...advanceCommand(world, `selection-${index}`, 0n, current.document.state.revision),
          type: index % 2 === 0 ? "resource.offer" : "resource.consume",
          payload: { schemaVersion: 1, objectId: "fixture.snack-dish", kind: "food", quantity: 1 },
        };
        const result = await executeWorldCommand(commandRequest(provisioned, command), {
          journal: new PostgreSqlWorldCommandJournal(client),
          behavior: provisioned.behavior,
        });
        expect(result.outcome).toBe("committed");
      }
      const recent = decodeEntitySelection(
        await (await worker.fetch(request("fixture.snack-dish"))).json(),
      );
      expect(recent.physical.resource).toEqual({ kind: "food", quantity: 0 });
      expect(
        recent.history.actions.map((action) => [action.commandId, action.type, action.actionId]),
      ).toEqual(
        Array.from({ length: 100 }, (_, index) => {
          const n = 101 - index;
          return [
            `selection-${n}`,
            n % 2 === 0 ? "resource.offered" : "resource.consumed",
            `action-selection-${n}`,
          ];
        }),
      );
      const lastSequence = BigInt(
        await sql(
          "SELECT partition_sequence::text FROM clockgrove.events WHERE command_id='selection-101'",
        ),
      );
      expect(recent.history.actions.map((action) => action.partitionSequence)).toEqual(
        Array.from({ length: 100 }, (_, index) => (lastSequence - BigInt(index)).toString()),
      );
      const recorded: unknown = JSON.parse(
        await sql(
          `SELECT json_agg(to_char(recorded_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ORDER BY partition_sequence DESC)::text
           FROM (SELECT recorded_at, partition_sequence FROM clockgrove.events
             WHERE event_type IN ('resource.offered', 'resource.consumed')
             ORDER BY partition_sequence DESC LIMIT 100) AS recent`,
        ),
      );
      expect(recent.history.actions.map((action) => action.recordedAt)).toEqual(recorded);
      expect(
        recent.history.actions.map((action) => [action.eventId, action.simulationTime]),
      ).toEqual(
        Array.from({ length: 100 }, (_, index) => [
          `selection-${101 - index}:event:0`,
          "8640000000",
        ]),
      );
      const earlierResponse = await worker.fetch(
        request("fixture.snack-dish", {
          cursor: {
            observedRevision: recent.revision,
            beforeSequence: recent.history.beforeSequence,
          },
        }),
      );
      const earlier = decodeEntitySelection(await earlierResponse.json());
      expect(earlier.history.actions.map((action) => action.commandId)).toEqual([
        "selection-1",
        "selection-0",
      ]);
      expect(earlier.history.beforeSequence).toBe(null);
      const appendDuringRead = vi
        .spyOn(PostgreSqlCommandOwner.prototype, "inspect")
        .mockImplementationOnce(async function (this: PostgreSqlCommandOwner, ...args) {
          const snapshot = await inspect.apply(this, args);
          const current = await owner.reader.hydrate(provisioned.authorization, auth.scope);
          const newer = {
            ...advanceCommand(world, "selection-newer", 0n, current.document.state.revision),
            type: "resource.offer",
            payload: {
              schemaVersion: 1,
              objectId: "fixture.snack-dish",
              kind: "food",
              quantity: 1,
            },
          };
          expect(
            (
              await executeWorldCommand(commandRequest(provisioned, newer), {
                journal: new PostgreSqlWorldCommandJournal(client),
                behavior: provisioned.behavior,
              })
            ).outcome,
          ).toBe("committed");
          return snapshot;
        });
      try {
        const frozen = decodeEntitySelection(
          await (await worker.fetch(request("fixture.snack-dish"))).json(),
        );
        expect(frozen.history).toEqual(recent.history);
        expect(frozen.revision).toBe(recent.revision);
      } finally {
        appendDuringRead.mockRestore();
      }
      const stale = await worker.fetch(
        request("fixture.snack-dish", {
          cursor: {
            observedRevision: recent.revision,
            beforeSequence: recent.history.beforeSequence,
          },
        }),
      );
      expect([stale.status, await stale.json()]).toEqual([409, { error: "selection_unavailable" }]);
      auth.revoke();
      const denied = await worker.fetch(request("fixture.snack-dish"));
      expect([denied.status, await denied.json()]).toEqual([
        403,
        { error: "authorization_refused" },
      ]);
      const sceneAuth = livingHallAuthentication(provisioned);
      const sceneWorker = new RuntimeWorker(sceneAuth.authenticator, {
        getSpace: () => {
          throw new Error("read only");
        },
        observation: reader,
      });
      const scene = decodeLivingScene(
        await (
          await sceneWorker.fetch(
            new Request("http://local.test/v1/runtime/scene", {
              method: "POST",
              headers: {
                authorization: "Bearer hall-inspect",
                "content-type": "application/json",
              },
              body: JSON.stringify({ version: 1, ...auth.scope }),
            }),
          )
        ).json(),
      );
      vi.useFakeTimers();
      const pending: {
        resolve: (response: Response) => void;
        reject: (error: Error) => void;
      }[] = [];
      const transport = vi.fn(
        (_url: URL, _options: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            pending.push({ resolve, reject });
          }),
      );
      vi.stubGlobal("fetch", transport);
      const fixture = sceneSession();
      const { session, sockets } = fixture;
      const companion = decodeOpaqueId("fixture.companion", "ObjectId");
      const snack = decodeOpaqueId("fixture.snack-dish", "ObjectId");
      try {
        session.replace("hall-inspect", auth.scope);
        await fixture.deliver(scene);
        const adapter = new Headless3DAdapter();
        const committed = session.getSnapshot().projection;
        if (!committed) throw new Error("missing committed projection");
        adapter.onIntent(({ objectId }) => session.select(objectId));
        adapter.loadSnapshot(committed);
        // The real planar observation becomes one 3D node per canonical object, at z = 0.
        expect(
          [...adapter.nodes.values()].map(({ objectId, presentation }) => ({
            objectId,
            presentation,
          })),
        ).toEqual(scene.entities.map(({ objectId, presentation }) => ({ objectId, presentation })));
        expect(adapter.nodes.get(companion)).toEqual({
          objectId: "fixture.companion",
          group: "frame-grove@1",
          position: [8, 22, 0],
          presentation: { kind: "placeholder", label: "fixture.companion" },
        });
        adapter.pick(companion);
        expect(session.getSelectionSnapshot()).toEqual({
          objectId: companion,
          status: "loading",
          value: undefined,
        });
        session.select(snack);
        pending[1]?.resolve(Response.json(recent));
        await vi.advanceTimersByTimeAsync(0);
        const selected = { objectId: snack, status: "ready", value: recent };
        expect(session.getSelectionSnapshot()).toEqual(selected);
        pending[0]?.reject(new Error("obsolete selection failure"));
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSelectionSnapshot()).toEqual(selected);
        session.select(companion);
        pending[2]?.resolve(Response.json(earned));
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSelectionSnapshot()).toEqual({
          objectId: companion,
          status: "ready",
          value: earned,
        });
        session.refreshSelection();
        session.select(snack);
        pending[3]?.resolve(Response.json(earned));
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSelectionSnapshot()).toEqual({
          objectId: snack,
          status: "loading",
          value: undefined,
        });
        pending[4]?.resolve(Response.json(recent));
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSelectionSnapshot()).toEqual(selected);
        session.select(companion);
        sockets[0]?.receive({
          ...scene,
          revision: (BigInt(scene.revision) + 1n).toString(),
          entities: scene.entities.filter((entity) => entity.objectId !== companion),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSelectionSnapshot()).toEqual({
          objectId: undefined,
          status: "none",
          value: undefined,
        });
        pending[5]?.resolve(Response.json({ error: "authorization_refused" }, { status: 403 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSnapshot().status).toBe("ready");
        expect(session.getSelectionSnapshot()).toEqual({
          objectId: undefined,
          status: "none",
          value: undefined,
        });
        session.select(snack);
        const replacementScope = {
          ...auth.scope,
          spaceId: decodeOpaqueId("space-replacement", "SpaceId"),
        };
        session.replace("new-session", replacementScope);
        pending[6]?.resolve(Response.json({ error: "authentication_refused" }, { status: 401 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSnapshot().scope).toEqual(replacementScope);
        expect(session.getSelectionSnapshot()).toEqual({
          objectId: undefined,
          status: "none",
          value: undefined,
        });
        await fixture.deliver({ ...scene, ...replacementScope });
        session.select(snack);
        session.replace(undefined, undefined);
        pending[7]?.resolve(Response.json(recent));
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSnapshot().scope).toBe(undefined);
        expect(session.getSelectionSnapshot()).toEqual({
          objectId: undefined,
          status: "none",
          value: undefined,
        });
        session.replace("hall-inspect", auth.scope);
        await fixture.deliver(scene);
        session.select(snack);
        pending[8]?.reject(new Error("current selection failed"));
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSelectionSnapshot()).toEqual({
          objectId: snack,
          status: "unavailable",
          value: undefined,
        });
        session.select(snack);
        pending[9]?.resolve(Response.json(recent));
        await vi.advanceTimersByTimeAsync(0);
        session.earlierActions();
        expect(session.getSelectionSnapshot()).toEqual({
          objectId: snack,
          status: "loading",
          value: undefined,
        });
        const earlierCall = transport.mock.calls[10];
        expect(earlierCall?.[0].href).toBe("http://local.test/v1/runtime/entity");
        expect(JSON.parse(String(earlierCall?.[1].body))).toEqual({
          version: 1,
          ...auth.scope,
          objectId: snack,
          cursor: {
            observedRevision: recent.revision,
            beforeSequence: recent.history.beforeSequence,
          },
        });
        pending[10]?.resolve(Response.json(earlier));
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSelectionSnapshot()).toEqual({
          objectId: snack,
          status: "ready",
          value: earlier,
        });
        session.earlierActions();
        expect(transport.mock.calls.length).toBe(11);
        session.select(companion);
        pending[11]?.resolve(Response.json(earned));
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSelectionSnapshot()).toEqual({
          objectId: companion,
          status: "ready",
          value: earned,
        });
        expect(session.getSelectionSnapshot().value?.history).toEqual({
          observedRevision: "0",
          actions: [],
          beforeSequence: null,
        });
        expect(transport.mock.calls.map(([url]) => url.pathname)).toEqual(
          Array.from({ length: 12 }, () => "/v1/runtime/entity"),
        );
        adapter.destroy();
      } finally {
        session.replace(undefined, undefined);
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });
  });
}, 120_000);
