import { executeWorldCommand } from "@clockgrove/application";
import { decodeOpaqueId, decodeWorldStatus } from "@clockgrove/contracts";
import { PostgreSqlWorldCommandJournal } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { PostgreSqlWorldStatusReader } from "../src/observation.js";
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

it("feed is derived from authorized semantic events, not raw logs, beside the canonical clock", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-status");
    const auth = livingHallAuthentication(provisioned);
    const truth = truthOf(fixture);
    await withClient(fixture.environment, async (client) => {
      const reader = new PostgreSqlWorldStatusReader(client);
      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("the status read must not route a command");
        },
        observation: {
          observe: async () => {
            throw new Error("the status read reads no scene");
          },
          status: (scope, context) => reader.read(scope, context),
        },
      });
      const read = (credential = "hall-inspect", scope = auth.scope) =>
        worker.fetch(
          new Request("http://local.test/v1/runtime/world-status", {
            method: "POST",
            headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
            body: JSON.stringify({ version: 1, ...scope }),
          }),
        );
      const status = async () => {
        const response = await read();
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(JSON.stringify(body)).not.toMatch(/kernelEvent|rainIntensity|quantity|test-auth/);
        return decodeWorldStatus(body);
      };
      const run = async (
        key: string,
        type: string,
        payload: object,
        targetTime = 0n,
        revision?: string,
      ) =>
        expect(
          await executeWorldCommand(
            {
              ...commandRequest(provisioned, {
                ...advanceCommand(
                  world,
                  key,
                  targetTime,
                  revision === undefined ? null : BigInt(revision),
                ),
                ...(type === "world.advance" ? {} : { type, payload }),
              }),
              trustedWallTime: () => 0n,
            },
            { journal: new PostgreSqlWorldCommandJournal(client), behavior: provisioned.behavior },
          ),
        ).toMatchObject({ outcome: "committed" });
      const clock = (runState: string, speed: number, minutes = 0n) => ({
        simulationTime: (8_640_000_000n + minutes * 60_000n).toString(),
        runState,
        speed,
        dayLengthMs: "86400000",
        day: "101",
        timeOfDayMs: (minutes * 60_000n).toString(),
      });
      const born = await status();
      expect([born.revision, born.clock, born.feed]).toEqual(["0", clock("paused", 1), []]);
      await run("status-rain", "world.weather.set", { schemaVersion: 2, rainIntensity: 10000 });
      const rained = await status();
      expect(rained.feed.map(({ category, objectId, text }) => [category, objectId, text])).toEqual(
        [["weather", null, "It is raining."]],
      );
      await run(
        "status-offer",
        "resource.transfer",
        {
          schemaVersion: 1,
          fromObjectId: "fixture.household-food",
          toObjectId: "fixture.snack-dish",
          kind: "food",
          quantity: 1,
        },
        0n,
        rained.revision,
      );
      await run("status-minute", "world.advance", {}, 8_640_060_000n);
      const fed = await status();
      expect([
        fed.clock,
        fed.feed.map(({ category, objectId, text }) => [category, objectId, text]),
      ]).toEqual([
        clock("paused", 1, 1n),
        [
          ["movement", "fixture.dependent", "fixture.dependent arrived."],
          ["routine", "fixture.keeper", "fixture.keeper is staying put."],
          [
            "routine",
            "fixture.dependent",
            "fixture.dependent is looking for shelter at fixture.den.",
          ],
          [
            "routine",
            "fixture.companion",
            "fixture.companion is looking for shelter at fixture.den.",
          ],
          [
            "resource",
            "fixture.snack-dish",
            "Food moved from fixture.household-food to fixture.snack-dish.",
          ],
          ["weather", null, "It is raining."],
        ],
      ]);
      const materialTypes = `('weather.changed','weather.transitioned','environment.phase-changed','routine.selected','needs.threshold-crossed','exposure.threshold-crossed','health.threshold-crossed','growth.stage-changed','movement.portal-crossed','movement.completed','portal.opened','portal.closed','resource.offered','resource.consumed','resource.transferred','resource.spoiled')`;
      const material = JSON.parse(
        await truth(
          `SELECT jsonb_agg(jsonb_build_object('id', event_id, 'simTimeMs', simulation_time::text, 'kind', 'material', 'sourceEventIds', jsonb_build_array(event_id)) ORDER BY partition_sequence DESC)::text
             FROM clockgrove.events WHERE privacy_class = 'public_scene' AND event_type IN ${materialTypes}`,
        ),
      );
      expect(
        fed.feed.map(({ id, simTimeMs, kind, sourceEventIds }) => ({
          id,
          simTimeMs: simTimeMs.toString(),
          kind,
          sourceEventIds,
        })),
      ).toEqual(material);
      const bookkeeping = JSON.parse(
        await truth(
          `SELECT jsonb_build_array(string_agg(DISTINCT event_type, ',' ORDER BY event_type), jsonb_agg(event_id))::text
             FROM clockgrove.events WHERE event_type NOT IN ${materialTypes}`,
        ),
      );
      expect(bookkeeping[0]).toBe(
        "WorldGenesisCreated,WorldProjectionVerified,WorldReady,growth.integrated,location.changed,movement.region-exited,movement.started,needs.changed,resource.weather-integrated,wellbeing.integrated",
      );
      expect(fed.feed.filter((item) => bookkeeping[1].includes(item.id))).toEqual([]);
      await run("status-resume", "ResumeWorld", { schemaVersion: 1 });
      expect((await status()).clock).toEqual(clock("running", 1, 1n));
      await run("status-speed", "SetClockPolicy", {
        schemaVersion: 1,
        simulationMillisecondsPerWallMillisecond: 60,
        catchUpCapMs: 1_000_000_000n,
      });
      expect((await status()).clock).toEqual(clock("running", 60, 1n));
      await run("status-pause", "PauseWorld", { schemaVersion: 1 });
      const paused = await status();
      expect([paused.clock, paused.feed]).toEqual([clock("paused", 60, 1n), fed.feed]);
      const refused = async (credential?: string, scope = auth.scope) => {
        const response = await read(credential, scope);
        return [response.status, await response.json()];
      };
      expect(await refused("invalid")).toEqual([401, { error: "authentication_refused" }]);
      const otherSpace = { ...auth.scope, spaceId: decodeOpaqueId("space-other", "SpaceId") };
      expect(await refused(undefined, otherSpace)).toEqual([
        403,
        { error: "authorization_refused" },
      ]);
      auth.revoke();
      expect(await refused()).toEqual([403, { error: "authorization_refused" }]);
      auth.withoutPublicScene();
      expect(await refused()).toEqual([403, { error: "authorization_refused" }]);
    });
  });
}, 120_000);
