import {
  type ProviderEvent,
  ProviderFailure,
  type RouteAdapter,
  type RouteCall,
} from "./adapter.js";

/** One scripted call: a reply, or a fault the gateway must turn into an explicit state. */
export type ScriptedStep =
  | Readonly<{
      kind: "reply";
      chunks: readonly string[];
      inputTokens: number;
      outputTokens: number;
      finishReason?: string;
    }>
  /** Sends `chunks` (none: nothing at all), then stalls until the call is aborted. */
  | Readonly<{ kind: "stall"; chunks: readonly string[] }>
  | Readonly<{ kind: "http"; status: number }>;

/**
 * The deterministic provider for tests, CI and evals: each route plays its own finite script in
 * order. An exhausted script is a fault, never a fabricated answer.
 */
export class ScriptedModelProvider implements RouteAdapter {
  private readonly scripts: Map<string, ScriptedStep[]>;
  readonly calls: RouteCall[] = [];

  constructor(scripts: Readonly<Record<string, readonly ScriptedStep[]>>) {
    this.scripts = new Map(Object.entries(scripts).map(([route, steps]) => [route, [...steps]]));
  }

  async *stream(call: RouteCall): AsyncIterable<ProviderEvent> {
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
    for (const text of step.chunks) yield { kind: "text", text };
    if (step.kind === "stall") {
      await new Promise((_, reject) =>
        call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true }),
      );
      return;
    }
    yield {
      kind: "finish",
      finishReason: step.finishReason ?? "stop",
      inputTokens: step.inputTokens,
      outputTokens: step.outputTokens,
      reportedCostUsd: null,
      responseModel: call.route.model,
    };
  }
}
