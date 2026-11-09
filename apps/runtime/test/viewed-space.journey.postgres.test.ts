import { executeWorldCommand } from "@clockgrove/application";
import { decodeFollowDisposition } from "@clockgrove/contracts";
import { PostgreSqlWorldCommandJournal } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { PostgreSqlViewedSpaceReader } from "../src/observation.js";
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

it("changes the viewed space and follows a selected actor with one of five dispositions, without changing any world fact", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-viewed-space");
    const auth = livingHallAuthentication(provisioned, ["fixture.elsewhere"]);
    const sql = truthOf(fixture);
    await withClient(fixture.environment, async (client) => {
      const viewed = new PostgreSqlViewedSpaceReader(client);
      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("navigation must not route a command");
        },
        changeViewedSpace: (input, authorize) => viewed.change(input, authorize),
      });
      const change = async (targetSpaceId: string, selectedEntityId?: string) => {
        const response = await worker.fetch(
          new Request("http://local.test/v1/runtime/viewed-space", {
            method: "POST",
            headers: { authorization: "Bearer hall-inspect", "content-type": "application/json" },
            body: JSON.stringify({
              type: "change_viewed_space",
              requestId: "navigation-request",
              scope: auth.scope,
              targetSpaceId,
              ...(selectedEntityId === undefined ? {} : { selectedEntityId }),
            }),
          }),
        );
        if (response.status === 204) return { status: 204, body: null };
        return { status: response.status, body: decodeFollowDisposition(await response.json()) };
      };
      const facts =
        "SELECT jsonb_build_object('state',(SELECT jsonb_agg(to_jsonb(s)) FROM clockgrove.partition_states s),'receipts',(SELECT count(*) FROM clockgrove.command_receipts))::text";
      const owner = new PostgreSqlCommandOwner(client);
      const keeper = async () => {
        const state = (await owner.reader.hydrate(provisioned.authorization, auth.scope)).document
          .state;
        return { state, entity: state.entities.find((e) => e.objectId === "fixture.keeper") };
      };
      const run = async (key: string, type: string, payload: unknown, time = 0n) => {
        const { state } = await keeper();
        const command = {
          ...advanceCommand(world, key, time, state.revision),
          type,
          payload,
        };
        return executeWorldCommand(commandRequest(provisioned, command), {
          journal: new PostgreSqlWorldCommandJournal(client),
          behavior: provisioned.behavior,
        });
      };
      const me = { ...auth.scope };
      const answered = (
        disposition: string,
        scope: typeof me | undefined,
        selected: string | null = "fixture.keeper",
      ) => ({
        status: 200,
        body: {
          requestId: "navigation-request",
          disposition,
          selectedEntityId: selected,
          ...(scope === undefined ? {} : { scope, authorized: true, projectable: true }),
        },
      });
      const navigate = async () => ({
        outside: await change("snack-house", "fixture.keeper"),
        hall: await change("living-hall", "fixture.keeper"),
        whole: await change(me.spaceId, "fixture.keeper"),
        nobody: await change("snack-house", "fixture.nobody"),
        none: await change("snack-house"),
        unavailable: await change("fixture.elsewhere", "fixture.keeper"),
        denied: await change("fixture.forbidden", "fixture.keeper"),
      });
      const beforeMove = await sql(facts);
      const hall = await navigate();
      expect(await sql(facts)).toBe(beforeMove);
      expect(hall).toEqual({
        outside: answered("stayed_within_space", me),
        hall: answered("followed", me),
        whole: answered("followed", me),
        nobody: answered("target_hidden", undefined, null),
        none: { status: 204, body: null },
        unavailable: answered("unavailable", undefined, null),
        denied: answered("permission_denied", undefined, null),
      });
      const home = (await keeper()).entity?.pose.coordinates;
      expect(home).toEqual([15000n, 8000n]);
      // Actor movement is its own typed command; navigation never moves the actor.
      const moved = await run("viewed-space-move", "movement.start", {
        schemaVersion: 1,
        objectId: "fixture.keeper",
        destination: {
          kind: "pose",
          pose: { frameId: "frame-grove", frameVersion: 1, coordinates: [33000n, 13000n] },
        },
        unitsPerSecond: 1000n,
      });
      expect(moved.outcome).toBe("committed");
      expect((await keeper()).entity?.pose.coordinates).toEqual([33000n, 13000n]);
      const beforeInside = await sql(facts);
      expect(beforeInside).not.toBe(beforeMove);
      const inside = await navigate();
      expect(await sql(facts)).toBe(beforeInside);
      expect(inside).toEqual({
        ...hall,
        outside: answered("followed", me),
        hall: answered("stayed_within_space", me),
      });
      auth.revoke();
      expect(await change("snack-house", "fixture.keeper")).toEqual(
        answered("permission_denied", undefined, null),
      );
      expect(await sql(facts)).toBe(beforeInside);
    });
  });
});
