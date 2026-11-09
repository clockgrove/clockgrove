import type { ShadowDecider } from "@clockgrove/application";
import type { ModelGateway } from "@clockgrove/model-gateway";

/**
 * Adapts the ModelGateway `decide` port to the application's shadow decider. Every call is
 * recorded by the gateway (model, latency, cost, label, confidence); this adapter forwards those
 * numbers into the journaled shadow record, with the reservation an unknown cost is charged at. A
 * gateway refusal is a `failed` outcome, never a throw, so the physical decision never depends on
 * the model; a budget refusal keeps its `budget_exceeded` code and is recorded as over budget.
 */
export function gatewayShadowDecider(
  gateway: Pick<ModelGateway, "decide">,
  attribution: Readonly<{ tenantId: string; worldId: string; actorId: string }>,
): ShadowDecider {
  return {
    async pick(request) {
      const outcome = await gateway.decide({
        alias: request.alias,
        callId: request.callId,
        attribution,
        state: request.state,
        question: {
          type: "choice",
          options: request.options,
          instructions: request.instructions,
        },
      });
      const { record } = outcome;
      const accounting = {
        model: record.model,
        latencyMs: record.latencyMs,
        costMicrousd: record.costMicrousd,
        reservedMicrousd: record.reservedMicrousd,
      };
      if (outcome.status === "failed")
        return { status: "failed", code: outcome.code, ...accounting };
      return {
        status: "completed",
        label: outcome.value.label,
        confidence: outcome.value.confidence,
        ...accounting,
      };
    },
  };
}
