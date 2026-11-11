import {
  type AdmittedMcpRead,
  MCP_READ_LIMITS,
  type McpReadEvidence,
  McpReadFailure,
} from "@clockgrove/application";
import { sha256Hex } from "@clockgrove/kernel";
import type {
  EffectCompletion,
  EffectIntentMetadata,
  PostgreSqlEffects,
} from "@clockgrove/persistence";
import { QueueMessageRefusedError, TypedQueueConsumer } from "./queues.js";

/** SHA-256 of UTF-8 JSON, sorting object keys recursively and preserving array order. */
export function mcpReadArgumentsHash(value: unknown): string {
  let nodes = 0;
  const encode = (item: unknown, depth: number): string => {
    if (++nodes > MCP_READ_LIMITS.nodes || depth > MCP_READ_LIMITS.depth)
      throw new Error("Invalid effect arguments");
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return JSON.stringify(item);
    if (Array.isArray(item)) {
      if (
        Reflect.ownKeys(item).length !== item.length + 1 ||
        Object.keys(item).length !== item.length ||
        Object.keys(item).some((key, index) => key !== String(index))
      )
        throw new Error("Invalid effect arguments");
      return `[${item.map((child) => encode(child, depth + 1)).join(",")}]`;
    }
    if (
      typeof item !== "object" ||
      item === null ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      throw new Error("Invalid effect arguments");
    const keys = Object.keys(item).sort();
    if (Reflect.ownKeys(item).length !== keys.length) throw new Error("Invalid effect arguments");
    if (keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key)))
      throw new Error("Invalid effect arguments");
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
  };
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid effect arguments");
  const bytes = new TextEncoder().encode(encode(value, 0));
  if (bytes.length > MCP_READ_LIMITS.argumentBytes) throw new Error("Invalid effect arguments");
  return sha256Hex(bytes);
}

/** Internal trusted composition only; no queue field supplies execution authority. */
export interface ExternalEffectPorts {
  readonly effects: Pick<PostgreSqlEffects, "resolveDispatch" | "claim" | "reconcile" | "complete">;
  /** Reload canonical installation, binding and member grants; verify stored argument hash. */
  readonly admit: (intent: EffectIntentMetadata) => Promise<AdmittedMcpRead | null>;
  readonly adapter: { execute(request: AdmittedMcpRead): Promise<McpReadEvidence> };
  /** Write sanitized evidence as an encrypted, scoped canonical artifact. */
  readonly persistResult: (
    intent: EffectIntentMetadata,
    evidence: McpReadEvidence,
  ) => Promise<string>;
  readonly attemptId: () => string;
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
          const evidence = await ports.adapter.execute(request);
          resultReceived = true;
          const resultArtifactId = await ports.persistResult(intent, evidence);
          completion = {
            disposition: evidence.status === "ok" ? "succeeded" : "failed",
            outcomeCode: evidence.status === "ok" ? "ok" : "tool_error",
            resultArtifactId,
            costMicrousd: null,
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
    },
  });
}
