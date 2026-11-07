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
import { livingYardAuthentication } from "./living-yard-fixture.js";
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
    const world = await testWorld("raccoons");
    const provisioned = await provisionTestWorld(fixture, world, "principal-viewed-space");
    const auth = livingYardAuthentication(provisioned, ["grove.elsewhere"]);
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
            headers: { authorization: "Bearer yard-inspect", "content-type": "application/json" },
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
      const stevie = async () => {
        const state = (await owner.reader.hydrate(provisioned.authorization, auth.scope)).document
          .state;
        return { state, entity: state.entities.find((e) => e.objectId === "grove.stevie") };
      };
      const run = async (key: string, type: string, payload: unknown, time = 0n) => {
        const { state } = await stevie();
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
        selected: string | null = "grove.stevie",
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
        outside: await change("snack-house", "grove.stevie"),
        yard: await change("living-yard", "grove.stevie"),
        whole: await change(me.spaceId, "grove.stevie"),
        nobody: await change("snack-house", "grove.nobody"),
        none: await change("snack-house"),
        unavailable: await change("grove.elsewhere", "grove.stevie"),
        denied: await change("grove.forbidden", "grove.stevie"),
      });
      const beforeMove = await sql(facts);
      const yard = await navigate();
      expect(await sql(facts)).toBe(beforeMove);
      expect(yard).toEqual({
        outside: answered("stayed_within_space", me),
        yard: answered("followed", me),
        whole: answered("followed", me),
        nobody: answered("target_hidden", undefined, null),
        none: { status: 204, body: null },
        unavailable: answered("unavailable", undefined, null),
        denied: answered("permission_denied", undefined, null),
      });
      const home = (await stevie()).entity?.pose.coordinates;
      expect(home).toEqual([15000n, 8000n]);
      // Actor movement is its own typed command; navigation never moves the actor.
      const moved = await run("viewed-space-move", "movement.start", {
        schemaVersion: 1,
        objectId: "grove.stevie",
        destination: {
          kind: "pose",
          pose: { frameId: "frame-grove", frameVersion: 1, coordinates: [33000n, 13000n] },
        },
        unitsPerSecond: 1000n,
      });
      expect(moved.outcome).toBe("committed");
      expect((await stevie()).entity?.pose.coordinates).toEqual([33000n, 13000n]);
      const beforeInside = await sql(facts);
      expect(beforeInside).not.toBe(beforeMove);
      const inside = await navigate();
      expect(await sql(facts)).toBe(beforeInside);
      expect(inside).toEqual({
        ...yard,
        outside: answered("followed", me),
        yard: answered("stayed_within_space", me),
      });
      auth.revoke();
      expect(await change("snack-house", "grove.stevie")).toEqual(
        answered("permission_denied", undefined, null),
      );
      expect(await sql(facts)).toBe(beforeInside);
    });
  });
});
