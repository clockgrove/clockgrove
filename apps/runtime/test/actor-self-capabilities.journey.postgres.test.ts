import { createHash } from "node:crypto";
import {
  type ActivationAddress,
  CAPABILITY_REGISTRY,
  JOURNAL_EVENT_TYPES,
  type RuntimeAuthorizationContext,
  SELF_CAPABILITIES,
} from "@clockgrove/application";
import {
  type ConversationSession,
  type DocumentVersionView,
  decodeConversationSession,
  decodeLivingScene,
  type RunWalk,
} from "@clockgrove/contracts";
import {
  createModelGateway,
  InMemoryModelBudget,
  ScriptedModelProvider,
} from "@clockgrove/model-gateway";
import {
  boundedEvidence,
  PostgreSqlActivations,
  sessionSelfResults,
} from "@clockgrove/persistence";
import { expect, it } from "vitest";
import { actorResponder, standingOf } from "../src/actor-model.js";
import { advanceCommand } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/actor-self-capabilities.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const OPERATOR = "outsider-session-token";
const ACTOR = "fixture.keeper";
const GOALS = "Find acorns before winter.";
const NOTE = "Remember the rain on the porch.";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const COMMAND_GRANT = {
  callsPerTurn: 1,
  requiredRuntimeGrant: "runtime:world-command",
};

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      // The member talks and owns the activation policy; the operator governs and inspects documents.
      prepare: async (fixture) => {
        const { truthOf } = await import("./world-fixture.js");
        await truthOf(fixture)(
          `UPDATE clockgrove.world_memberships
              SET grants = array_append(grants, 'runtime:world-observe'),
                  privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation"]}';
           INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
             SELECT DISTINCT tenant_id, 'principal-outsider' FROM clockgrove.world_memberships;
           INSERT INTO clockgrove.world_memberships (
             tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id,
             roles, grants, privacy_ceiling, committed_at
           ) SELECT tenant_id, world_id, timeline_id, space_id, 'principal-outsider',
                    'membership-outsider', 'persona-outsider', roles,
                    grants || ARRAY['runtime:world-inspect', 'runtime:actor-govern'],
                    '{"version":1,"allowedCategories":["public_scene","conversation","private_cognition","operator_evidence"]}',
                    now()
               FROM clockgrove.world_memberships WHERE principal_id = 'principal-runtime'`,
        );
      },
    });
  },
  300_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "an actor governs its own subscriptions, intentions, perception, self-inspection and documents",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (path: string, fields: object, credential = MEMBER) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, credential);
      const activations = async (op: string, fields: object = {}) => {
        const response = await owner.request(
          `/v1/runtime/activations/${op}`,
          { version: 1, scope: owner.scope, actorId: ACTOR, ...fields },
          MEMBER,
        );
        expect(response.status).toBe(200);
        return response.body as {
          configurations: { id: string; kind: string; origin?: string; enabled: boolean }[];
        };
      };
      const operatorDocuments = await post(
        "/v1/runtime/actor-documents/change",
        {
          actorId: ACTOR,
          changeSetId: "goals-1",
          operations: [{ op: "create", path: "goals.md", content: GOALS }],
        },
        OPERATOR,
      );
      expect(operatorDocuments.status).toBe(200);
      const sessionId = decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId: ACTOR })).body,
      ).sessionId;
      const policy = (revokedCapabilities?: string[]) =>
        activations("configure", {
          // A low-priority witness subscription: it shares an event's wake with the actor's own
          // subscription while that exists and wakes alone once it is revoked.
          configuration: {
            id: "witness",
            sessionId,
            kind: "subscription",
            nextWakeAt: null,
            intervalMs: null,
            eventType: "ClockPolicyChanged",
            input: "",
            priority: 0,
            enabled: true,
            compiledRoutine: "noop",
          },
          policy: {
            allowModel: true,
            modelBudget: 10,
            ...(revokedCapabilities === undefined ? {} : { revokedCapabilities }),
          },
        });
      await policy();
      let turn = 0;
      const use = async (
        capability: string,
        input: object,
        speaker = { credential: MEMBER, sessionId },
      ) => {
        const messageId = `self-${++turn}`;
        const answer = await post(
          "/v1/runtime/talk",
          {
            sessionId: speaker.sessionId,
            messageId,
            text: `fixture:use ${capability} ${JSON.stringify(input)}`,
          },
          speaker.credential,
        );
        expect(answer.status).toBe(200);
        return JSON.parse(
          await owner.sql(
            `SELECT json_build_object('tool', s.tool, 'status', s.status, 'code', s.outcome_code,
                'summary', s.summary, 'evidence', s.capability_evidence, 'runId', s.run_id)::text
               FROM clockgrove.run_steps s JOIN clockgrove.agent_runs r
                 ON r.tenant_id = s.tenant_id AND r.run_id = s.run_id
              WHERE r.input_message_id = '${messageId}' AND r.status = 'completed'
                AND s.kind = 'world_command_proposal'`,
          ),
        ) as {
          tool: string;
          status: string;
          code: string | null;
          summary: string;
          runId: string;
          evidence: { grant: unknown; arguments: unknown; result: Record<string, unknown> };
        };
      };
      const activationsOf = (configurationId: string) =>
        owner.sql(
          `SELECT coalesce(string_agg(reason->>'kind' || '/' || status, ' ' ORDER BY causal_root), '')
             FROM clockgrove.actor_activations WHERE configuration_id = '${configurationId}'`,
        );
      const clock = async (key: string, type: "PauseWorld" | "ResumeWorld") =>
        expect(
          (
            await owner.submit({
              ...advanceCommand(owner.world, key, 0n, null),
              type,
              payload: { schemaVersion: 1 },
            })
          ).status,
        ).toBe(200);

      // Subscribe: the call is recorded with its grant, arguments and result, and the operator
      // sees the actor's own subscription.
      const subscribed = await use("subscription.create", {
        eventType: "ClockPolicyChanged",
        input: "The clock policy changed.",
      });
      const subscriptionId = subscribed.evidence.result.subscriptionId as string;
      expect(subscriptionId).toMatch(/^self-subscription-[0-9a-f]{24}$/u);
      expect(subscribed).toMatchObject({
        tool: "subscription.create",
        status: "succeeded",
        code: null,
        evidence: {
          grant: { capability: "subscription.create", ...COMMAND_GRANT },
          arguments: { eventType: "ClockPolicyChanged", input: "The clock policy changed." },
          result: { subscriptionId, eventType: "ClockPolicyChanged" },
        },
      });
      expect((await activations("inspect")).configurations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: subscriptionId, origin: "actor", enabled: true }),
        ]),
      );
      // An event type the journal cannot hold is refused with the valid types; nothing is made.
      expect(await use("subscription.create", { eventType: "dog.barked", input: "Woof." })).toEqual(
        expect.objectContaining({
          status: "failed",
          code: "unknown_event_type",
          evidence: expect.objectContaining({
            result: {
              refused: "unknown_event_type",
              eventType: "dog.barked",
              validEventTypes: [...JOURNAL_EVENT_TYPES],
            },
          }),
        }),
      );
      expect(JOURNAL_EVENT_TYPES).toContain("ClockPolicyChanged");
      expect((await activations("inspect")).configurations.map((c) => c.id).sort()).toEqual(
        [subscriptionId, "witness"].sort(),
      );
      // The event wakes the actor through its subscription, as an ordinary escalated activation.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await clock("self-pause", "PauseWorld");
      await expect.poll(() => activationsOf(subscriptionId)).toBe("subscription/completed");
      // Replaying the wake reproduces the same activation, never a second turn.
      const wakes = await owner.sql(
        `SELECT activation_id || '|' || causal_root || '|' || (reason->>'eventId')
           FROM clockgrove.actor_activations WHERE configuration_id = '${subscriptionId}'`,
      );
      const [activationId, causalRoot, eventId] = wakes.split("|");
      const replayed = await owner.request(
        "/v1/runtime/activations/wake",
        {
          version: 1,
          scope: owner.scope,
          actorId: ACTOR,
          wake: {
            configurationId: subscriptionId,
            causalRoot,
            reason: { kind: "subscription", subscriptionId, eventId },
            evidence: `journal:${eventId}`,
          },
        },
        MEMBER,
      );
      expect(replayed.body).toMatchObject({ activationId, status: "completed" });

      // Revoke: the next event wakes only the witness.
      expect(await use("subscription.revoke", { subscriptionId })).toMatchObject({
        status: "succeeded",
        evidence: { result: { subscriptionId } },
      });
      expect((await activations("inspect")).configurations.map((c) => c.id)).toEqual(["witness"]);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await clock("self-resume", "ResumeWorld");
      await expect.poll(() => activationsOf("witness")).toBe("subscription/noop");
      expect(await activationsOf(subscriptionId)).toBe("subscription/completed");

      // Schedule one intention that fires, and cancel another before it does.
      const due = await use("intention.schedule", { delaySeconds: 2, input: "Time to look." });
      const intentionId = due.evidence.result.intentionId as string;
      const later = await use("intention.schedule", { delaySeconds: 3_600, input: "Much later." });
      const laterId = later.evidence.result.intentionId as string;
      expect(await use("intention.cancel", { intentionId: laterId })).toMatchObject({
        status: "succeeded",
        evidence: { result: { intentionId: laterId } },
      });
      await expect.poll(() => activationsOf(intentionId)).toBe("scheduled_intention/completed");
      expect(await activationsOf(laterId)).toBe("");
      // A fired one-shot intention retires: its receipt stays, its standing place does not.
      expect((await activations("inspect")).configurations.map((c) => c.id)).toEqual(["witness"]);
      // Cancelling again, as a retried turn would after its first attempt removed it, commits;
      // an operator's configuration is never the actor's to remove.
      expect(await use("intention.cancel", { intentionId: laterId })).toMatchObject({
        status: "succeeded",
        evidence: { result: { intentionId: laterId } },
      });
      expect(await use("subscription.revoke", { subscriptionId: "witness" })).toMatchObject({
        status: "failed",
        code: "activation_not_found",
      });
      expect((await activations("inspect")).configurations.map((c) => c.id)).toEqual(["witness"]);
      expect(
        await owner.sql(
          `SELECT causal_root FROM clockgrove.actor_activations WHERE configuration_id = '${intentionId}'`,
        ),
      ).toBe(`schedule:${intentionId}:${due.evidence.result.dueAt}`);

      // Perception: exactly the member's authorized scene.
      const scene = decodeLivingScene((await post("/v1/runtime/scene", {})).body);
      const listed = await use("perception.list", {});
      expect(listed.status).toBe("succeeded");
      expect(listed.evidence.result.entities).toEqual(
        scene.entities.map((entity) => ({
          objectId: entity.objectId,
          label: entity.presentation.label,
          archetypeId: entity.archetypeId,
        })),
      );
      expect(listed.evidence.result.revision).toBe(scene.revision);
      // Routes: the edges of the fixture's `fixture.paths` graph (resources/spaces/neighborhood.json)
      // in `frame-grove` version 1, the one frame the scene projects.
      expect(scene.frames.map((frame) => `${frame.frameId}@${frame.version}`)).toEqual([
        "frame-grove@1",
      ]);
      expect(listed.evidence.result.routes).toEqual(
        [
          ["den-mouth", "porch-step"],
          ["den-mouth", "tree-base"],
          ["fence-gap", "garden-edge"],
          ["fence-gap", "tree-base"],
          ["garden-edge", "trash-front"],
          ["garden-edge", "tree-base"],
          ["porch-step", "trash-front"],
        ].map(([from, to]) => ({ graphId: "fixture.paths", from, to })),
      );
      expect(listed.evidence.result).toMatchObject({
        entityCount: scene.entities.length,
        routeCount: 7,
      });

      // Self-inspection: its own goals, budgets and run, nothing else.
      const inspected = await use("self.inspect", {});
      expect(inspected.evidence.result).toMatchObject({
        actorId: ACTOR,
        sessionId,
        goals: [{ path: "goals.md", version: 1, sourceHash: sha(GOALS) }],
        budgets: {
          activation: {
            allowModel: true,
            modelBudget: 10,
            modelCallsReserved: 2,
            remaining: 8,
            standingActorActivations: 0,
            standingActorActivationLimit: 4,
          },
        },
        run: { runId: inspected.runId, messageId: `self-${turn}`, phase: "proposal_validating" },
      });

      // Document write: an actor-writable document commits with the turn, with model provenance.
      const written = await use("document.write", { path: "working-context.md", content: NOTE });
      expect(written).toMatchObject({
        status: "succeeded",
        evidence: {
          arguments: { path: "working-context.md", octets: NOTE.length, sha256: sha(NOTE) },
          result: { path: "working-context.md", commitsWithTurn: true },
        },
      });
      const document = (
        await post(
          "/v1/runtime/actor-documents/read",
          { actorId: ACTOR, path: "working-context.md" },
          OPERATOR,
        )
      ).body as DocumentVersionView;
      expect(document).toMatchObject({
        version: 1,
        content: NOTE,
        proposer: "model",
        runId: written.runId,
      });
      const walked = await post("/v1/runtime/runs/inspect", { runId: written.runId }, OPERATOR);
      expect(walked).toMatchObject({ status: 200 });
      const walk = walked.body as RunWalk;
      expect(walk.runs[0]?.steps.map((step) => [step.kind, step.status])).toEqual([
        ["context_retrieval", "succeeded"],
        ["model_attempt", "succeeded"],
        ["world_command_proposal", "succeeded"],
        ["validation", "succeeded"],
        ["commit", "succeeded"],
      ]);
      expect(walk.runs[0]?.steps[2]?.capabilityEvidence?.grant).toEqual({
        capability: "document.write",
        ...COMMAND_GRANT,
      });

      // Refusals are recorded and the world keeps running: a governed document, a revoked
      // capability, a call beyond the member's grants and a spent standing budget.
      expect(await use("document.write", { path: "goals.md", content: "Mine now." })).toMatchObject(
        {
          status: "failed",
          code: "write_class_refused",
          evidence: { result: { refused: "write_class_refused" } },
        },
      );
      await policy(["perception.list"]);
      expect(await use("perception.list", {})).toMatchObject({
        status: "failed",
        code: "revoked",
        evidence: { grant: { capability: "perception.list" }, result: { refused: "revoked" } },
      });
      // A second member talking with the same actor is bound by the same revocation, and cannot
      // change the attention configured under the policy owner's grant; both are recorded refusals.
      const second = {
        credential: OPERATOR,
        sessionId: decodeConversationSession(
          (await post("/v1/runtime/conversations/create", { actorId: ACTOR }, OPERATOR)).body,
        ).sessionId,
      };
      expect(await use("perception.list", {}, second)).toMatchObject({
        status: "failed",
        code: "revoked",
        evidence: { result: { refused: "revoked" } },
      });
      expect(
        await use(
          "subscription.create",
          { eventType: "ClockPolicyChanged", input: "Mine." },
          second,
        ),
      ).toMatchObject({
        status: "failed",
        code: "policy_not_owned",
        evidence: { result: { refused: "policy_not_owned" } },
      });
      expect(await use("intention.cancel", { intentionId: laterId }, second)).toMatchObject({
        status: "failed",
        code: "policy_not_owned",
      });
      expect((await activations("inspect")).configurations.map((c) => c.id)).toEqual(["witness"]);
      await policy([]);
      await owner.sql(`UPDATE clockgrove.world_memberships
        SET grants = array_remove(grants, 'runtime:world-command') WHERE principal_id = 'principal-runtime'`);
      expect(
        await use("subscription.create", { eventType: "ClockPolicyChanged", input: "Again." }),
      ).toMatchObject({ status: "failed", code: "not_granted", evidence: { grant: null } });
      await owner.sql(`UPDATE clockgrove.world_memberships
        SET grants = array_append(grants, 'runtime:world-command') WHERE principal_id = 'principal-runtime'`);
      const held: string[] = [];
      for (const delaySeconds of [3_600, 3_601, 3_602, 3_603]) {
        const scheduled = await use("intention.schedule", { delaySeconds, input: "Hold." });
        expect(scheduled.status).toBe("succeeded");
        held.push(scheduled.evidence.result.intentionId as string);
      }
      expect(
        await use("intention.schedule", { delaySeconds: 3_604, input: "Hold." }),
      ).toMatchObject({
        status: "failed",
        code: "budget_exhausted",
        evidence: { result: { refused: "budget_exhausted", standingLimit: 4 } },
      });
      // The operator disables one of them; it stays the actor's own.
      const disabled = await activations("configure", {
        configuration: {
          id: held[0],
          sessionId,
          kind: "scheduled_intention",
          nextWakeAt: null,
          intervalMs: null,
          input: "Hold.",
          priority: 1,
          enabled: false,
          compiledRoutine: "escalate",
        },
        policy: { allowModel: true, modelBudget: 10 },
      });
      expect(disabled.configurations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: held[0], origin: "actor", enabled: false }),
        ]),
      );
      await clock("still-running", "PauseWorld");
      expect(document.content).toBe(NOTE);

      // Evidence is bounded on the jsonb text the column's CHECK measures, not on compact JSON:
      // 15,000 compact bytes whose stored form passes 16 KiB keep only the grant.
      const grant = { capability: "perception.list", callsPerTurn: 1, requiredRuntimeGrant: "x" };
      const routes = Array.from({ length: 780 }, () => ({ a: 1, b: 2, c: 3 }));
      const wide = { grant, arguments: {}, result: { routes } };
      expect(JSON.stringify(wide).length).toBeLessThan(16_000);
      expect(
        Number(await owner.sql(`SELECT octet_length('${JSON.stringify(wide)}'::jsonb::text)`)),
      ).toBeGreaterThan(16_384);
      expect(JSON.parse(boundedEvidence(wide))).toEqual({
        grant,
        arguments: { truncated: true },
        result: { truncated: true },
      });
      const narrow = { grant, arguments: {}, result: { routes: routes.slice(0, 500) } };
      expect(boundedEvidence(narrow)).toBe(JSON.stringify(narrow));
      expect(
        Number(await owner.sql(`SELECT octet_length('${JSON.stringify(narrow)}'::jsonb::text)`)),
      ).toBeLessThanOrEqual(16_384);

      // The production responder proposes a document write from the same catalog.
      const scripted = new ScriptedModelProvider({
        "scripted/actor": [
          {
            kind: "reply",
            chunks: [
              JSON.stringify({
                reply: "I noted it.",
                command: {
                  capability: "document.write",
                  input: { path: "working-context.md", content: NOTE },
                },
              }),
            ],
            inputTokens: 10,
            outputTokens: 10,
          },
        ],
      });
      const member = {
        tenantId: owner.scope.tenantId,
        principalId: "principal-runtime",
        privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
      } as unknown as RuntimeAuthorizationContext;
      const respond = actorResponder({
        gateway: createModelGateway({
          aliases: [
            {
              alias: "actor.pilot",
              policyVersion: "actor.pilot@test",
              routes: [
                {
                  id: "scripted/actor",
                  provider: "scripted",
                  model: "scripted-v1",
                  credential: null,
                  priceUsdPerMTok: { input: 0, output: 0 },
                },
              ],
              maxInputTokens: 100_000,
              maxOutputTokens: 1_000,
              timeouts: { firstByteMs: 5_000, idleMs: 5_000, totalMs: 10_000 },
            },
          ],
          adapters: { scripted },
          budget: new InMemoryModelBudget(() => 1_000_000),
          accounting: { record: () => undefined },
        }),
        grants: () =>
          CAPABILITY_REGISTRY.grantsFor(["runtime:world-observe", "runtime:world-command"]),
        perceive: async () => undefined,
        // The actor's standing configurations, read from its policy as the member (issue 354).
        standing: async () =>
          standingOf(
            await owner.withSqlClient((client) =>
              new PostgreSqlActivations(client).configurations({
                scope: owner.scope,
                actorId: ACTOR,
                participant: { ...member, personaId: "persona-runtime" },
              } as unknown as ActivationAddress),
            ),
          ),
        // The canonical read the runtime composes: this session's recorded results, as the member.
        selfResults: () =>
          owner.withSqlClient((client) =>
            sessionSelfResults(client, member, sessionId, [...SELF_CAPABILITIES]),
          ),
      });
      const session = {
        sessionId,
        actorId: ACTOR,
        scope: owner.scope,
        participants: [{ principalId: "principal-runtime", personaId: "persona-runtime" }],
      } as unknown as ConversationSession;
      expect(await respond(session, 1, "Note the rain.", "")).toMatchObject({
        command: {
          capability: "document.write",
          input: { path: "working-context.md", content: NOTE },
        },
      });
      const prompt = String(scripted.calls[0]?.messages.at(-1)?.text ?? "");
      expect(prompt).toContain('"capability":"document.write"');
      // The actor's next prompt carries its newest recorded self results, newest first: here the
      // spent budget's refusal and the intention IDs it would need to cancel one.
      const section = prompt
        .split("UNTRUSTED SELF CAPABILITY RESULTS (")[1]
        ?.split("\nEND UNTRUSTED SELF CAPABILITY RESULTS")[0];
      expect(JSON.parse(section?.slice(section.indexOf("\n") + 1) ?? "null")).toEqual([
        {
          capability: "intention.schedule",
          status: "failed",
          code: "budget_exhausted",
          result: { refused: "budget_exhausted", standingLimit: 4 },
        },
        ...held
          .slice(1)
          .reverse()
          .map((id) => ({
            capability: "intention.schedule",
            status: "succeeded",
            code: null,
            result: { intentionId: id, dueAt: expect.any(Number) },
          })),
      ]);
      // Its standing configurations show every intention it holds, the oldest too, with its id.
      const standing = prompt
        .split("UNTRUSTED STANDING CONFIGURATIONS (")[1]
        ?.split("\nEND UNTRUSTED STANDING CONFIGURATIONS")[0];
      expect(JSON.parse(standing?.slice(standing.indexOf("\n") + 1) ?? "null")).toEqual(
        [...held].sort().map((id) => ({
          kind: "intention",
          id,
          dueAt: id === held[0] ? null : expect.any(Number),
          input: "Hold.",
          enabled: id !== held[0],
        })),
      );
    });
  },
  300_000,
);
