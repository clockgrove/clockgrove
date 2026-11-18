import type { ConversationParticipant } from "@clockgrove/application";
import { decodeBrowserScope, decodeOpaqueId } from "@clockgrove/contracts";
import {
  PostgreSqlArtifactStore,
  PostgreSqlConversationStore,
  PostgreSqlWakeTriage,
  WebCryptoKeyring,
} from "@clockgrove/persistence";
import { expect, it } from "vitest";
// biome-ignore format: @ts-expect-error covers only the next line.
// @ts-expect-error -- repository-local JavaScript helpers have no declaration file.
import { applyMigrations, applySqlFile, psqlQuery, withDisposableDatabase } from "../../../../scripts/database/lib.mjs";
import { wakeTriagePolicy, wallClockDay } from "../../src/wake-triage.js";
import { connect, type DatabaseFixture } from "../world-fixture.js";

it("spends the daily triage cap once per wall-clock day, whatever the world's day length", async () => {
  expect(wallClockDay(Date.UTC(2026, 10, 16, 23, 30), "Asia/Tokyo")).toBe("2026-11-17");
  expect(wallClockDay(Date.UTC(2026, 10, 16, 23, 30), "UTC")).toBe("2026-11-16");
  expect(() => wakeTriagePolicy('{"dailyBudgetZone":"Not/AZone"}')).toThrow();

  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/seed.sql");
    const sql = async (query: string) =>
      (await psqlQuery(fixture.tools, fixture.environment, query)).trim();
    const client = connect(fixture.environment);
    const keyring = await WebCryptoKeyring.fromJson(
      JSON.stringify({
        version: 1,
        current: "fixture",
        keys: { fixture: Buffer.alloc(32, 7).toString("base64url") },
      }),
    );
    let opened = 0;
    const store = new PostgreSqlConversationStore(
      client,
      new PostgreSqlArtifactStore(client, { keyring }),
      () => `wall-day-session-${(opened += 1)}`,
    );
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
    try {
      const policy = wakeTriagePolicy('{"maxCostMicrousd":1000,"dailyBudgetMicrousd":2000}')!;
      const triage = new PostgreSqlWakeTriage(client);
      const hour = 3_600_000n;
      const reserve = async (id: string, worldHour: number, wallDay: string) => {
        const session = await store.open(participant, {
          scope,
          actorId: decodeOpaqueId("actor", "ObjectId"),
          voiceMode: "cognitive",
        });
        const accepted = await store.acceptTurn(participant, {
          scope,
          sessionId: session.sessionId,
          messageId: id,
          text: "Hello",
        });
        await sql(
          `UPDATE clockgrove.partition_states SET simulation_time=${worldHour * 3_600_000}`,
        );
        return (await triage.reserve(participant, accepted.fiber!, policy, hour, wallDay)).reserved;
      };
      expect(policy.dailyBudgetZone).toBe("UTC");
      const sameDay = [];
      for (const [index, worldHour] of [0, 1, 5, 30].entries())
        sameDay.push(await reserve(`m${index}`, worldHour, "2026-11-16"));
      expect(sameDay).toEqual([true, true, false, false]);
      expect(await reserve("next", 31, "2026-11-17")).toBe(true);
    } finally {
      await client.close();
    }
  });
}, 120_000);
