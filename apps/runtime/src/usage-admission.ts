import type {
  ConversationParticipant,
  ConversationStore,
  ShadowDecider,
  TurnFiber,
} from "@clockgrove/application";
import {
  decodeUsageAdmissionAnswer,
  type UsageAdmissionRequestBody,
  type UsageAdmissionSource,
} from "@clockgrove/contracts";
import { Webhook } from "standardwebhooks";
import { usageWebhookSecret } from "./usage-webhooks.js";

/** Decision: 2 s, since a player waits on the answer before the model is called. */
const ASK_TIMEOUT_MS = 2_000;
/** Decision: 4 KiB, ample for `{ "admit": false, "reason": … }` with a 64-character reason. */
const MAX_ANSWER_BYTES = 4_096;

export type AdmissionAnswer =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly cause: string };

const UNAVAILABLE: AdmissionAnswer = { admitted: false, cause: "usage_admission_unavailable" };

/**
 * Asks the space's budgets, then its hook, before a call (`docs/protocols/usage.md`, "Admission
 * before spend"). A store without admission admits.
 */
export async function admitSpend(
  stores: <T>(operation: (store: ConversationStore) => Promise<T>) => Promise<T>,
  send: typeof fetch,
  deploymentSecret: string | undefined,
  participant: ConversationParticipant,
  fiber: TurnFiber,
  category: "model_call" | "tool_call",
  resource?: string,
  source: UsageAdmissionSource = "run_step",
): Promise<AdmissionAnswer> {
  const grant = await stores(async (store) =>
    store.admitUsage?.(participant, fiber, category, resource, source),
  );
  if (grant === undefined) return { admitted: true };
  if (grant.decision === "refused") return { admitted: false, cause: String(grant.cause) };
  if (grant.hook === null) return { admitted: true };
  return askAdmissionHook(send, deploymentSecret, grant.hook, grant.admission);
}

/**
 * A shadow's decider that asks admission right before its model call. A refusal is the decision's
 * failure `usage_refused:<cause>` with no call made, so its record and usage event show it; an
 * admission that cannot be asked refuses too.
 */
export function admittedShadowDecider(
  decider: ShadowDecider | undefined,
  admit: () => Promise<AdmissionAnswer>,
): ShadowDecider | undefined {
  if (decider === undefined) return undefined;
  return {
    async pick(request) {
      const admission = await admit().catch(() => UNAVAILABLE);
      if (admission.admitted) return decider.pick(request);
      return {
        status: "failed",
        code: `usage_refused:${admission.cause}`,
        model: "none",
        latencyMs: 0,
        costMicrousd: 0,
        usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

/**
 * Asks the developer's hook whether a call may be made (`docs/protocols/usage.md`). The post is
 * signed as Standard Webhooks with the hook's own secret. Anything but a valid 2xx answer within
 * the timeout refuses, so a hook that is down never lets spend through.
 */
export async function askAdmissionHook(
  send: typeof fetch,
  deploymentSecret: string | undefined,
  hook: { readonly hookId: string; readonly url: string },
  admission: UsageAdmissionRequestBody["admission"],
): Promise<AdmissionAnswer> {
  if (deploymentSecret === undefined || deploymentSecret === "") return UNAVAILABLE;
  try {
    const body = JSON.stringify({ type: "usage.admission", admission });
    const messageId = `admission_${crypto.randomUUID()}`;
    const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const secret = await usageWebhookSecret(deploymentSecret, hook.hookId);
    const response = await send(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": messageId,
        "webhook-timestamp": String(sentAt.getTime() / 1000),
        "webhook-signature": new Webhook(secret).sign(messageId, sentAt, body),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      return UNAVAILABLE;
    }
    const answer = decodeUsageAdmissionAnswer(JSON.parse(await boundedText(response)));
    return answer.admit
      ? { admitted: true }
      : { admitted: false, cause: `usage_admission_refused:${answer.reason}` };
  } catch {
    return UNAVAILABLE;
  }
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      throw new Error("admission answer too large");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(await new Blob(chunks).arrayBuffer());
}
