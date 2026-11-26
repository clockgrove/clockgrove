import type { ConversationParticipant, TurnFiber } from "@clockgrove/application";
import { decodeBrowserScope, decodeOpaqueId, type UsageBudget } from "@clockgrove/contracts";
import {
  PostgreSqlArtifactStore,
  PostgreSqlConversationStore,
  PostgreSqlRunReader,
  PostgreSqlUsageAdmission,
  WebCryptoKeyring,
} from "@clockgrove/persistence";
import { expect, it } from "vitest";
// biome-ignore format: @ts-expect-error covers only the next line.
// @ts-expect-error -- repository-local JavaScript helpers have no declaration file.
import { applyMigrations, applySqlFile, psqlQuery, withDisposableDatabase } from "../../../scripts/database/lib.mjs";
import { type TurnFiberHost, TurnFibers, type TurnResearchHost } from "../src/actor-agent.js";
import { admitSpend, admittedShadowDecider } from "../src/usage-admission.js";
import { connect, type DatabaseFixture } from "./world-fixture.js";

const scope = decodeBrowserScope({
  tenantId: "tenant-a",
  worldId: "world-a",
  timelineId: "timeline-a",
  spaceId: "space-a",
});
const participant: ConversationParticipant = {
  tenantId: scope.tenantId,
  principalId: decodeOpaqueId("principal-a", "PrincipalId"),
  personaId: decodeOpaqueId("persona-a", "WorldPersonaId"),
  privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
};
const operator = {
  ...participant,
  privacyCeiling: { version: 1 as const, allowedCategories: ["operator_evidence" as const] },
};

/** A seeded space whose member also operates it, with the real store and admission. */
async function withSpace(
  run: (space: {
    sql: (query: string) => Promise<string>;
    store: PostgreSqlConversationStore;
    usage: PostgreSqlUsageAdmission;
    runs: PostgreSqlRunReader;
    budget: (budget: UsageBudget) => Promise<unknown>;
    turn: (sessionId: string, messageId: string, command?: boolean) => Promise<TurnFiber>;
  }) => Promise<void>,
) {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/seed.sql");
    const sql = async (query: string) =>
      (await psqlQuery(fixture.tools, fixture.environment, query)).trim();
    await sql(`UPDATE clockgrove.world_memberships
        SET grants = grants || ARRAY['runtime:world-inspect', 'runtime:world-operate'],
            privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}'
      WHERE principal_id = 'principal-a'`);
    const client = connect(fixture.environment);
    const keyring = await WebCryptoKeyring.fromJson(
      JSON.stringify({
        version: 1,
        current: "fixture",
        keys: { fixture: Buffer.alloc(32, 7).toString("base64url") },
      }),
    );
    const artifacts = new PostgreSqlArtifactStore(client, { keyring });
    let sessions = 0;
    const store = new PostgreSqlConversationStore(client, artifacts, () => `s${++sessions}`);
    const usage = new PostgreSqlUsageAdmission(client);
    const turn = async (sessionId: string, messageId: string, command = false) => {
      const accepted = await store.acceptTurn(participant, {
        scope,
        sessionId,
        messageId,
        text: "Look it up",
      });
      let f = (await store.claimTurn(participant, accepted.fiber!, "prepare", 1))!;
      f = (await store.assembleTurn(participant, f))!;
      f = (await store.advanceTurn(participant, f, "model_running"))!;
      if (!command) return f;
      f = (await store.answerTurn(participant, f, {
        text: "Looking it up",
        command: { capability: "inspect", input: {} },
      }))!;
      return (await store.waitForTool(participant, f, {
        callId: `${messageId}:call`,
        effectId: `${messageId}:effect`,
        capability: "inspect",
      }))!;
    };
    try {
      await run({
        sql,
        store,
        usage,
        runs: new PostgreSqlRunReader(client, artifacts),
        budget: (budget) => usage.setBudget(operator, scope, budget),
        turn,
      });
    } finally {
      await client.close();
    }
  });
}

it("asks before a tool call once per call and records a refused one's cause on its step and event", async () => {
  await withSpace(async ({ sql, store, budget, turn }) => {
    for (let n = 0; n < 2; n++)
      await store.open(participant, {
        scope,
        actorId: decodeOpaqueId("actor", "ObjectId"),
        voiceMode: "cognitive",
      });
    await budget({
      scope: "session",
      category: "tool_call",
      quantity: "calls",
      period: "total",
      limit: 1,
    });
    const intents = new Set<string>();
    const dispatched: string[] = [];
    let asked = 0;
    // A scripted dispatch port: the first pass records the intent and leaves the call queued.
    const research: TurnResearchHost = {
      policy: {
        maxCalls: 3,
        maxModelSteps: 4,
        maxCostMicrousd: 250000,
        modelStepReserveMicrousd: 1,
      },
      toolIntended: async (_participant, _fiber, call) => intents.has(call.effectId),
      executeTool: async (_participant, _fiber, _proposal, call) => {
        dispatched.push(call.effectId);
        if (!intents.has(call.effectId)) {
          intents.add(call.effectId);
          return undefined;
        }
        return { ...call, status: "succeeded", code: null, text: "Reading: 23", costMicrousd: 0 };
      },
    };
    const host: TurnFiberHost = {
      holder: "owner",
      actorId: "actor",
      stores: async (operation) => operation(store),
      respond: async () => ({ text: "Done." }),
      research,
      admit: async (p, f, category, resource) => {
        if (category === "tool_call") asked++;
        return admitSpend(async (op) => op(store), fetch, undefined, p, f, category, resource);
      },
      capabilityRevision: () => 1,
      checkpointed: async () => {},
      durable: async (_fiber, _participant, run) => run(),
    };
    // The first pass is busy until the queued call's result is recorded; the second only reads it.
    await new TurnFibers(host).activate(participant, await turn("s1", "t1", true));
    const [waiting] = (await store.openTurns(participant, scope, "actor")).filter(
      (f) => f.messageId === "t1",
    );
    await new TurnFibers(host).activate(participant, waiting!);
    expect([asked, dispatched]).toEqual([1, ["t1:effect", "t1:effect"]]);

    await new TurnFibers(host).activate(participant, await turn("s1", "t2", true));
    expect([asked, dispatched.length]).toEqual([2, 2]);
    expect(
      await sql(`SELECT s.status || '|' || s.outcome_code || '|' || s.summary
          FROM clockgrove.run_steps s JOIN clockgrove.agent_runs r USING (tenant_id, run_id)
         WHERE r.input_message_id = 't2' AND s.kind = 'tool_execution'`),
    ).toBe("failed|usage_refused|Usage refused: usage_budget_exhausted");
    expect(
      await sql(`SELECT string_agg(concat_ws('|', status, outcome_code, quantities->>'calls'), ','
          ORDER BY sequence) FROM clockgrove.usage_events WHERE category = 'tool_call'`),
    ).toBe("succeeded|1,refused|usage_refused|0");

    // Another session has its own session budget.
    await new TurnFibers(host).activate(participant, await turn("s2", "t3", true));
    expect([asked, dispatched.slice(2)]).toEqual([3, ["t3:effect"]]);
  });
}, 120_000);

it("counts calls in flight, keeps shadows to their own reservation, tallies a player across the world and refuses on unknowns and lost hook authority", async () => {
  await withSpace(async ({ sql, store, usage, runs, budget, turn }) => {
    for (let n = 0; n < 3; n++)
      await store.open(participant, {
        scope,
        actorId: decodeOpaqueId("actor", "ObjectId"),
        voiceMode: "cognitive",
      });
    const posted: string[] = [];
    const send = (async (_url: string, init: RequestInit) => {
      posted.push(String(init.body));
      return new Response(JSON.stringify({ admit: true }));
    }) as typeof fetch;
    const admit = (f: TurnFiber, source?: "moderation_shadow") =>
      admitSpend(
        async (op) => op(store),
        send,
        "deployment",
        participant,
        f,
        "model_call",
        undefined,
        source,
      );
    const usageEvent = (id: string, values: string) =>
      sql(`INSERT INTO clockgrove.usage_events (tenant_id, event_id, world_id, timeline_id,
             space_id, category, source, status, principal_id, actor_id, session_id, quantities,
             occurred_at)
           VALUES ('tenant-a', '${id}', 'world-a', 'timeline-a', ${values}, statement_timestamp())`);
    const calls = {
      scope: "world",
      category: "model_call",
      quantity: "calls",
      period: "day",
    } as const;
    const tokens = { ...calls, scope: "player", quantity: "inputTokens" } as const;

    // One call in flight in s1 fills a world budget of one for s2 and for s1's own shadow.
    await budget({ ...calls, limit: 1 });
    const f1 = await turn("s1", "m1");
    const f2 = await turn("s2", "m2");
    expect(await admit(f1)).toEqual({ admitted: true });
    expect(await admit(f2)).toEqual({ admitted: false, cause: "usage_budget_exhausted" });
    let picked = 0;
    const shadow = admittedShadowDecider(
      {
        pick: async () => (
          picked++, { status: "failed", code: "x", model: "m", latencyMs: 0, costMicrousd: 0 }
        ),
      },
      () => admit(f1, "moderation_shadow"),
    );
    expect(
      await shadow!.pick({ alias: "a", callId: "c", state: "{}", options: {}, instructions: "" }),
    ).toMatchObject({
      status: "failed",
      code: "usage_refused:usage_budget_exhausted",
      usage: { calls: 0 },
    });
    expect(picked).toBe(0);
    // A shadow's event captures only its own source's reservation: s1's call stays in flight.
    await usageEvent(
      "shadow-1",
      `'space-a', 'model_call', 'moderation_shadow', 'failed', 'principal-a', 'actor', 's1', '{"calls":0,"inputTokens":0,"outputTokens":0}'`,
    );
    expect(await admit(f2)).toEqual({ admitted: false, cause: "usage_budget_exhausted" });

    // An unknown quantity refuses its budget until the budget is set again.
    await budget({ ...calls, limit: 100 });
    await budget({ ...tokens, limit: 1000 });
    await usageEvent(
      "step-unknown",
      `'space-a', 'model_call', 'run_step', 'failed', 'principal-a', 'actor', 's1', '{"calls":null,"inputTokens":null,"outputTokens":null}'`,
    );
    expect(await admit(f2)).toEqual({ admitted: false, cause: "usage_budget_unknown" });
    await budget({ ...calls, limit: 100 });
    await budget({ ...tokens, limit: 1000 });
    expect(await admit(f2)).toEqual({ admitted: true });
    // A player's tally counts their use in every space of the world.
    await usageEvent(
      "elsewhere",
      `'space-elsewhere', 'model_call', 'run_step', 'succeeded', 'principal-a', 'actor', 'other', '{"calls":1,"inputTokens":1000,"outputTokens":5}'`,
    );
    expect(await admit(f2)).toEqual({ admitted: false, cause: "usage_budget_exhausted" });
    expect(
      await sql(`SELECT string_agg(concat_ws('|', scope, subject_id, calls, input_tokens,
            calls_unknown_at IS NOT NULL), ',' ORDER BY scope)
          FROM clockgrove.usage_tallies`),
    ).toBe("player|principal-a|1|1000|t,world||1|1000|t");
    await budget({ ...tokens, limit: null });

    // The hook is asked while its registrar holds the authority; after, its space is refused.
    await sql(`UPDATE clockgrove.world_memberships SET roles = ARRAY['owner']
      WHERE principal_id = 'principal-a'`);
    await usage.registerHook(
      operator,
      scope,
      "https://hooks.example.com/admit",
      "hooks.example.com",
    );
    expect(await admit(f2)).toEqual({ admitted: true });
    expect(posted.map((body) => JSON.parse(body).admission.source)).toEqual(["run_step"]);
    await sql(`UPDATE clockgrove.world_memberships SET roles = ARRAY['member']
      WHERE principal_id = 'principal-a'`);
    expect(await admit(f2)).toEqual({ admitted: false, cause: "usage_admission_unavailable" });
    expect(posted).toHaveLength(1);

    // The refused turn is found by its turn number, as other service outcomes are, with the
    // preparing owner's attempt the activation replaced.
    const host: TurnFiberHost = {
      holder: "owner",
      actorId: "actor",
      stores: async (operation) => operation(store),
      respond: async () => ({ text: "never sent" }),
      admit: (p, f, category, resource) =>
        admitSpend(async (op) => op(store), send, "deployment", p, f, category, resource),
      capabilityRevision: () => 1,
      checkpointed: async () => {},
      durable: async (_fiber, _participant, run) => run(),
    };
    await new TurnFibers(host).activate(participant, await turn("s3", "m3"));
    expect(
      (await store.read(participant, scope, "s3", 0, 10)).messages.at(-1)?.serviceOutcome,
    ).toBe("usage_refused");
    expect(
      (await runs.walk(operator, scope, { sessionId: "s3", turn: 1 })).map((run) => [
        run.status,
        run.outcomeCode,
      ]),
    ).toEqual([
      ["abandoned", "owner_lost"],
      ["failed", "usage_refused"],
    ]);
  });
}, 120_000);

it("refuses a turn in flight when its space is paused: its model call, its shadow's and its tool call, with cause world_mode_paused", async () => {
  await withSpace(async ({ sql, store, usage, turn }) => {
    await store.open(participant, {
      scope,
      actorId: decodeOpaqueId("actor", "ObjectId"),
      voiceMode: "cognitive",
    });
    // The turn was accepted while the space was active; the developer's server then pauses it.
    const waiting = await turn("s1", "p1", true);
    await usage.setMode(operator, scope, { mode: "paused", reason: "subscription_lapsed" });
    const ask = (source?: "moderation_shadow") =>
      admitSpend(
        async (op) => op(store),
        fetch,
        undefined,
        participant,
        waiting,
        "model_call",
        undefined,
        source,
      );
    expect([await ask(), await ask("moderation_shadow")]).toEqual([
      { admitted: false, cause: "world_mode_paused" },
      { admitted: false, cause: "world_mode_paused" },
    ]);
    const dispatched: string[] = [];
    const host: TurnFiberHost = {
      holder: "owner",
      actorId: "actor",
      stores: async (operation) => operation(store),
      respond: async () => ({ text: "Done." }),
      research: {
        policy: {
          maxCalls: 3,
          maxModelSteps: 4,
          maxCostMicrousd: 250000,
          modelStepReserveMicrousd: 1,
        },
        toolIntended: async () => false,
        executeTool: async (_participant, _fiber, _proposal, call) => {
          dispatched.push(call.effectId);
          return { ...call, status: "succeeded", code: null, text: "Reading: 23", costMicrousd: 0 };
        },
      },
      admit: (p, f, category, resource) =>
        admitSpend(async (op) => op(store), fetch, undefined, p, f, category, resource),
      capabilityRevision: () => 1,
      checkpointed: async () => {},
      durable: async (_fiber, _participant, run) => run(),
    };
    await new TurnFibers(host).activate(participant, waiting);
    expect(dispatched).toEqual([]);
    expect(
      await sql(`SELECT s.status || '|' || s.outcome_code || '|' || s.summary
          FROM clockgrove.run_steps s JOIN clockgrove.agent_runs r USING (tenant_id, run_id)
         WHERE r.input_message_id = 'p1' AND s.kind = 'tool_execution'`),
    ).toBe("failed|usage_refused|Usage refused: world_mode_paused");
    // Active again: the same space admits the call.
    await usage.setMode(operator, scope, { mode: "active", reason: null });
    expect(await ask()).toEqual({ admitted: true });
  });
}, 120_000);
