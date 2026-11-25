import { type BrowserScope, decodeBrowserScope } from "./browser-protocol.js";
import { decodeUsageUrlRequest } from "./usage-webhooks.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  literal,
  nonNegativeInteger,
  record,
  string,
} from "./validation.js";

// Admission before spend: see docs/protocols/usage.md, "Admission before spend".

export const USAGE_BUDGET_SCOPES = ["world", "player", "session"] as const;
export type UsageBudgetScope = (typeof USAGE_BUDGET_SCOPES)[number];

export const USAGE_BUDGET_PERIODS = ["day", "total"] as const;
export type UsageBudgetPeriod = (typeof USAGE_BUDGET_PERIODS)[number];

export const USAGE_BUDGET_CATEGORIES = ["model_call", "tool_call"] as const;
export type UsageBudgetCategory = (typeof USAGE_BUDGET_CATEGORIES)[number];

export const USAGE_BUDGET_QUANTITIES = ["calls", "inputTokens", "outputTokens"] as const;
export type UsageBudgetQuantity = (typeof USAGE_BUDGET_QUANTITIES)[number];

/** A ceiling on one quantity of one category over one period; a `null` limit is off. */
export interface UsageBudget {
  readonly scope: UsageBudgetScope;
  readonly category: UsageBudgetCategory;
  readonly quantity: UsageBudgetQuantity;
  readonly period: UsageBudgetPeriod;
  readonly limit: number | null;
}

/** Sets (or, with a `null` limit, turns off) one budget for the caller's space. */
export interface UsageBudgetRequest {
  readonly version: 1;
  readonly scope: BrowserScope;
  readonly budget: UsageBudget;
}

export interface UsageBudgetList {
  readonly budgets: readonly UsageBudget[];
}

/** Registers, replaces or (with a `null` URL) removes the caller's admission hook for one space. */
export interface UsageAdmissionHookRequest {
  readonly version: 1;
  readonly scope: BrowserScope;
  readonly url: string | null;
}

export interface UsageAdmissionHookRegistration {
  readonly hookId: string;
  readonly url: string | null;
  /** The Standard Webhooks signing secret (`whsec_…`); `null` when no hook is registered. */
  readonly signingSecret: string | null;
}

/** The signed JSON body the developer's hook receives before a billable call. */
export interface UsageAdmissionRequestBody {
  readonly type: "usage.admission";
  readonly admission: {
    readonly category: "model_call" | "tool_call";
    readonly resource: string | null;
    readonly worldId: string;
    readonly timelineId: string;
    readonly spaceId: string;
    readonly principalId: string;
    readonly personaId: string | null;
    readonly actorId: string;
    readonly sessionId: string;
    readonly runId: string | null;
  };
}

export type UsageAdmissionAnswer =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: string };

export const USAGE_REFUSAL_CAUSES = [
  "usage_budget_exhausted",
  "usage_budget_unknown",
  "usage_admission_refused",
  "usage_admission_unavailable",
] as const;
export type UsageRefusalCause = (typeof USAGE_REFUSAL_CAUSES)[number];

function decodeBudget(value: unknown, path: string): UsageBudget {
  const v = record(value, path);
  exactKeys(v, ["scope", "category", "quantity", "period", "limit"], [], path);
  const scope = literal(v.scope, USAGE_BUDGET_SCOPES, `${path}.scope`);
  const category = literal(v.category, USAGE_BUDGET_CATEGORIES, `${path}.category`);
  const quantity = literal(v.quantity, USAGE_BUDGET_QUANTITIES, `${path}.quantity`);
  const period = literal(v.period, USAGE_BUDGET_PERIODS, `${path}.period`);
  if (category === "tool_call" && quantity !== "calls")
    throw new ContractDecodeError(`${path}.quantity`, "a tool_call budget counts only calls");
  const limit = v.limit === null ? null : nonNegativeInteger(v.limit, `${path}.limit`);
  return Object.freeze({ scope, category, quantity, period, limit });
}

export function decodeUsageBudgetRequest(value: unknown): UsageBudgetRequest {
  const path = "usageBudget";
  const v = record(value, path);
  exactKeys(v, ["version", "tenantId", "worldId", "timelineId", "spaceId", "budget"], [], path);
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  const scope = decodeBrowserScope({ tenantId, worldId, timelineId, spaceId });
  return Object.freeze({ version: 1, scope, budget: decodeBudget(v.budget, `${path}.budget`) });
}

export function decodeUsageBudgetList(value: unknown): UsageBudgetList {
  const path = "usageBudgets";
  const v = record(value, path);
  exactKeys(v, ["budgets"], [], path);
  return Object.freeze({
    budgets: array(v.budgets, `${path}.budgets`, decodeBudget),
  });
}

export function decodeUsageAdmissionHookRequest(value: unknown): UsageAdmissionHookRequest {
  // The URL rules are the webhook's own.
  return decodeUsageUrlRequest(value, "usageAdmissionHook");
}

export function decodeUsageAdmissionAnswer(value: unknown): UsageAdmissionAnswer {
  const path = "usageAdmissionAnswer";
  const v = record(value, path);
  if (v.admit === true) {
    exactKeys(v, ["admit"], [], path);
    return Object.freeze({ admit: true });
  }
  if (v.admit !== false) throw new ContractDecodeError(`${path}.admit`, "expected a boolean");
  exactKeys(v, ["admit", "reason"], [], path);
  const reason = string(v.reason, `${path}.reason`);
  if (!/^[a-z0-9_]{1,64}$/u.test(reason))
    throw new ContractDecodeError(`${path}.reason`, "expected 1 to 64 of a-z, 0-9 and _");
  return Object.freeze({ admit: false, reason });
}
