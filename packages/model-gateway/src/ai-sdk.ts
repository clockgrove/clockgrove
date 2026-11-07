// The only module that imports provider SDKs. Their types never leave it.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway, jsonSchema, Output, streamText } from "ai";
import {
  type ProviderEvent,
  ProviderFailure,
  type RouteAdapter,
  type RouteCall,
} from "./adapter.js";
import type { CredentialResolver } from "./port.js";

/** Credential references resolve from the process environment only when a call is made. */
export const environmentCredentials: CredentialResolver = (reference) => {
  const value = globalThis.process?.env?.[reference];
  return value === undefined || value === "" ? undefined : value;
};

/**
 * One Vercel AI SDK adapter for both production providers: Vercel AI Gateway (which also routes
 * generation models) and Anthropic directly. Retries belong to the gateway, so the SDK makes none.
 */
export class AiSdkRouteAdapter implements RouteAdapter {
  constructor(
    private readonly credentials: CredentialResolver,
    private readonly fetch?: typeof globalThis.fetch,
  ) {}

  async *stream(call: RouteCall): AsyncIterable<ProviderEvent> {
    const { route } = call;
    const apiKey = route.credential === null ? undefined : this.credentials(route.credential);
    if (apiKey === undefined) throw new ProviderFailure("credential_missing", null, false);
    const settings = {
      apiKey,
      ...(route.baseURL === undefined ? {} : { baseURL: route.baseURL }),
      ...(this.fetch === undefined ? {} : { fetch: this.fetch }),
    };
    const model =
      route.provider === "anthropic"
        ? createAnthropic(settings)(route.model)
        : createGateway(settings)(route.model);
    const result = streamText({
      model,
      system: call.system,
      messages: call.messages.map((message) => ({ role: message.role, content: message.text })),
      maxOutputTokens: call.maxOutputTokens,
      maxRetries: 0,
      abortSignal: call.signal,
      // The SDK's default handler logs the error, which may hold provider response bodies.
      onError: () => undefined,
      ...(call.jsonSchema === undefined
        ? {}
        : { output: Output.object({ schema: jsonSchema(call.jsonSchema) }) }),
    });
    let finish: Extract<ProviderEvent, { kind: "finish" }> | undefined;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        yield { kind: "text", text: part.text };
      } else if (part.type === "finish-step") {
        finish = {
          kind: "finish",
          finishReason: part.finishReason,
          inputTokens: part.usage.inputTokens ?? null,
          outputTokens: part.usage.outputTokens ?? null,
          reportedCostUsd: reportedCost(part.providerMetadata),
        };
      } else if (part.type === "error") {
        throw classify(part.error);
      } else if (part.type === "abort") {
        throw call.signal.reason ?? new Error("model call aborted");
      }
    }
    if (finish !== undefined) yield finish;
  }
}

function classify(error: unknown): ProviderFailure {
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? Number((error as { statusCode: unknown }).statusCode)
      : Number.NaN;
  if (!Number.isInteger(status)) return new ProviderFailure("unavailable", null, true);
  if (status === 429) return new ProviderFailure("rate_limited", status, true);
  return new ProviderFailure("unavailable", status, status === 408 || status >= 500);
}

function reportedCost(metadata: unknown): number | null {
  const cost = (metadata as { gateway?: { cost?: unknown } } | undefined)?.gateway?.cost;
  const value = typeof cost === "string" || typeof cost === "number" ? Number(cost) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}
