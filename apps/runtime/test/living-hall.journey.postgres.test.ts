import { CAPABILITY_REGISTRY, InMemoryRuntimeLogger } from "@clockgrove/application";
import { type ConversationSession, decodeOpaqueId } from "@clockgrove/contracts";
import {
  createModelGateway,
  InMemoryModelBudget,
  PRODUCTION_ALIASES,
  ScriptedModelProvider,
} from "@clockgrove/model-gateway";
import { PostgreSqlWorldOwnerReader } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { actorPreparedResponder } from "../src/actor-model.js";
import { perceiveScene, type RuntimeEnvironment } from "../src/cloudflare-entry.js";
import { PostgreSqlLivingSceneReader } from "../src/observation.js";
import { RuntimeWorker } from "../src/worker.js";
import { livingHallAuthentication } from "./living-hall-fixture.js";
import {
  connectionString,
  type DatabaseFixture,
  provisionTestWorld,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

it("authorizes durable living-hall observations, redacts failures and logs reads without commands", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-hall-observer");
    const auth = livingHallAuthentication(provisioned);
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
      const request = (credential = "hall-inspect", scope = auth.scope) =>
        new Request("http://local.test/v1/runtime/scene", {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
            "x-correlation-id": "correlation-hall-read",
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
        request("hall-inspect", {
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
          schemaVersion: 6,
          status: 401,
          authorization: "unauthenticated",
          outcome: "refused",
          code: "authentication_refused",
          commandId: undefined,
        },
        {
          event: "scene_observation_answered",
          schemaVersion: 6,
          status: 401,
          authorization: "unauthenticated",
          outcome: "refused",
          code: "authentication_refused",
          commandId: undefined,
        },
        {
          event: "scene_observation_answered",
          schemaVersion: 6,
          status: 403,
          authorization: "denied",
          outcome: "refused",
          code: "authorization_refused",
          commandId: undefined,
        },
        {
          event: "scene_observation_answered",
          schemaVersion: 6,
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
          schemaVersion: 6,
          commandId: undefined,
          correlationId: "correlation-hall-read",
          failureClass: "internal",
          status: undefined,
          outcome: undefined,
          code: undefined,
        },
        {
          event: "scene_observation_answered",
          schemaVersion: 6,
          commandId: undefined,
          correlationId: "correlation-hall-read",
          failureClass: "internal",
          status: 500,
          outcome: "failed",
          code: "inspection_failed",
        },
      ]);
      expect(failures.records[0]?.error?.message).toBe("token=[redacted] [url]");
      expect(JSON.stringify(failures.records)).not.toMatch(/private|user:pass|hall-inspect|Bearer/);
      expect(await commands()).toBe(beforeCommands);
    });
  });
}, 120_000);

it("an actor's prompt lists what it perceives on the canonical read, named first, then nearest", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const provisioned = await provisionTestWorld(
      fixture,
      await testWorld("fixture/reference"),
      "principal-hall-observer",
    );
    const auth = livingHallAuthentication(provisioned);
    const context = await auth.authenticator.authorize(
      await auth.authenticator.identify(
        new Request("http://local.test/v1/runtime/scene", {
          method: "POST",
          headers: { authorization: "Bearer hall-inspect" },
          body: JSON.stringify({ version: 1, ...auth.scope, commandId: "perception-read" }),
        }),
      ),
      undefined,
      "runtime:world-observe",
    );
    const env = {
      HYPERDRIVE: { connectionString: connectionString(fixture.environment) },
    } as RuntimeEnvironment;
    const route = "vercel-ai-gateway/claude-opus-5.5";
    const answer = { kind: "reply" as const, chunks: ['{"reply":"Yes.","command":null}'] };
    const provider = new ScriptedModelProvider({
      [route]: [answer, answer, answer].map((reply) => ({
        ...reply,
        inputTokens: 10,
        outputTokens: 5,
      })),
    });
    // The runtime's composition: the responder asks with the session's actor and the message.
    const prepare = actorPreparedResponder({
      gateway: createModelGateway({
        aliases: PRODUCTION_ALIASES,
        adapters: { "vercel-ai-gateway": provider, anthropic: provider },
        budget: new InMemoryModelBudget(() => 5_000_000),
        accounting: { record: () => undefined },
      }),
      grants: () => CAPABILITY_REGISTRY.grantsFor(["runtime:world-observe"]),
      perceive: (scope, _participant, focus) => perceiveScene(env, scope, context, focus),
    });
    const session = {
      sessionId: "session-perceive",
      actorId: "fixture.keeper",
      participants: [{ principalId: "principal-hall-observer", personaId: "persona-hall" }],
      scope: auth.scope,
    } as unknown as ConversationSession;
    const perceived = async (actorId: string, message: string) => {
      const asked = { ...session, actorId } as unknown as ConversationSession;
      await (await prepare(asked, 1, message, `CARETAKER: ${message}`)).send();
      const prompt = provider.calls.at(-1)?.system ?? "";
      return prompt
        .slice(prompt.indexOf("You perceive:\n"))
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2, line.indexOf(":")));
    };
    // The keeper's space, nearest first from where it stands (itself at distance 0), ties by id.
    const yard = [
      "fixture.keeper",
      "fixture.trash-can",
      "fixture.porch",
      "fixture.water-bowl",
      "fixture.herb",
      "fixture.sky",
      "fixture.cedar",
      "fixture.cedar-hollow",
      "fixture.fence-gate",
      "fixture.dependent",
      "fixture.companion",
      "fixture.den",
      "fixture.den-stash",
      "fixture.snack-dish",
      "fixture.pantry-bin",
    ];
    expect(await perceived("fixture.keeper", "How is the yard?")).toEqual(yard);
    // The bowl the message names comes first; the rest keep their order.
    expect(await perceived("fixture.keeper", "Is fixture.water-bowl full?")).toEqual([
      "fixture.water-bowl",
      ...yard.filter((id) => id !== "fixture.water-bowl"),
    ]);
    // An actor standing in the household store perceives nothing of the yard's scene.
    expect(await perceived("fixture.household-food", "Is fixture.water-bowl full?")).toEqual([]);
  });
}, 120_000);
