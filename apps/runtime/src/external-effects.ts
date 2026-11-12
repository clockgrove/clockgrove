import {
  type AdmittedMcpRead,
  type McpReadEvidence,
  McpReadFailure,
  mcpReadArgumentsHash,
} from "@clockgrove/application";
import type {
  EffectCompletion,
  EffectIntentMetadata,
  PostgreSqlEffects,
} from "@clockgrove/persistence";
import { QueueMessageRefusedError, TypedQueueConsumer } from "./queues.js";

export { mcpReadArgumentsHash } from "@clockgrove/application";

/** Internal trusted composition only; no queue field supplies execution authority. */
export interface ExternalEffectPorts {
  readonly effects: Pick<PostgreSqlEffects, "resolveDispatch" | "claim" | "reconcile" | "complete">;
  /** Reload canonical installation, binding and member grants; verify stored argument hash. */
  readonly admit: (intent: EffectIntentMetadata) => Promise<AdmittedMcpRead | null>;
  readonly adapter: {
    execute(request: AdmittedMcpRead, intent: EffectIntentMetadata): Promise<McpReadEvidence>;
  };
  /** Canonical completion is committed before notifying the waiting actor. */
  readonly completed?: (intent: EffectIntentMetadata) => Promise<void>;
  /** Write sanitized evidence as an encrypted, scoped canonical artifact. */
  readonly persistResult: (
    intent: EffectIntentMetadata,
    evidence: McpReadEvidence,
  ) => Promise<string>;
  readonly attemptId: () => string;
  readonly knownCost?: (intent: EffectIntentMetadata) => number | null;
}

export function externalEffectsConsumer(ports: ExternalEffectPorts): TypedQueueConsumer {
  return new TypedQueueConsumer("external-effects", {
    async handle(message) {
      const intent = await ports.effects.resolveDispatch(message);
      if (!intent) throw new QueueMessageRefusedError("inconsistent");
      const attemptId = ports.attemptId();
      const claim = await ports.effects.claim(intent, attemptId);
      if (!claim.claimed) {
        const recorded = await ports.effects.reconcile(intent);
        if (!recorded || recorded.disposition === "pending" || recorded.disposition === "started")
          throw new Error("External effect is in flight");
        await ports.completed?.(intent);
        return;
      }
      let completion: EffectCompletion;
      let request: AdmittedMcpRead | null;
      let argumentsChanged = false;
      try {
        const admitted = await ports.admit(structuredClone(intent));
        request = admitted === null ? null : structuredClone(admitted);
        if (request) {
          if (mcpReadArgumentsHash(request.arguments) !== intent.argumentsHash) {
            argumentsChanged = true;
            request = null;
          }
        }
      } catch {
        // Nothing has reached the remote adapter, and exception text is private.
        completion = {
          disposition: "failed",
          outcomeCode: "admission_unavailable",
          resultArtifactId: null,
          costMicrousd: null,
        };
        await ports.effects.complete(intent, attemptId, completion);
        await ports.completed?.(intent);
        return;
      }
      if (!request) {
        completion = {
          disposition: "failed",
          outcomeCode: argumentsChanged ? "arguments_changed" : "admission_refused",
          resultArtifactId: null,
          costMicrousd: null,
        };
      } else {
        let resultReceived = false;
        try {
          const evidence = await ports.adapter.execute(request, intent);
          resultReceived = true;
          const resultArtifactId = await ports.persistResult(intent, evidence);
          completion = {
            disposition: evidence.status === "ok" ? "succeeded" : "failed",
            outcomeCode: evidence.status === "ok" ? "ok" : "tool_error",
            resultArtifactId,
            costMicrousd: ports.knownCost?.(intent) ?? null,
          };
        } catch (error) {
          const transportFailure =
            !resultReceived && error instanceof McpReadFailure ? error : null;
          completion = {
            disposition:
              transportFailure !== null && transportFailure.disposition !== "uncertain"
                ? "failed"
                : "uncertain",
            outcomeCode:
              transportFailure?.disposition === "not_sent"
                ? "tool_not_sent"
                : transportFailure?.disposition === "result_refused"
                  ? "tool_result_refused"
                  : "tool_uncertain",
            resultArtifactId: null,
            costMicrousd: null,
          };
        }
      }
      // A storage failure must reach Queue retry, which can reconcile but never resend.
      await ports.effects.complete(intent, attemptId, completion);
      await ports.completed?.(intent);
    },
  });
}
