import {
  assembleContext,
  CAPABILITY_REGISTRY,
  type ContextSource,
  renderPrompt,
  sourceHash,
  tokensOfBytes,
} from "@clockgrove/application";
import { type ConversationSession, MAX_DOCUMENT_OCTETS } from "@clockgrove/contracts";
import {
  createModelGateway,
  InMemoryModelBudget,
  PRODUCTION_ALIASES,
  ScriptedModelProvider,
} from "@clockgrove/model-gateway";
import { expect, it } from "vitest";
import {
  ACTOR_ALIAS,
  actorContextTokenBudget,
  actorModelConfiguration,
  actorResponder,
} from "../src/actor-model.js";

const SESSION = "session-long";
const TURNS = 24;
// The session summary at the document size limit, and exchanges of about 300 bytes each.
const SUMMARY = "We talked about the rain on the porch and the acorns. "
  .repeat(160)
  .slice(0, MAX_DOCUMENT_OCTETS);
const said = (sequence: number) =>
  `Message ${sequence}: the rain kept falling on the porch while we counted acorns. `.repeat(4);

it("a long session with a full summary and history keeps getting answers on the default alias", async () => {
  const route = "vercel-ai-gateway/claude-opus-5.5";
  const provider = new ScriptedModelProvider({
    [route]: Array.from({ length: TURNS }, (_, turn) => ({
      kind: "reply" as const,
      chunks: [JSON.stringify({ reply: `Answer ${turn + 1}.`, command: null })],
      inputTokens: 4_000,
      outputTokens: 20,
    })),
  });
  const gateway = createModelGateway({
    aliases: PRODUCTION_ALIASES,
    adapters: { "vercel-ai-gateway": provider, anthropic: provider },
    budget: new InMemoryModelBudget(() => 5_000_000),
    accounting: { record: () => undefined },
  });
  const respond = actorResponder({
    gateway,
    grants: () => CAPABILITY_REGISTRY.grantsFor(["runtime:world-observe"]),
    perceive: async () => undefined,
  });
  const session = {
    sessionId: SESSION,
    actorId: "actor-long",
    participants: [{ principalId: "principal-long", personaId: "persona-long" }],
    scope: { tenantId: "tenant-long", worldId: "world-long" },
  } as unknown as ConversationSession;
  const budget = actorContextTokenBudget(actorModelConfiguration(undefined));
  expect(budget).toBe(4_096);

  for (let turn = 1; turn <= TURNS; turn += 1) {
    const revision = 2 * (turn - 1);
    const input = said(revision + 1);
    const context = await assembleContext(
      {
        sessionId: SESSION,
        inputMessageId: `message-${revision + 1}`,
        inputRevision: revision,
        tokenBudget: budget,
        documents: [
          {
            documentId: "document-summary",
            path: `sessions/${SESSION}/summary.md`,
            kind: "session_summary",
            writeClass: "actor_writable",
            sessionId: SESSION,
            foreignSession: false,
            state: "active",
            version: 1,
            sourceHash: sourceHash(SUMMARY),
            tokens: tokensOfBytes(MAX_DOCUMENT_OCTETS),
          },
        ],
        messages: Array.from({ length: revision }, (_, index) => ({
          messageId: `message-${index + 1}`,
          sequence: index + 1,
          role: index % 2 === 0 ? ("caretaker" as const) : ("actor" as const),
        })),
      },
      async (source: ContextSource) =>
        source.source === "input"
          ? input
          : source.source === "document"
            ? SUMMARY
            : said(source.sequence),
    );
    const prompt = renderPrompt(
      { model: ACTOR_ALIAS, sessionId: SESSION, caretakerMessages: turn },
      context,
    );
    expect(await respond(session, turn, input, prompt)).toMatchObject({ text: `Answer ${turn}.` });
  }
  // Every turn reached the route with the whole summary and, once the session is long, the full
  // 16-message window: over 15 KB, which the old 7,000 bound refused from the first turn.
  expect(provider.calls).toHaveLength(TURNS);
  const last = provider.calls.at(-1)?.messages[0]?.text ?? "";
  expect(last).toContain(JSON.stringify(SUMMARY));
  expect(last).toContain(JSON.stringify(said(2 * TURNS - 17)));
  expect(new TextEncoder().encode(last).length).toBeGreaterThan(15_000);

  // A request that really can exceed the route's limit is still refused, naming its size.
  const oversized = await gateway.stream({
    alias: ACTOR_ALIAS,
    callId: "oversized",
    attribution: { tenantId: "tenant-long", worldId: "world-long", actorId: "actor-long" },
    system: "x".repeat(998_976),
    messages: [{ role: "user", text: "" }],
  });
  expect(oversized).toMatchObject({
    status: "failed",
    code: "input_too_large",
    retryable: false,
    inputTokens: 999_000, // 998,976 bytes + 8 for the message + 16 for framing
    maxInputTokens: 998_976,
  });
  expect(provider.calls).toHaveLength(TURNS);
});
