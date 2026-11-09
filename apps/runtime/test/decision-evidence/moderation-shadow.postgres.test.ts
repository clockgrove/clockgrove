import { MODERATION_LABELLED_CASES, type moderationShadowReport } from "@clockgrove/application";
import { decodeConversationSession, decodeTalkReceipt } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { withModerationFixture } from "../../../../scripts/moderation-shadow-fixture.js";
import { truthOf } from "../world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../world-owner/native-harness.js";

const FILE = "apps/runtime/test/decision-evidence/moderation-shadow.postgres.test.ts";
const MEMBER = "local-reader-session";
const OUTSIDER = "outsider-session-token";
const policy = { modelAlias: "moderation.test-a", model: "scripted-moderation-a" };
const answer = (label: string, confidence = 0.9, costUsd: number | undefined = 0.0001) => ({
  kind: "answer",
  answer: { type: "choice", label, confidence },
  ...(costUsd === undefined ? {} : { costUsd }),
});
const script = [
  answer("block_clean"),
  answer("block_clean"),
  { kind: "answer", answer: { type: "choice", label: "allow_injection", confidence: 0.9 } },
  answer("flag_clean", 0.4),
  answer("allow_clean"),
  answer("allow_clean"),
  answer("cant_tell"),
  { kind: "http", status: 503 },
  answer("allow_clean"),
  answer("allow_clean"),
  answer("flag_clean"),
  answer("block_clean"),
  answer("block_injection"),
  answer("block_injection"),
];

type Report = ReturnType<typeof moderationShadowReport>;
it("records private reversible shadow judgements and reports independent accuracy, model agreement and recurring misses through native turns", async () => {
  if (!isNativeWorldOwnerChild()) {
    const savedKey = process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.MODERATION_SHADOW_CONFIG = JSON.stringify(policy);
    process.env.NATIVE_MODERATION_SHADOW_SCRIPT = JSON.stringify(script);
    try {
      await withModerationFixture((pack) =>
        runNativeWorldOwnerProcess(FILE, pack, {
          timeoutMs: 240_000,
          prepare: async (fixture) => {
            await truthOf(
              fixture,
            )(`UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe'), privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}';
          INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) SELECT DISTINCT tenant_id, 'principal-outsider' FROM clockgrove.world_memberships;
          INSERT INTO clockgrove.world_memberships (tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
          SELECT tenant_id,world_id,timeline_id,space_id,'principal-outsider','membership-outsider','persona-outsider',roles,grants,privacy_ceiling,now() FROM clockgrove.world_memberships WHERE principal_id='principal-runtime'`);
          },
        }),
      );
    } finally {
      delete process.env.MODERATION_SHADOW_CONFIG;
      delete process.env.NATIVE_MODERATION_SHADOW_SCRIPT;
      if (savedKey !== undefined) process.env.AI_GATEWAY_API_KEY = savedKey;
    }
    return;
  }
  await withNativeWorldOwner(async (owner) => {
    const actor = owner.world.birth.state.entities.find(
      (entity) => entity.spaceId === owner.scope.spaceId && entity.needs !== undefined,
    );
    if (!actor) throw new Error("Generated fixture actor missing");
    const post = (route: string, fields: object, credential = MEMBER) =>
      owner.request(route, { version: 1, ...owner.scope, ...fields }, credential);
    const create = async (credential = MEMBER) => {
      const result = await post(
        "/v1/runtime/conversations/create",
        { actorId: actor.objectId },
        credential,
      );
      expect(result.status).toBe(200);
      return decodeConversationSession(result.body).sessionId;
    };
    const talk = async (
      sessionId: string,
      messageId: string,
      text: string,
      credential = MEMBER,
    ) => {
      const response = await post("/v1/runtime/talk", { sessionId, messageId, text }, credential);
      expect(response.status).toBe(200);
      return decodeTalkReceipt(response.body);
    };
    const report = async (credential = MEMBER) => {
      const result = await owner.request(
        "/v1/runtime/activations/moderation-report",
        { version: 1, scope: owner.scope, actorId: actor.objectId },
        credential,
      );
      expect(result.status).toBe(200);
      return result.body as Report;
    };
    const requests = async () =>
      (
        await owner.request("/actor-agent", {
          op: "moderation-requests",
          scope: owner.scope,
          actorId: actor.objectId,
        })
      ).body as { state: string; instructions: string }[];
    const physical = await owner.sql(
      "SELECT state_hash FROM clockgrove.partition_states ORDER BY partition_id",
    );
    const sessionId = await create();
    const texts = [
      MODERATION_LABELLED_CASES[0]!.text,
      MODERATION_LABELLED_CASES[0]!.text,
      MODERATION_LABELLED_CASES[1]!.text,
      MODERATION_LABELLED_CASES[2]!.text,
      MODERATION_LABELLED_CASES[3]!.text,
      MODERATION_LABELLED_CASES[4]!.text,
      MODERATION_LABELLED_CASES[5]!.text,
      "A private message known only in this session.",
    ];
    const receipts = [];
    for (let index = 0; index < texts.length; index++) {
      const receipt = await talk(sessionId, `moderation-${index}`, texts[index]!);
      expect(receipt.reply.text).toBe(
        `Scripted fixture reply: you have said ${index + 1} ${index === 0 ? "thing" : "things"} to me in this conversation.`,
      );
      receipts.push(receipt);
    }
    expect(receipts[0]!.message.moderationShadow).toMatchObject({
      mode: "shadow",
      disposition: "block",
      injection: false,
      status: "picked",
      confidenceBp: 9000,
      costMicrousd: 100,
    });
    expect((await requests()).map((request) => JSON.parse(request.state))).toEqual(
      texts.map((message) => ({ message })),
    );
    expect(
      await owner.sql("SELECT state_hash FROM clockgrove.partition_states ORDER BY partition_id"),
    ).toBe(physical);
    await owner.withSqlClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE clockgrove_runtime");
        await client.query(
          "SELECT set_config('app.tenant_id',$1,true),set_config('app.principal_id','principal-runtime',true),set_config('app.privacy_ceiling','{\"version\":1,\"allowedCategories\":[\"conversation\"]}',true)",
          [owner.scope.tenantId],
        );
        await client.query("SELECT clockgrove.reserve_moderation_shadow($1,$2,$3)", [
          owner.scope.tenantId,
          sessionId,
          "moderation-0",
        ]);
        await client.query("SELECT set_config('test.session_id',$1,true)", [sessionId]);
        await client.query(`DO $test$ BEGIN
          BEGIN
            PERFORM clockgrove.finish_moderation_shadow(current_setting('app.tenant_id'),current_setting('test.session_id'),'moderation-0','{}'::jsonb);
          EXCEPTION WHEN raise_exception THEN
            IF SQLERRM <> 'moderation shadow refused' THEN RAISE; END IF;
            RETURN;
          END;
          RAISE EXCEPTION 'malformed shadow evidence was accepted';
        END $test$`);
      } finally {
        await client.query("ROLLBACK");
      }
    });
    const beforeReplay = await requests();
    await owner.replace(false);
    const retry = await talk(sessionId, "moderation-0", texts[0]!);
    expect([retry.message, retry.reply, retry.turn]).toEqual([
      receipts[0]!.message,
      receipts[0]!.reply,
      receipts[0]!.turn,
    ]);
    expect(await requests()).toEqual(beforeReplay);
    delete process.env.NATIVE_MODERATION_SHADOW_SCRIPT;
    await owner.replace(false);
    const missing = await talk(
      sessionId,
      "moderation-missing-key",
      MODERATION_LABELLED_CASES[1]!.text,
    );
    expect(missing.message.moderationShadow).toMatchObject({
      mode: "shadow",
      status: "skipped",
      disposition: null,
      injection: null,
    });
    delete process.env.MODERATION_SHADOW_CONFIG;
    await owner.replace(false);
    const disabled = await talk(
      sessionId,
      "moderation-disabled",
      MODERATION_LABELLED_CASES[2]!.text,
    );
    expect(disabled.message.moderationShadow).toBeUndefined();
    expect(disabled.reply.text).toBe(
      "Scripted fixture reply: you have said 10 things to me in this conversation.",
    );
    process.env.MODERATION_SHADOW_CONFIG = JSON.stringify({
      ...policy,
      modelAlias: "moderation.test-b",
      model: "scripted-moderation-b",
    });
    process.env.NATIVE_MODERATION_SHADOW_SCRIPT = JSON.stringify(script);
    await owner.replace(false);
    const second = await create();
    for (const label of MODERATION_LABELLED_CASES)
      await talk(second, `second-${label.id}`, label.text);
    const result = await report();
    expect(result).toMatchObject({
      mode: "shadow",
      messages: 16,
      judged: 15,
      skipped: 2,
      totals: {
        messages: 15,
        answered: 12,
        abstentions: 1,
        lowConfidence: 1,
        failed: 1,
        skipped: 1,
        knownCostMicrousd: 1200,
        unknownCostCalls: 2,
      },
      labelledAccuracy: { messages: 14, answered: 12, correct: 7, accuracy: 7 / 12 },
      labelCoverage: { total: 6, observed: 6, skipped: [] },
      unlabelled: 1,
    });
    expect(result.cohorts).toMatchObject({
      benign: { messages: 6, answered: 5, correct: 2, accuracy: 2 / 5 },
      borderline: { messages: 2, answered: 2, correct: 2, accuracy: 1 },
      abusive: { messages: 2, answered: 2, correct: 1, accuracy: 0.5 },
      injection: { messages: 4, answered: 3, correct: 2, accuracy: 2 / 3 },
    });
    expect(
      result.modelAgreement
        .filter((pair) => pair.compared > 0)
        .map(({ compared, agreed, agreement }) => ({ compared, agreed, agreement })),
    ).toEqual([{ compared: 5, agreed: 1, agreement: 0.2 }]);
    expect(result.misses.map((miss) => [miss.kind, miss.example])).toEqual([
      ["false-positive", texts[0]],
      ["false-positive", texts[0]],
      ["false-positive", texts[2]],
      ["false-negative", texts[4]],
      ["false-negative", texts[5]],
    ]);
    expect(result.review).toEqual([
      { signature: result.misses[0]!.signature, occurrences: 2, humanReview: true },
    ]);
    expect(result.rows.flatMap((row) => (row.record === null ? [] : [row.record.status]))).toEqual([
      "picked",
      "picked",
      "picked",
      "low-confidence",
      "picked",
      "picked",
      "cant-tell",
      "failed",
      "skipped",
      "picked",
      "picked",
      "picked",
      "picked",
      "picked",
      "picked",
    ]);
    const privateRows = await owner.sql(
      "SELECT count(*) FROM clockgrove.events WHERE event_type='ModerationShadowRecorded' AND privacy_class='conversation'",
    );
    expect(privateRows).toBe("15");
    expect(
      await owner.sql(
        "SELECT count(*) FROM clockgrove.events WHERE payload::text LIKE '%private message known%' OR payload::text LIKE '%hunt you down%' OR payload::text LIKE '%private conversations%'",
      ),
    ).toBe("0");
    expect((await report(OUTSIDER)).messages).toBe(0);
    expect((await post("/v1/runtime/conversations/read", { sessionId }, OUTSIDER)).status).toBe(
      404,
    );
    const other = await create(OUTSIDER);
    await talk(other, "other-private-message", "Another participant private secret.", OUTSIDER);
    expect((await report()).messages).toBe(16);
    await owner.withSqlClient(async (client) => {
      await client.query(
        `INSERT INTO clockgrove.conversation_messages
        (tenant_id,session_id,sequence,message_id,role,author_id,voice_mode,content_artifact_id,privacy_class,principal_id)
        SELECT tenant_id,session_id,(SELECT max(sequence)+1 FROM clockgrove.conversation_messages WHERE session_id=$1),
          'historical-before-fibers',role,author_id,voice_mode,content_artifact_id,privacy_class,principal_id
        FROM clockgrove.conversation_messages WHERE session_id=$1 AND message_id='moderation-0'`,
        [sessionId],
      );
    });
    expect(await report()).toMatchObject({ messages: 17, skipped: 3 });
    expect((await requests()).at(-1)?.state).toBe(
      JSON.stringify({ message: "Another participant private secret." }),
    );
    expect(JSON.stringify((await requests()).at(-1))).not.toContain(texts[7]);
    expect(
      await owner.sql("SELECT state_hash FROM clockgrove.partition_states ORDER BY partition_id"),
    ).toBe(physical);
  });
}, 300_000);
