import { executeWorldCommand } from "@clockgrove/application";
import {
  decodeEntitySelection,
  decodeInfluenceReceipt,
  decodeOpaqueId,
  decodePrivacyCeiling,
  decodeRecordedWhy,
  decodeSayReceipt,
  type SceneConnectionAttachment,
} from "@clockgrove/contracts";
import { PostgreSqlWorldCommandJournal } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { DeterministicTestAuthProvider } from "../local/test-auth.js";
import { PostgreSqlCausalInspector } from "../src/inspector.js";
import {
  PostgreSqlEntitySelectionReader,
  PostgreSqlLivingSceneReader,
  PostgreSqlSceneStreamReader,
} from "../src/observation.js";
import { RuntimeWorker } from "../src/worker.js";
import { PostgreSqlCommandOwner } from "../src/world-commands.js";
import { observationAuthenticator } from "./living-hall-fixture.js";
import {
  advanceCommand,
  commandRequest,
  type DatabaseFixture,
  provisionTestWorld,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

it("explains why Keeper sought shelter from authorized deterministic evidence and receipts every interaction intent", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-caretaker");
    const { partition, authorization } = provisioned;
    const scope = { ...partition.target, spaceId: partition.route.spaceId };
    const truth = truthOf(fixture);
    const provider = new DeterministicTestAuthProvider(() => 100);
    const identity = { provider: "test-auth", environment: "local", subject: "caretaker" };
    provider.linkAccount(
      identity,
      decodeOpaqueId("identity-caretaker", "ExternalIdentityId"),
      authorization.principalId,
    );
    provider.applyEvent({
      eventId: "caretaker-session",
      revision: 1,
      credential: "caretaker",
      identity,
      expiresAt: 200,
      revoked: false,
    });
    const observe = decodeOpaqueId("runtime:world-observe", "GrantRef");
    const command = decodeOpaqueId("runtime:world-command", "GrantRef");
    let grants = [observe, command];
    let categories = ["public_scene", "conversation"];
    const authenticator = observationAuthenticator(provider, {
      resolveWorld: async () => ({
        ...scope,
        principalId: authorization.principalId,
        membershipId: decodeOpaqueId("membership-caretaker", "WorldMembershipId"),
        personaId: decodeOpaqueId("persona-caretaker", "WorldPersonaId"),
        roles: [],
        grants,
        privacyCeiling: decodePrivacyCeiling({ version: 1, allowedCategories: categories }),
      }),
    });
    const run = async (key: string, type: string, payload: unknown) => {
      const { revision } = (
        await new PostgreSqlCommandOwner(client).reader.hydrate(authorization, scope)
      ).document.state;
      // Object and resource commands name the revision they expect; world commands need none.
      const base = advanceCommand(world, key, 0n, type.startsWith("world.") ? null : revision);
      return executeWorldCommand(
        commandRequest(provisioned, { ...base, type, payload } as typeof base),
        {
          journal: new PostgreSqlWorldCommandJournal(client),
          behavior: provisioned.behavior,
        },
      );
    };
    let client!: Parameters<Parameters<typeof withClient>[1]>[0];
    await withClient(fixture.environment, async (connected) => {
      client = connected;
      const owner = new PostgreSqlCommandOwner(client);
      const selected = new PostgreSqlEntitySelectionReader(client);
      const observer = new PostgreSqlLivingSceneReader(owner.reader);
      const worker = new RuntimeWorker(authenticator, {
        getSpace: () => {
          throw new Error("interactions route no space owner");
        },
        inspector: new PostgreSqlCausalInspector(client),
        observation: {
          observe: (target, context) => observer.observe(target, context),
          select: (input, context) => selected.select(input, context, 100n),
        },
        worldCommands: {
          prepare: async (input, principalId) => {
            const stored = await owner.stored(input, principalId);
            return { tenantMember: true, ready: true, ...(stored === undefined ? {} : { stored }) };
          },
          submit: (input, context) => owner.submit(input, context),
          deny: (input, principalId, denial) => owner.deny(input, principalId, denial),
          prepareBuilt: (target, principalId, commandId, build) =>
            owner.prepareBuilt(target, principalId, commandId, build),
        },
      });
      const post = async (endpoint: string, fields: object) => {
        const response = await worker.fetch(
          new Request(`http://local.test/v1/runtime/${endpoint}`, {
            method: "POST",
            headers: { authorization: "Bearer caretaker", "content-type": "application/json" },
            body: JSON.stringify({ version: 1, ...scope, ...fields }),
          }),
        );
        return [response.status, await response.json()] as const;
      };

      // Rain falls, Keeper is walked to the porch, and the next routine decision is recorded.
      const born = world.birth.state.simulationTime;
      const advance = (key: string, targetTime: bigint) =>
        run(key, "world.advance", { schemaVersion: 1, targetTime, maxInputs: 64, maxEvents: 256 });
      const setup = [
        await run("rain", "world.weather.set", { schemaVersion: 2, rainIntensity: 10000 }),
        await advance("first-decision", born + 1n),
        await run("walk", "movement.start", {
          schemaVersion: 1,
          objectId: "fixture.keeper",
          destination: {
            kind: "pose",
            pose: { frameId: "frame-grove", frameVersion: 1, coordinates: [8000n, 8000n] },
          },
          unitsPerSecond: 1000n,
        }),
        await advance("storm-decision", born + world.behavior.policy.decisionIntervalMs),
      ];
      expect(setup.map((result) => result.outcome)).toEqual(Array(4).fill("committed"));

      // The server's own policy evaluation, per reader authority, on the scene stream.
      const scene = (facts: {
        categories: ("public_scene" | "conversation")[];
        command: boolean;
      }) =>
        authenticator
          .identify(
            new Request("http://local.test/v1/runtime/scene", {
              method: "POST",
              headers: { authorization: "Bearer caretaker" },
              body: JSON.stringify({ version: 1, ...scope }),
            }),
          )
          .then((identified) =>
            authenticator.authorize(
              identified,
              {
                requestId: "scene-read",
                correlationId: decodeOpaqueId("correlation-scene", "CorrelationId"),
              },
              "runtime:world-observe",
            ),
          )
          .then((context) =>
            new PostgreSqlSceneStreamReader(client).read(
              {
                principalId: authorization.principalId,
                acknowledgedRevision: null,
                connectionVersion: 1,
                audience: {
                  ...scope,
                  privacyClass: "public_scene",
                  interest: { selection: null, conversation: false, operator: false },
                },
              } as SceneConnectionAttachment,
              null,
              context,
              { ...facts, inspect: false },
            ),
          )
          .then(({ projection }) =>
            Object.fromEntries(
              projection.interactions
                .filter(({ entityId }) =>
                  ["fixture.keeper", "fixture.snack-dish", "fixture.den"].includes(entityId),
                )
                .map(({ entityId, mode, actions }) => [entityId, [mode, actions]]),
            ),
          );
      expect(await scene({ categories: ["public_scene", "conversation"], command: true })).toEqual({
        "fixture.den": [
          "inspectable",
          [
            { kind: "inspect", availability: "enabled" },
            { kind: "history", availability: "enabled" },
          ],
        ],
        "fixture.snack-dish": [
          "reactive",
          [
            { kind: "inspect", availability: "enabled" },
            { kind: "history", availability: "enabled" },
            { kind: "influence", availability: "enabled" },
          ],
        ],
        "fixture.keeper": [
          "reactive",
          [
            { kind: "inspect", availability: "enabled" },
            { kind: "history", availability: "enabled" },
            { kind: "why", availability: "enabled" },
            { kind: "talk", availability: "enabled" },
          ],
        ],
      });
      const observerOnly = await scene({ categories: ["public_scene"], command: false });
      expect([
        observerOnly["fixture.keeper"]?.[1]?.[3],
        observerOnly["fixture.snack-dish"]?.[1]?.[2],
      ]).toEqual([
        { kind: "talk", availability: "disabled", reason: "conversation_not_permitted" },
        { kind: "influence", availability: "disabled", reason: "command_grant_required" },
      ]);

      // Exit: Inspect, History and Why explain the shelter-seeking from recorded evidence only.
      const [selectionStatus, selection] = await post("entity", { objectId: "fixture.keeper" });
      expect(selectionStatus).toBe(200);
      const keeper = decodeEntitySelection(selection);
      expect(keeper.physical.selectedAction).toEqual({
        kind: "seek-shelter",
        targetObjectId: "fixture.porch",
      });
      const decision = keeper.history.actions.find((action) => action.type === "routine.selected");
      expect(decision?.commandId).toBe("storm-decision");
      const [whyStatus, whyBody] = await post("why", { commandId: "storm-decision" });
      expect(whyStatus).toBe(200);
      const why = decodeRecordedWhy(whyBody);
      const trace = why.traces.drafts.filter((draft) => draft.objectId === "fixture.keeper").at(-1);
      // Rain and wetness against the porch's protection outscore staying; nothing else is perceived.
      expect([trace?.simulationTime, trace?.selectedAction]).toEqual([
        "8674560000",
        { kind: "seek-shelter", targetObjectId: "fixture.porch" },
      ]);
      const chosen = trace?.candidates.find((c) => c.action.targetObjectId === "fixture.porch");
      expect([
        chosen?.score,
        Object.fromEntries(chosen?.features.map(({ name, value }) => [name, value]) ?? []),
      ]).toEqual([
        "70000000",
        {
          U: "10000",
          expectation: "0",
          health: "10000",
          hunger: "3320",
          perceived: "10000",
          protection: "5000",
          rain: "10000",
          thirst: "40",
          travelMs: "0",
          uncomfortable: "10000",
          wetness: "4000",
        },
      ]);
      expect(JSON.stringify(why)).not.toMatch(
        /counterfactual|beliefRefs|memoryRefs|privacyCeiling/,
      );
      // The protected decision evidence is audited: the Why read and its parent's link read.
      expect(
        await truth(
          "SELECT string_agg(principal_id || ' ' || reason_code, ',') FROM clockgrove.inspector_accesses",
        ),
      ).toBe(`${authorization.principalId} served,${authorization.principalId} served`);

      // Influence proposes; the world accepts, commits and records the consequence, attributed.
      const before = await truth("SELECT count(*) FROM clockgrove.command_receipts");
      const { revision } = (await owner.reader.hydrate(authorization, scope)).document.state;
      const intent = {
        intentId: "offer-1",
        objectId: "fixture.water-bowl",
        resourceKind: "water",
        expectedRevision: revision.toString(),
      };
      const [offered, offeredBody] = await post("influence", intent);
      const receipt = decodeInfluenceReceipt(offeredBody);
      expect([offered, receipt.status, receipt.attribution]).toEqual([
        200,
        "committed",
        { principalId: authorization.principalId, personaId: "persona-caretaker" },
      ]);
      expect(
        receipt.status === "committed" && receipt.consequences.map((event) => event.type),
      ).toEqual(["resource.offered"]);
      // A retried intent replays its stored receipt; another proposal under its ID is a reuse.
      expect(await post("influence", intent)).toEqual([200, offeredBody]);
      expect(await post("influence", { ...intent, resourceKind: "food" })).toEqual([
        409,
        { error: "command_id_reused" },
      ]);
      expect(
        await truth(
          `SELECT status || ' ' || (attribution->>'personaId') || ' ' || (attribution->>'effectiveActorId') FROM clockgrove.command_receipts WHERE command_id = '${receipt.commandId}'`,
        ),
      ).toBe(`committed persona-caretaker ${authorization.principalId}`);
      // Without the command grant the intent is rejected, and the rejection is a recorded receipt.
      grants = [observe];
      const [rejected, rejectedBody] = await post("influence", { ...intent, intentId: "offer-2" });
      expect([rejected, decodeInfluenceReceipt(rejectedBody).status]).toEqual([403, "rejected"]);
      expect(await truth("SELECT count(*) FROM clockgrove.command_receipts")).toBe(
        String(Number(before) + 2),
      );

      // Public Say is explicit and scripted; private Talk lives in conversation sessions, which
      // fail closed without an artifact keyring and need the conversation category.
      const say = { messageId: "say-1", actorId: "fixture.keeper", text: "Stay dry, Keeper." };
      const [sayStatus, sayBody] = await post("say", say);
      const spoken = decodeSayReceipt(sayBody);
      expect([sayStatus, spoken.speech.speakerId, spoken.speech.text, spoken.attribution]).toEqual([
        200,
        "fixture.keeper",
        "Chitters aloud (scripted fixture line).",
        { principalId: authorization.principalId, personaId: "persona-caretaker" },
      ]);
      expect(JSON.stringify(spoken)).not.toContain("Stay dry");
      // Only a projected actor is addressed: not a resource, nor an unknown ID.
      expect(await post("say", { ...say, actorId: "fixture.water-bowl" })).toEqual([
        409,
        { error: "talk_unavailable" },
      ]);
      expect(await post("say", { ...say, actorId: "fixture.nobody" })).toEqual([
        409,
        { error: "selection_unavailable" },
      ]);
      const open = { actorId: "fixture.keeper" };
      expect(await post("conversations/create", open)).toEqual([
        503,
        { error: "conversation_unavailable" },
      ]);
      categories = ["public_scene"];
      expect(await post("conversations/create", open)).toEqual([
        403,
        { error: "authorization_refused" },
      ]);
      expect(await truth("SELECT count(*) FROM clockgrove.command_receipts")).toBe(
        String(Number(before) + 2),
      );
    });
  });
}, 120_000);
