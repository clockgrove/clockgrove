import type { ProviderKind } from "./port.js";

export interface ModelRoute {
  readonly id: string;
  readonly provider: ProviderKind;
  /** The provider's model name; never shown to callers, who use the alias. */
  readonly model: string;
  /** Credential reference (an environment name), resolved only inside the adapter. */
  readonly credential: string | null;
  /** Override of the provider's base URL, for local fixtures. */
  readonly baseURL?: string;
  /** USD per million tokens, which is also microdollars per token. */
  readonly priceUsdPerMTok: Readonly<{ input: number; output: number }>;
}

export interface ModelAliasDefinition {
  readonly alias: string;
  readonly policyVersion: string;
  /** Tried in order; a later route is a fallback, recorded as such. */
  readonly routes: readonly ModelRoute[];
  /**
   * The most input, in the gateway's measure (`inputTokenBound`), that every route of the alias
   * accepts. A request above it is refused `input_too_large` before any route is called.
   */
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly timeouts: Readonly<{ firstByteMs: number; idleMs: number; totalMs: number }>;
}

/** The most the alias's bounds allow any route to cost: the worst case at the input limit. */
export function costCeilingMicrousd(alias: ModelAliasDefinition): number {
  return requestCostCeilingMicrousd(alias, alias.maxInputTokens);
}

/**
 * The reservation for one call whose input measures `inputTokens` (`inputTokenBound`, never below
 * the real count): the most any route of the alias can charge for that input and a full reply.
 */
export function requestCostCeilingMicrousd(
  alias: ModelAliasDefinition,
  inputTokens: number,
): number {
  return Math.max(
    ...alias.routes.map((route) => routeCostCeilingMicrousd(alias, route, inputTokens)),
  );
}

/** The most one route of the alias can charge for input measuring `inputTokens` and a full reply. */
export function routeCostCeilingMicrousd(
  alias: ModelAliasDefinition,
  route: ModelRoute,
  inputTokens: number,
): number {
  return (
    inputTokens * route.priceUsdPerMTok.input + alias.maxOutputTokens * route.priceUsdPerMTok.output
  );
}

/**
 * Claude Opus 5.5 accepts 1M tokens of context (Anthropic's model notes for Opus 5.5), and input
 * plus the requested output must fit in it: the input limit is the window less the output cap.
 */
const OPUS_5_5_CONTEXT_TOKENS = 1_000_000;
const ACTOR_MAX_OUTPUT_TOKENS = 1_024;
const OPUS_5_5_MAX_INPUT_TOKENS = OPUS_5_5_CONTEXT_TOKENS - ACTOR_MAX_OUTPUT_TOKENS;

// Claude Opus 5.5: $4 input and $20 output per million tokens (Anthropic pricing, 2026-10-06).
const OPUS_5_5_PRICE = { input: 4, output: 20 } as const;

/**
 * Production aliases. Decision (issue 16): Vercel AI Gateway first, Anthropic directly as the
 * same-model fallback, so a fallback never changes policy or eval identity.
 */
export function productionAliases(
  conversationAlias: string,
  pilotAlias: string,
): readonly ModelAliasDefinition[] {
  return [
    {
      alias: conversationAlias,
      policyVersion: `${conversationAlias}@1`,
      routes: [
        {
          id: "vercel-ai-gateway/claude-opus-5.5",
          provider: "vercel-ai-gateway",
          model: "anthropic/claude-opus-5.5",
          credential: "AI_GATEWAY_API_KEY",
          priceUsdPerMTok: OPUS_5_5_PRICE,
        },
        {
          id: "anthropic/claude-opus-5-5",
          provider: "anthropic",
          model: "claude-opus-5-5",
          credential: "ANTHROPIC_API_KEY",
          priceUsdPerMTok: OPUS_5_5_PRICE,
        },
      ],
      // The route's own input limit; context assembly keeps a turn well inside it (issue 349).
      // Decision: a conversational reply of 1k tokens. A reply cut at the cap completes with the
      // attempt's finishReason "length".
      maxInputTokens: OPUS_5_5_MAX_INPUT_TOKENS,
      maxOutputTokens: ACTOR_MAX_OUTPUT_TOKENS,
      // Decisions: 15 s to first text covers model thinking before the reply; 10 s of silence after
      // text has started means a stalled stream; 60 s bounds one route attempt, so a turn that falls
      // back after a first-byte timeout lasts at most 15 s + 60 s.
      timeouts: { firstByteMs: 15_000, idleMs: 10_000, totalMs: 60_000 },
    },
    {
      alias: pilotAlias,
      policyVersion: `${pilotAlias}@1`,
      routes: [
        {
          id: "vercel-ai-gateway/claude-opus-5.5",
          provider: "vercel-ai-gateway",
          model: "anthropic/claude-opus-5.5",
          credential: "AI_GATEWAY_API_KEY",
          priceUsdPerMTok: OPUS_5_5_PRICE,
        },
        {
          id: "anthropic/claude-opus-5-5",
          provider: "anthropic",
          model: "claude-opus-5-5",
          credential: "ANTHROPIC_API_KEY",
          priceUsdPerMTok: OPUS_5_5_PRICE,
        },
      ],
      // The route's own input limit (issue 349). The pilot rubric's $0.05 a turn (issue 19) is kept
      // by context assembly's 4,096-token budget, not by a refusal; each call reserves the worst
      // case of its own measured input. A reply cut at the cap completes with the attempt's
      // finishReason "length".
      maxInputTokens: OPUS_5_5_MAX_INPUT_TOKENS,
      maxOutputTokens: ACTOR_MAX_OUTPUT_TOKENS,
      // Decisions: 15 s to first text covers model thinking before the reply; 10 s of silence after
      // text has started means a stalled stream; 60 s bounds one route attempt, so a turn that falls
      // back after a first-byte timeout lasts at most 15 s + 60 s.
      timeouts: { firstByteMs: 15_000, idleMs: 10_000, totalMs: 60_000 },
    },
  ];
}

export const PRODUCTION_ALIASES = productionAliases("actor.conversation", "actor.pilot");
