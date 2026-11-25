import {
  MODERATION_CATEGORY_CODES,
  MODERATION_LABELLED_CASES,
  type moderationShadowReport,
} from "@clockgrove/application";
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
const codes = (all: readonly string[], yes: readonly string[]) =>
  Object.fromEntries(
    all.map((code) => [
      code,
      { type: "boolean", label: yes.includes(code) ? "true" : "false", confidence: 0.9 },
    ]),
  );
const answer = (
  label: string,
  confidence = 0.9,
  costUsd: number | undefined = 0.0001,
  yes: readonly string[] = [],
) => ({
  kind: "answer",
  answer: { type: "choice", label, confidence },
  answers: codes(MODERATION_CATEGORY_CODES, yes),
  ...(costUsd === undefined ? {} : { costUsd }),
});
const REPLY_CODES = ["sexual_minors", "self_harm_encouragement", "harmful_instructions"];
const replyScript = {
  "moderation-0": {
    kind: "answer",
    answer: { type: "choice", label: "severe", confidence: 0.8 },
    answers: codes(REPLY_CODES, ["self_harm_encouragement"]),
    costUsd: 0.0002,
  },
  "moderation-2": { kind: "http", status: 503 },
  "moderation-3": {
    kind: "answer",
    answer: { type: "choice", label: "clean", confidence: 0.9 },
    answers: codes(REPLY_CODES, []),
  },
};
const script = [
  answer("block_clean", 0.9, 0.0001, ["harm_to_others"]),
  answer("block_clean", 0.9, 0.0001, ["harm_to_others"]),
  { ...answer("allow_injection"), costUsd: undefined },
  answer("flag_clean", 0.4),
  answer("flag_clean"),
  answer("allow_clean"),
  answer("cant_tell"),
  { kind: "http", status: 503 },
  answer("allow_clean"),
  answer("allow_clean"),
  answer("flag_clean"),
  answer("block_clean"),
  answer("flag_injection"),
  answer("block_injection"),
];

type Report = ReturnType<typeof moderationShadowReport>;
it("records private reversible shadow judgements and reports independent accuracy, model agreement and recurring misses through native turns", async () => {
  if (!isNativeWorldOwnerChild()) {
    const savedKey = process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.MODERATION_SHADOW_CONFIG = JSON.stringify(policy);
    process.env.NATIVE_MODERATION_SHADOW_SCRIPT = JSON.stringify(script);
    process.env.ACTOR_REPLY_SHADOW_CONFIG = JSON.stringify({
      modelAlias: "actor-reply.test",
      model: "scripted-reply",
    });
    process.env.NATIVE_ACTOR_REPLY_SHADOW_SCRIPT = JSON.stringify(replyScript);
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
      delete process.env.ACTOR_REPLY_SHADOW_CONFIG;
      delete process.env.NATIVE_ACTOR_REPLY_SHADOW_SCRIPT;
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
      ).body as {
        state: string;
        instructions: string;
        options: Record<string, string>;
        questions: Record<string, string>;
      }[];
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
      const receipt = await talk(
        sessionId,
        index === 1 ? "activation:human" : `moderation-${index}`,
        texts[index]!,
      );
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
      categories: {
        sexual_minors: false,
        harm_to_others: true,
        self_harm_intent: false,
        self_harm_encouragement: false,
        stated_minor: false,
      },
    });
    expect(receipts[7]!.message.moderationShadow?.categories).toBeNull();
    expect((await requests()).map((request) => JSON.parse(request.state))).toEqual(
      texts.map((message) => ({ message })),
    );
    // One decide call carries the five route-changing codes and the widened block wording.
    const [first] = await requests();
    expect(Object.keys(first!.questions)).toEqual([...MODERATION_CATEGORY_CODES]);
    expect(first!.options.block_clean).toContain(
      "hate against people for who they are, encouragement of self-harm or suicide",
    );
    expect(first!.instructions).toContain("a request for help causing serious real-world harm");
    // Every committed reply is judged beside its turn, as contentless telemetry.
    const replyRecords = async () =>
      (
        (
          await owner.request("/actor-agent", {
            op: "actor-reply-records",
            scope: owner.scope,
            actorId: actor.objectId,
          })
        ).body as string[]
      ).map((line) => JSON.parse(line) as Record<string, unknown>);
    await expect.poll(async () => (await replyRecords()).length).toBe(texts.length);
    const judged: Record<string, Record<string, unknown>> = Object.fromEntries(
      (await replyRecords()).map((record) => [String(record.messageId), record]),
    );
    expect(judged["moderation-0"]).toEqual({
      schemaVersion: 1,
      pointId: "actor-reply-shadow",
      mode: "shadow",
      tenantId: owner.scope.tenantId,
      worldId: owner.scope.worldId,
      actorId: actor.objectId,
      sessionId,
      messageId: "moderation-0",
      policyVersion: "actor-reply-shadow@1",
      modelAlias: "actor-reply.test",
      model: "scripted-reply",
      status: "judged",
      severe: true,
      categories: {
        sexual_minors: false,
        self_harm_encouragement: true,
        harmful_instructions: false,
      },
      confidenceBp: 8000,
      latencyMs: judged["moderation-0"]!.latencyMs,
      costMicrousd: 200,
      detail: null,
    });
    expect(judged["moderation-2"]).toMatchObject({
      status: "failed",
      detail: "unavailable",
      categories: null,
    });
    expect(judged["moderation-3"]).toMatchObject({ status: "judged", costMicrousd: null });
    expect(
      Object.values(judged).filter((record) => record.status === "judged" && !record.severe),
    ).toHaveLength(6);
    const telemetry = JSON.stringify(await replyRecords());
    expect(telemetry).not.toContain("Scripted fixture reply");
    expect(telemetry).not.toContain("private message known");
    delete process.env.ACTOR_REPLY_SHADOW_CONFIG;
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
    // Each finished record is one model-call usage event with no run; replaying added none.
    const usage = JSON.parse(
      await owner.sql(
        `SELECT jsonb_build_object(
          'keyed', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM clockgrove.moderation_shadow r WHERE u.event_id = 'moderation_shadow:' || encode(sha256(convert_to(jsonb_build_array(r.session_id, r.message_id)::text, 'UTF8')), 'hex'))),
          'shared', jsonb_agg(DISTINCT jsonb_build_array(source, category, resource, principal_id,
            persona_id, actor_id, run_id, root_run_id, outcome_code, world_time)),
          'calls', jsonb_agg(jsonb_build_array(status, quantities) ORDER BY status, quantities::text))::text
        FROM clockgrove.usage_events u WHERE source = 'moderation_shadow'`,
      ),
    );
    // Each call was sent to the provider, which reported no tokens.
    const sent = {
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      calls: 1,
    };
    expect(usage.shared).toEqual([
      [
        "moderation_shadow",
        "model_call",
        "scripted-moderation-a",
        "principal-runtime",
        "persona-runtime",
        "lamp.keeper-one",
        null,
        null,
        null,
        0,
      ],
    ]);
    expect(usage.keyed).toBe(usage.calls.length);
    expect(usage.calls).toEqual([
      ["cant_tell", sent],
      ["failed", sent],
      ["low_confidence", sent],
      ...Array.from({ length: 5 }, () => ["picked", sent]),
    ]);
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
      "activation:human-disabled",
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
      labelledAccuracy: { messages: 14, answered: 12, correct: 6, accuracy: 6 / 12 },
      labelCoverage: { total: 6, observed: 6, skipped: [] },
      unlabelled: 1,
    });
    expect(result.cohorts).toMatchObject({
      benign: { messages: 6, answered: 5, correct: 2, accuracy: 2 / 5 },
      borderline: { messages: 2, answered: 2, correct: 2, accuracy: 1 },
      abusive: { messages: 2, answered: 2, correct: 1, accuracy: 0.5 },
      injection: { messages: 4, answered: 3, correct: 1, accuracy: 1 / 3 },
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
      ["false-positive", texts[6]],
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
    const beforeActivation = await requests();
    const autonomousSession = await create();
    const activationPost = (op: string, fields: object) =>
      owner.request(
        `/v1/runtime/activations/${op}`,
        { version: 1, scope: owner.scope, actorId: actor.objectId, ...fields },
        MEMBER,
      );
    expect(
      (
        await activationPost("configure", {
          actorId: actor.objectId,
          configuration: {
            id: "moderation-autonomous",
            sessionId: autonomousSession,
            kind: "heartbeat",
            nextWakeAt: null,
            intervalMs: null,
            input: "Consider this wake",
            priority: 1,
            enabled: true,
            compiledRoutine: "escalate",
          },
          policy: { allowModel: true, modelBudget: 1 },
        })
      ).status,
    ).toBe(200);
    const activation = await activationPost("wake", {
      actorId: actor.objectId,
      wake: {
        configurationId: "moderation-autonomous",
        causalRoot: "moderation-autonomous-root",
        reason: { kind: "heartbeat", heartbeatId: "moderation-autonomous" },
        evidence: "wake evidence",
      },
    });
    expect(activation.status, JSON.stringify(activation.body)).toBe(200);
    expect(activation.body).toMatchObject({ status: "completed" });
    expect(await requests()).toEqual(beforeActivation);
    expect(await report()).toMatchObject({ messages: 17, skipped: 3 });
    await owner.withSqlClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE clockgrove_runtime");
        await client.query(
          "SELECT set_config('app.tenant_id',$1,true),set_config('app.principal_id','principal-runtime',true),set_config('app.privacy_ceiling','{\"version\":1,\"allowedCategories\":[\"conversation\"]}',true)",
          [owner.scope.tenantId],
        );
        await client.query(
          "SELECT set_config('test.session_id',$1,true),set_config('test.message_id',$2,true)",
          [autonomousSession, (activation.body as { messageId: string }).messageId],
        );
        await client.query(`DO $test$ BEGIN
          BEGIN
            PERFORM clockgrove.reserve_moderation_shadow(current_setting('app.tenant_id'),current_setting('test.session_id'),current_setting('test.message_id'));
          EXCEPTION WHEN raise_exception THEN
            IF SQLERRM <> 'moderation shadow refused' THEN RAISE; END IF;
            RETURN;
          END;
          RAISE EXCEPTION 'autonomous moderation reservation was accepted';
        END $test$`);
      } finally {
        await client.query("ROLLBACK");
      }
    });
    expect((await requests()).at(-1)?.state).toBe(
      JSON.stringify({ message: "Another participant private secret." }),
    );
    expect(JSON.stringify((await requests()).at(-1))).not.toContain(texts[7]);
    expect(
      await owner.sql("SELECT state_hash FROM clockgrove.partition_states ORDER BY partition_id"),
    ).toBe(physical);
  });
}, 300_000);
