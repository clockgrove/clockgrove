import { describe, expect, it } from "vitest";
import {
  AiSdkRouteAdapter,
  createModelGateway,
  environmentCredentials,
  InMemoryModelBudget,
  productionAliases,
} from "../src/index.js";

// Opt-in: sends one bounded request through the real production alias. `pnpm test` never sets
// CLOCKGROVE_MODEL_LIVE (and Turbo strips provider keys), so CI skips it by default.
const live =
  process.env.CLOCKGROVE_MODEL_LIVE === "1" &&
  (environmentCredentials("AI_GATEWAY_API_KEY") !== undefined ||
    environmentCredentials("ANTHROPIC_API_KEY") !== undefined);

describe.skipIf(!live)("production model route (live)", () => {
  it("answers through stevie.conversation and records model, tokens and cost", async () => {
    const adapter = new AiSdkRouteAdapter(environmentCredentials);
    const gateway = createModelGateway({
      aliases: productionAliases("stevie.conversation", "stevie.pilot"),
      adapters: { "vercel-ai-gateway": adapter, anthropic: adapter },
      // One call's ceiling: 16,000 × 4 + 1,024 × 20 microdollars, about $0.08.
      budget: new InMemoryModelBudget(() => 84_480),
      accounting: { record: (record) => console.log(JSON.stringify(record, null, 2)) },
    });
    const outcome = await gateway.stream({
      alias: "stevie.conversation",
      callId: `live-${Date.now()}`,
      attribution: { tenantId: "local", worldId: "live-check", actorId: "stevie" },
      system: "You are Stevie, a raccoon. Answer in one short sentence.",
      messages: [{ role: "user", text: "What did you find in the yard today?" }],
    });
    const answered = outcome.record.attempts.at(-1);
    expect(outcome.status, JSON.stringify(outcome.record.attempts)).toBe("completed");
    // The provider-reported model, not the route's pinned name.
    expect(answered?.responseModel).toMatch(/claude-opus-5[.-]5/u);
    expect(answered?.inputTokens).toBeGreaterThan(0);
    expect(answered?.outputTokens).toBeGreaterThan(0);
    expect(outcome.record.costMicrousd).toBeGreaterThan(0);
    expect(outcome.record.costMicrousd).toBeLessThanOrEqual(outcome.record.reservedMicrousd);
    // Vercel AI Gateway reports its own charge: the pinned $4/$20 price must agree within 10%.
    if (answered?.reportedCostUsd != null) {
      const reported = answered.reportedCostUsd * 1_000_000;
      expect(Math.abs((answered.costMicrousd ?? 0) - reported)).toBeLessThanOrEqual(reported / 10);
    }
  });
});
