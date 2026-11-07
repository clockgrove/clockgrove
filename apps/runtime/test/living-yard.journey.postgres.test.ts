import { InMemoryRuntimeLogger } from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import { PostgreSqlWorldOwnerReader } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { PostgreSqlLivingSceneReader } from "../src/observation.js";
import { RuntimeWorker } from "../src/worker.js";
import { livingYardAuthentication } from "./living-yard-fixture.js";
import {
  type DatabaseFixture,
  provisionTestWorld,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

it("authorizes durable living-yard observations, redacts failures and logs reads without commands", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("raccoons");
    const provisioned = await provisionTestWorld(fixture, world, "principal-yard-observer");
    const auth = livingYardAuthentication(provisioned);
    const truth = truthOf(fixture);
    const commands = () => truth("SELECT count(*) FROM clockgrove.command_receipts");
    const beforeCommands = await commands();
    await withClient(fixture.environment, async (client) => {
      const reader = new PostgreSqlLivingSceneReader(new PostgreSqlWorldOwnerReader(client));
      const logger = new InMemoryRuntimeLogger();
      const worker = new RuntimeWorker(
        auth.authenticator,
        {
          getSpace: () => {
            throw new Error("observation must not create a command owner");
          },
          observation: reader,
        },
        logger,
      );
      const request = (credential = "yard-inspect", scope = auth.scope) =>
        new Request("http://local.test/v1/runtime/scene", {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
            "x-correlation-id": "correlation-yard-read",
          },
          body: JSON.stringify({ version: 1, ...scope }),
        });
      const anonymous = await worker.fetch(
        new Request("http://local.test/v1/runtime/scene", {
          method: "POST",
          body: JSON.stringify({ version: 1, ...auth.scope }),
        }),
      );
      expect([anonymous.status, await anonymous.json()]).toEqual([
        401,
        { error: "authentication_refused" },
      ]);
      const invalid = await worker.fetch(request("invalid"));
      expect([invalid.status, await invalid.json()]).toEqual([
        401,
        { error: "authentication_refused" },
      ]);
      const crossScope = await worker.fetch(
        request("yard-inspect", {
          ...auth.scope,
          spaceId: decodeOpaqueId("space-other", "SpaceId"),
        }),
      );
      expect([crossScope.status, await crossScope.json()]).toEqual([
        403,
        { error: "authorization_refused" },
      ]);
      const successful = await worker.fetch(request());
      expect(successful.status).toBe(200);
      expect(
        logger.records.map(
          ({ event, schemaVersion, status, authorization, outcome, code, commandId }) => ({
            event,
            schemaVersion,
            status,
            authorization,
            outcome,
            code,
            commandId,
          }),
        ),
      ).toEqual([
        {
          event: "scene_observation_answered",
          schemaVersion: 5,
          status: 401,
          authorization: "unauthenticated",
          outcome: "refused",
          code: "authentication_refused",
          commandId: undefined,
        },
        {
          event: "scene_observation_answered",
          schemaVersion: 5,
          status: 401,
          authorization: "unauthenticated",
          outcome: "refused",
          code: "authentication_refused",
          commandId: undefined,
        },
        {
          event: "scene_observation_answered",
          schemaVersion: 5,
          status: 403,
          authorization: "denied",
          outcome: "refused",
          code: "authorization_refused",
          commandId: undefined,
        },
        {
          event: "scene_observation_answered",
          schemaVersion: 5,
          status: 200,
          authorization: "authorized",
          outcome: "read",
          code: undefined,
          commandId: undefined,
        },
      ]);
      const failures = new InMemoryRuntimeLogger();
      const sensitivePassword = ["pa", "ss"].join("");
      const sensitiveUrl = new URL("postgres://user@local/db");
      sensitiveUrl.password = sensitivePassword;
      const failedWorker = new RuntimeWorker(
        auth.authenticator,
        {
          getSpace: () => {
            throw new Error("observation must not route a command");
          },
          observation: {
            observe: async () => {
              throw new Error(`${["token", "private"].join("=")} ${sensitiveUrl}`);
            },
          },
        },
        failures,
      );
      const failed = await failedWorker.fetch(request());
      expect([failed.status, await failed.json()]).toEqual([500, { error: "inspection_failed" }]);
      expect(
        failures.records.map(
          ({
            event,
            schemaVersion,
            commandId,
            correlationId,
            failureClass,
            status,
            outcome,
            code,
          }) => ({
            event,
            schemaVersion,
            commandId,
            correlationId,
            failureClass,
            status,
            outcome,
            code,
          }),
        ),
      ).toEqual([
        {
          event: "scene_observation_failed",
          schemaVersion: 5,
          commandId: undefined,
          correlationId: "correlation-yard-read",
          failureClass: "internal",
          status: undefined,
          outcome: undefined,
          code: undefined,
        },
        {
          event: "scene_observation_answered",
          schemaVersion: 5,
          commandId: undefined,
          correlationId: "correlation-yard-read",
          failureClass: "internal",
          status: 500,
          outcome: "failed",
          code: "inspection_failed",
        },
      ]);
      expect(failures.records[0]?.error?.message).toBe("token=[redacted] [url]");
      expect(JSON.stringify(failures.records)).not.toMatch(/private|user:pass|yard-inspect|Bearer/);
      expect(await commands()).toBe(beforeCommands);
    });
  });
}, 120_000);
