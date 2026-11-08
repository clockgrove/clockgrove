import {
  decisionShadowDeclarations,
  decisionShadowReport,
  JOURNAL_EVENT_REGISTRY,
  journalDecisionShadow,
  runDecisionShadow,
  VerifiedJournal,
} from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import { validateUtilityPolicy } from "@clockgrove/domain";
import { planningRequestFor } from "@clockgrove/kernel";
import {
  createModelGateway,
  decisionAlias,
  InMemoryModelBudget,
  ScriptedDecider,
} from "@clockgrove/model-gateway";
import { PostgreSqlJournal } from "@clockgrove/persistence";
import { describe, expect, it } from "vitest";
import { gatewayShadowDecider } from "../../src/decision-shadow.js";
import { advanceCommand, kernelModel, pureStep } from "../world-fixture.js";
import {
  inspectNativeWorldOwner,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../world-owner/native-harness.js";

const FILE = "apps/runtime/test/decision-evidence/shadow.postgres.test.ts";

const ambiguity = {
  schemaVersion: 1,
  conditions: [{ kind: "score-margin", maxMargin: 1_000_000_000_000n }],
} as const;
const decisionPoints = {
  schemaVersion: 1,
  points: [
    {
      id: "routine.close-call",
      trigger: { kind: "declared-ambiguity" },
      candidates: "kernel-valid",
      features: ["hunger", "thirst"],
      modelAlias: "shadow.default",
      confidenceThreshold: 6500,
      budget: { maxCalls: 10, maxMicrousd: 1000 },
      fallback: "utility-top-pick",
    },
  ],
} as const;

/** The pack's own utility policy extended with the declarations, run through the pack validator. */
function declaredFromPack(packPolicy: {
  readonly utility?: unknown;
  readonly wellbeing?: unknown;
}) {
  const utility = { ...(packPolicy.utility as object), ambiguity, decisionPoints };
  validateUtilityPolicy(utility, packPolicy.wellbeing as never);
  const declared = decisionShadowDeclarations(utility);
  if (declared === undefined) throw new Error("expected declarations");
  return declared;
}

describe("decision-model shadow tier over PostgreSQL and the native owner", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns the native runtime and PostgreSQL",
    async () => {
      await runNativeWorldOwnerProcess(FILE);
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "journals shadow picks without changing the world, replays them identically and runs unchanged with models off",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { world, scope, sql } = owner;
        const model = kernelModel(world);
        const command = advanceCommand(world, "shadow-decisions", 160_000n, null);
        const step = pureStep(world, model, command);
        const subjects = step.decisionDrafts
          .filter((draft) => draft.kind === "routine")
          .map((draft) => ({
            commandId: command.commandId,
            trace: draft.decision as never,
          }));
        expect((await owner.submit(command)).status).toBe(200);
        const policy = declaredFromPack(world.behavior.policy);

        // Script: the first decision agrees with utility confidently, the second disagrees and is low confidence.
        const requests = subjects.map((subject) =>
          planningRequestFor(subject.trace, policy.ambiguity, command.commandId),
        );
        const keys = requests.map((request) =>
          (request?.candidates ?? []).map(
            (candidate) => `${candidate.action.kind}:${candidate.action.targetObjectId ?? ""}`,
          ),
        );
        const utility = requests.map(
          (request) =>
            `${request?.fallbackAction.kind}:${request?.fallbackAction.targetObjectId ?? ""}`,
        );
        const other = keys.map((list, index) => list.find((key) => key !== utility[index]) ?? "");
        const alias = decisionAlias({
          alias: "shadow.default",
          model: "perplexity/pplx-decider-v1.2",
        });
        const decider = new ScriptedDecider({
          [alias.route.id]: [
            {
              kind: "answer",
              answer: { type: "choice", label: utility[0] ?? "", confidence: 0.8 },
              costUsd: 0.000028,
            },
            {
              kind: "answer",
              answer: { type: "choice", label: other[1] ?? "", confidence: 0.55 },
              costUsd: 0.000028,
            },
            {
              kind: "answer",
              answer: { type: "choice", label: "cant_tell", confidence: 0.9 },
              costUsd: 0.000028,
            },
            {
              kind: "answer",
              answer: { type: "choice", label: other[1] ?? "", confidence: 0.55 },
              costUsd: 0.000028,
            },
          ],
        });
        let calls = 0;
        const gateway = createModelGateway({
          aliases: [],
          adapters: {},
          decisionAliases: [alias],
          decisionAdapters: {
            "vercel-ai-gateway": {
              decide: (call) => {
                calls += 1;
                return decider.decide(call);
              },
            },
          },
          budget: new InMemoryModelBudget(() => 2000),
          accounting: { record: () => undefined },
        });
        const shadow = gatewayShadowDecider(gateway, {
          tenantId: scope.tenantId,
          worldId: scope.worldId,
          actorId: "decision-shadow",
        });

        const state = (await inspectNativeWorldOwner(owner)).partition.document;

        // Models off: nothing is called and nothing is journaled.
        expect(
          await runDecisionShadow({ subjects, declarations: policy, decider: undefined }),
        ).toEqual([]);

        const records = await runDecisionShadow({
          subjects,
          declarations: policy,
          decider: shadow,
        });
        expect(records.map((record) => record.shadow.status)).toEqual(["picked", "low-confidence"]);
        expect(records.map((record) => record.utilityChoice)).toEqual(utility);
        expect(records[1]?.shadow.choice).toBe(other[1]);
        expect(records[0]).toMatchObject({
          model: "perplexity/pplx-decider-v1.2",
          costMicrousd: 28,
          llm: { status: "not-run" },
        });

        const route = (
          await sql(
            "SELECT partition_id || '|' || space_id || '|' || stream_id FROM clockgrove.streams LIMIT 1",
          )
        ).split("|");
        const [partitionId = "", spaceId = "", streamId = ""] = route;
        await owner.withSqlClient(async (client) => {
          const raw = new PostgreSqlJournal(client);
          const journal = new VerifiedJournal(raw, JOURNAL_EVENT_REGISTRY);
          const shadowScope = {
            authorization: {
              tenantId: decodeOpaqueId(scope.tenantId, "TenantId"),
              principalId: decodeOpaqueId("principal-runtime", "PrincipalId"),
              privacyCeiling: decodePrivacyCeiling({
                version: 1,
                allowedCategories: ["operator_evidence"],
              }),
            },
            ...scope,
            partitionId,
            spaceId,
            streamId,
          };
          for (const record of records)
            await journalDecisionShadow(journal, shadowScope, record, raw);
          // An exact retry is idempotent.
          for (const record of records)
            await journalDecisionShadow(journal, shadowScope, record, raw);
        });
        expect(
          await sql(
            "SELECT count(*) FROM clockgrove.events WHERE event_type='DecisionShadowRecorded'",
          ),
        ).toBe("2");

        // Replay reads the journal and never calls the model; the world is unchanged.
        const callsBefore = calls;
        await owner.replace(true);
        expect(calls).toBe(callsBefore);
        expect((await inspectNativeWorldOwner(owner)).partition.document).toEqual(state);

        // A second real run over the same committed decisions repeats each real signature; the
        // model abstains with the reserved option on the first and stays low-confidence on the second.
        const again = await runDecisionShadow({ subjects, declarations: policy, decider: shadow });
        expect(again.map((record) => record.shadow.status)).toEqual([
          "cant-tell",
          "low-confidence",
        ]);
        expect(again.map((record) => record.signature)).toEqual(
          records.map((record) => record.signature),
        );
        const report = decisionShadowReport([...records, ...again]);
        expect(report.points[0]).toMatchObject({
          decisions: 4,
          answered: 3,
          agreed: 1,
          lowConfidence: 2,
          cantTell: 1,
        });
        expect(report.review).toHaveLength(2);
        expect(report.review.find((row) => row.signature === records[0]?.signature)).toEqual({
          signature: records[0]?.signature,
          pointId: "routine.close-call",
          repeats: 2,
          lowConfidence: 0,
          cantTell: 1,
          disagreements: 0,
        });
        expect(report.review.find((row) => row.signature === records[1]?.signature)).toEqual({
          signature: records[1]?.signature,
          pointId: "routine.close-call",
          repeats: 2,
          lowConfidence: 2,
          cantTell: 0,
          disagreements: 2,
        });
      });
    },
    210_000,
  );
});
