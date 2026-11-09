import { executeWorldCommand } from "@clockgrove/application";
import { PostgreSqlWorldCommandJournal } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
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

// Issue 41: a movement that moves the world time past queued decisions left them due in the past,
// and the next command was refused with `invalid-input` at `schedules`.
it("commits ordinary commands after a movement moved the world time past queued decisions", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-movement-schedules");
    const { scope } = livingHallAuthentication(provisioned);
    const sql = truthOf(fixture);
    const durable = () =>
      sql(
        "SELECT (SELECT simulation_time::text FROM clockgrove.partition_states) || '|' || (SELECT string_agg(kind || ':' || tie_break_key || ':' || due_at, ',' ORDER BY tie_break_key) FROM clockgrove.partition_schedules WHERE status = 'pending')",
      );
    await withClient(fixture.environment, async (client) => {
      const owner = new PostgreSqlCommandOwner(client);
      const run = async (key: string, type: string, payload: unknown, targetTime = 0n) => {
        const { revision } = (await owner.reader.hydrate(provisioned.authorization, scope)).document
          .state;
        const command = { ...advanceCommand(world, key, targetTime, revision), type, payload };
        const result = await executeWorldCommand(commandRequest(provisioned, command), {
          journal: new PostgreSqlWorldCommandJournal(client),
          behavior: provisioned.behavior,
        });
        return result.outcome;
      };
      // At birth every actor's first decision is due now.
      const decisions = (at: string) =>
        ["fixture.companion", "fixture.dependent", "fixture.keeper"].map(
          (id) => `world.decision:${id}:${at}`,
        );
      expect(await durable()).toBe(`8640000000|${decisions("8640000000").join(",")}`);
      expect(
        await run("issue-41-move", "movement.start", {
          schemaVersion: 1,
          objectId: "fixture.keeper",
          destination: {
            kind: "pose",
            pose: { frameId: "frame-grove", frameVersion: 1, coordinates: [33000n, 13000n] },
          },
          unitsPerSecond: 1000n,
        }),
      ).toBe("committed");
      // The walk took 22,207 ms; the decisions it passed are due at its arrival, for the next advance.
      expect(await durable()).toBe(`8640022207|${decisions("8640022207").join(",")}`);
      expect(
        await run("issue-41-rain", "world.weather.set", { schemaVersion: 2, rainIntensity: 3000 }),
      ).toBe("committed");
      expect(
        await run(
          "issue-41-advance",
          "world.advance",
          { schemaVersion: 1, targetTime: 8640060000n, maxInputs: 64, maxEvents: 256 },
          8640060000n,
        ),
      ).toBe("committed");
      expect(await durable()).toBe(`8640060000|${decisions("8726422207").join(",")}`);
    });
  });
}, 120_000);
