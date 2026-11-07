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
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly timeouts: Readonly<{ firstByteMs: number; idleMs: number; totalMs: number }>;
}

/** The reservation for one call: the most the alias's bounds allow any route to cost. */
export function costCeilingMicrousd(alias: ModelAliasDefinition): number {
  return Math.max(
    ...alias.routes.map(
      (route) =>
        alias.maxInputTokens * route.priceUsdPerMTok.input +
        alias.maxOutputTokens * route.priceUsdPerMTok.output,
    ),
  );
}

// Claude Opus 5.5: $4 input and $20 output per million tokens (Anthropic pricing, 2026-10-06).
const OPUS_5_5_PRICE = { input: 4, output: 20 } as const;

/**
 * Production aliases. Decision (issue 16): Vercel AI Gateway first, Anthropic directly as the
 * same-model fallback, so a fallback never changes policy or eval identity.
 */
export const PRODUCTION_ALIASES: readonly ModelAliasDefinition[] = [
  {
    alias: "stevie.conversation",
    policyVersion: "stevie.conversation@1",
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
    // Decisions: a context-assembly budget of 16k tokens and a conversational reply of 1k tokens.
    maxInputTokens: 16_000,
    maxOutputTokens: 1_024,
    // Decisions: 15 s to first text covers model thinking before the reply; 10 s of silence after
    // text has started means a stalled stream; 60 s bounds one conversational turn.
    timeouts: { firstByteMs: 15_000, idleMs: 10_000, totalMs: 60_000 },
  },
];
