import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { truthOf } from "../apps/runtime/test/world-fixture.ts";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../apps/runtime/test/world-owner/native-harness.ts";
import { MODERATION_LABELLED_CASES } from "../packages/application/src/index.ts";
import { decodeConversationSession } from "../packages/contracts/src/index.ts";
import { withModerationFixture } from "./moderation-shadow-fixture.ts";

const FILE = "scripts/moderation-shadow-report.session.mjs";
const CONFIG = "scripts/moderation-shadow-report.vitest.config.ts";
const MEMBER = "local-reader-session";
it("measures labelled messages through the native actor runtime", async () => {
  const policies = JSON.parse(process.env.MODERATION_SHADOW_MODELS);
  if (!isNativeWorldOwnerChild()) {
    if (process.env.CLOCKGROVE_MODERATION_SHADOW_LIVE !== "1")
      process.env.NATIVE_MODERATION_SHADOW_SCRIPT = JSON.stringify(
        policies.flatMap(() =>
          MODERATION_LABELLED_CASES.map((label) => ({
            kind: "answer",
            answer: {
              type: "choice",
              label: `${label.disposition}_${label.injection ? "injection" : "clean"}`,
              confidence: 0.9,
            },
            costUsd: 0.0001,
          })),
        ),
      );
    const run = (pack) =>
      runNativeWorldOwnerProcess(FILE, pack, {
        vitestConfig: CONFIG,
        timeoutMs: 540_000,
        inheritOutput: true,
        prepare: async (fixture) => {
          await truthOf(fixture)(
            `UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe'), privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}' WHERE principal_id='principal-runtime'`,
          );
        },
      });
    if (process.env.CLOCKGROVE_MODERATION_SHADOW_PACK)
      await run(process.env.CLOCKGROVE_MODERATION_SHADOW_PACK);
    else await withModerationFixture(run);
    return;
  }
  await withNativeWorldOwner(async (owner) => {
    const actor = owner.world.birth.state.entities.find(
      (entity) => entity.spaceId === owner.scope.spaceId && entity.needs !== undefined,
    );
    if (!actor) throw new Error("The selected pack needs a needs-bearing actor in its first space");
    for (let model = 0; model < policies.length; model++) {
      process.env.MODERATION_SHADOW_CONFIG = JSON.stringify(policies[model]);
      if (model > 0) await owner.replace(false);
      const created = await owner.request(
        "/v1/runtime/conversations/create",
        { version: 1, ...owner.scope, actorId: actor.objectId },
        MEMBER,
      );
      expect(created.status).toBe(200);
      const sessionId = decodeConversationSession(created.body).sessionId;
      for (const label of MODERATION_LABELLED_CASES) {
        const response = await owner.request(
          "/v1/runtime/talk",
          {
            version: 1,
            ...owner.scope,
            sessionId,
            messageId: `moderation-${model}-${label.id}`,
            text: label.text,
          },
          MEMBER,
        );
        expect(response.status).toBe(200);
      }
    }
    const response = await owner.request(
      "/v1/runtime/activations/moderation-report",
      { version: 1, scope: owner.scope, actorId: actor.objectId },
      MEMBER,
    );
    expect(response.status).toBe(200);
    const measurement =
      process.env.CLOCKGROVE_MODERATION_SHADOW_LIVE === "1"
        ? process.env.AI_GATEWAY_API_KEY
          ? "live"
          : "model-unavailable"
        : "scripted";
    const output = process.env.CLOCKGROVE_MODERATION_SHADOW_OUTPUT;
    if (!output) throw new Error("Report output path missing");
    await writeFile(
      output,
      `${JSON.stringify({ measurement, workload: "labelled inbound messages; scripted full turns", policies, packId: owner.world.artifact.packId, packVersion: owner.world.artifact.version, report: response.body }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(`Moderation shadow ${measurement} report written to ${output}\n`);
  });
});
