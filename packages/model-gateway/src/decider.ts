import { ProviderFailure } from "./adapter.js";
import type {
  DecisionAdapter,
  DecisionAdapterResult,
  DecisionAnswer,
  DecisionCall,
} from "./decision.js";

/** One scripted decision: an answer, or a fault the gateway must turn into an explicit state. */
export type ScriptedDecisionStep =
  | Readonly<{
      kind: "answer";
      answer: DecisionAnswer;
      costUsd?: number;
      /** Simulated provider latency, awaited before the answer. */
      delayMs?: number;
    }>
  | Readonly<{ kind: "http"; status: number }>;

/**
 * The deterministic decider for tests, CI and evals. Each alias route plays its own finite script
 * in order; an exhausted script is a fault, never a fabricated answer.
 */
export class ScriptedDecider implements DecisionAdapter {
  private readonly scripts: Map<string, ScriptedDecisionStep[]>;
  readonly calls: DecisionCall[] = [];

  constructor(scripts: Readonly<Record<string, readonly ScriptedDecisionStep[]>>) {
    this.scripts = new Map(Object.entries(scripts).map(([route, steps]) => [route, [...steps]]));
  }

  async decide(call: DecisionCall): Promise<DecisionAdapterResult> {
    this.calls.push(call);
    const step = this.scripts.get(call.route.id)?.shift();
    if (step === undefined) throw new ProviderFailure("unavailable", null, false);
    if (step.kind === "http") {
      throw new ProviderFailure(
        step.status === 429 ? "rate_limited" : "unavailable",
        step.status,
        step.status === 429 || step.status >= 500,
      );
    }
    if (step.delayMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    return {
      answer: step.answer,
      inputTokens: null,
      outputTokens: null,
      reportedCostUsd: step.costUsd ?? null,
      responseModel: call.route.model,
    };
  }
}
