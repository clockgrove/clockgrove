import {
  AuthorizationRefusedError,
  NO_PRIVACY_CEILING,
  type RuntimeAuthorizationDenial,
} from "@clockgrove/application";
import type {
  PrincipalId,
  UsageAdmissionHookRegistration,
  UsageAdmissionHookRequest,
  UsageBudgetList,
  UsageBudgetRequest,
  UsagePage,
  UsageQueryRequest,
  UsageWebhookRegistration,
  UsageWebhookRequest,
  WorldModeRequest,
  WorldModeState,
  WorldOfferList,
  WorldOfferRequest,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import {
  type InspectorAccess,
  type PostgreSqlClient,
  PostgreSqlInspectorAudit,
  PostgreSqlUsageAdmission,
  PostgreSqlUsageReader,
  PostgreSqlUsageWebhooks,
} from "@clockgrove/persistence";
import { INSPECT_GRANT } from "./inspector.js";
import { mayHoldPurchaseGrant, PURCHASE_GRANT } from "./purchases.js";
import { usageWebhookSecret } from "./usage-webhooks.js";
import { assertWorldCommandContext, worldAuthorization } from "./world-commands.js";

/** The grant to register a usage webhook (`docs/protocols/usage.md`). */
export const USAGE_WEBHOOK_GRANT = "runtime:usage-webhook";

/**
 * Whether the caller may point the space's usage at an outside host: `runtime:usage-webhook`,
 * which a world's owner holds by default and may delegate, as `runtime:mcp-install` (the owner's
 * decision of 2026-11-25). An actor or system identity never qualifies, even with the grant; 0083's
 * `runtime_usage_webhook_registrar` applies the same rule in the database.
 */
export function holdsUsageWebhookGrant(context: TrustedExecutionContext): boolean {
  const roles = context.roles.map(String);
  if (roles.includes("actor") || String(context.principalId).startsWith("system:")) return false;
  return context.grants.map(String).includes(USAGE_WEBHOOK_GRANT) || roles.includes("owner");
}

/** The usage query's and webhook registration's routes (`docs/protocols/usage.md`). */
export const USAGE_ROUTES = [
  "/v1/runtime/usage/query",
  "/v1/runtime/usage/webhook",
  "/v1/runtime/usage/budget",
  "/v1/runtime/usage/admission-hook",
  "/v1/runtime/world-mode",
  "/v1/runtime/offers",
] as const;

/** Setting a budget restricts spend and sends nothing out, so it needs the operator's grant. */
const OPERATE_GRANT = "runtime:world-operate";

/**
 * Usage events for inspectors (issue 329): the run inspector's `runtime:world-inspect` grant and
 * `operator_evidence` ceiling, rate limit and audit, with subject `usage-events`.
 */
export class PostgreSqlUsageInspector {
  private readonly audit: PostgreSqlInspectorAudit;
  private readonly reader: PostgreSqlUsageReader;
  private readonly webhooks: PostgreSqlUsageWebhooks;
  private readonly admission: PostgreSqlUsageAdmission;
  constructor(client: PostgreSqlClient) {
    this.admission = new PostgreSqlUsageAdmission(client);
    this.webhooks = new PostgreSqlUsageWebhooks(client);
    this.audit = new PostgreSqlInspectorAudit(client);
    this.reader = new PostgreSqlUsageReader(client);
  }

  query(input: UsageQueryRequest, context: TrustedExecutionContext): Promise<UsagePage> {
    return this.audited(input, READ, context, (authorization) =>
      this.reader.query(authorization, input),
    );
  }

  /**
   * Registers, replaces or disables the caller's webhook for the space. The reply carries the
   * signing secret, derived from the deployment secret and the webhook's ID. A webhook makes the
   * deployment post to a host the caller names, the egress an outbound MCP server has, so it needs
   * `runtime:usage-webhook` (`holdsUsageWebhookGrant`) beside the query's grant and ceiling. The
   * `usage-webhook` audit row, naming where the export now goes, commits with the registration; a
   * failure is audited apart.
   */
  async register(
    input: UsageWebhookRequest,
    context: TrustedExecutionContext,
    deploymentSecret: string,
  ): Promise<UsageWebhookRegistration> {
    const entryId = input.url === null ? "disabled" : new URL(input.url).origin;
    const target: AuditTarget = { subject: "usage-webhook", entryId };
    const authorization = await this.admitted(input, context, [INSPECT_GRANT], (trusted) => {
      if (!holdsUsageWebhookGrant(trusted))
        throw new AuthorizationRefusedError("usage webhook authority refused");
    });
    try {
      const webhookId = await this.webhooks.register(
        authorization,
        input.scope,
        input.url,
        entryId,
      );
      return {
        webhookId,
        url: input.url,
        signingSecret:
          input.url === null ? null : await usageWebhookSecret(deploymentSecret, webhookId),
      };
    } catch (error) {
      await this.audit.record(authorization, access(input, "allow", "failed", target));
      throw error;
    }
  }

  /** Sets one budget of the space (`usage-budget` audit) and lists them all. */
  async setBudget(
    input: UsageBudgetRequest,
    context: TrustedExecutionContext,
  ): Promise<UsageBudgetList> {
    const { scope, category, quantity, period } = input.budget;
    const target: AuditTarget = {
      subject: "usage-budget",
      entryId: `${scope}:${category}:${quantity}:${period}`,
    };
    const authorization = await this.admitted(input, context, [INSPECT_GRANT, OPERATE_GRANT]);
    return this.refusedAsDenied(input, authorization, target, async () => ({
      budgets: await this.admission.setBudget(authorization, input.scope, input.budget),
    }));
  }

  /**
   * Sets the space's mode (`world-mode` audit, the entry the mode). Like a budget it restricts the
   * world and sends nothing outside, so it needs the operator's grant beside the reader's.
   */
  async setMode(
    input: WorldModeRequest,
    context: TrustedExecutionContext,
  ): Promise<WorldModeState> {
    const target: AuditTarget = { subject: "world-mode", entryId: input.mode };
    const authorization = await this.admitted(input, context, [INSPECT_GRANT, OPERATE_GRANT]);
    return this.refusedAsDenied(input, authorization, target, () =>
      this.admission.setMode(authorization, input.scope, {
        mode: input.mode,
        reason: input.reason,
      }),
    );
  }

  /**
   * Sets or withdraws one offer of the space (`world-offer` audit, the entry the offer's ID). It
   * puts the developer's commerce and checkout link in front of players, so it needs
   * `runtime:world-purchase` beside the reader's grant, as a purchase does.
   */
  async setOffer(
    input: WorldOfferRequest,
    context: TrustedExecutionContext,
  ): Promise<WorldOfferList> {
    const target: AuditTarget = { subject: "world-offer", entryId: input.offerId };
    // An offer is the developer's commerce, linked to a checkout host the caller names: the
    // purchase's grant (owner-held by default, delegable), never the operator's.
    const authorization = await this.admitted(
      input,
      context,
      [INSPECT_GRANT, PURCHASE_GRANT],
      (trusted) => {
        if (!mayHoldPurchaseGrant(trusted))
          throw new AuthorizationRefusedError("world offer authority refused");
      },
    );
    return this.refusedAsDenied(input, authorization, target, async () => ({
      offers: await this.admission.setOffer(authorization, input),
    }));
  }

  /**
   * Registers, replaces or disables the space's admission hook. It posts turn attribution to a
   * host the caller names, so it takes the usage webhook's authority; the signing secret derives
   * from the deployment secret and the hook's ID.
   */
  async registerAdmissionHook(
    input: UsageAdmissionHookRequest,
    context: TrustedExecutionContext,
    deploymentSecret: string,
  ): Promise<UsageAdmissionHookRegistration> {
    const entryId = input.url === null ? "disabled" : new URL(input.url).origin;
    const target: AuditTarget = { subject: "usage-admission-hook", entryId };
    const authorization = await this.admitted(input, context, [INSPECT_GRANT], (trusted) => {
      if (!holdsUsageWebhookGrant(trusted))
        throw new AuthorizationRefusedError("usage admission hook authority refused");
    });
    return this.refusedAsDenied(input, authorization, target, async () => {
      const hookId = await this.admission.registerHook(
        authorization,
        input.scope,
        input.url,
        entryId,
      );
      return {
        hookId,
        url: input.url,
        signingSecret:
          input.url === null ? null : await usageWebhookSecret(deploymentSecret, hookId),
      };
    });
  }

  /** A failure is audited apart; the database's refusal (`42501`) answers as an authority refusal. */
  private async refusedAsDenied<T>(
    input: { readonly scope: UsageQueryRequest["scope"] },
    authorization: ReturnType<typeof worldAuthorization>,
    target: AuditTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await this.audit.record(authorization, access(input, "allow", "failed", target));
      if ((error as { code?: unknown }).code === "42501")
        throw new AuthorizationRefusedError("usage admission refused");
      throw error;
    }
  }

  /** Checks the grants and the ceiling, auditing a refusal, then applies the rate limit. */
  private async admitted(
    input: { readonly scope: UsageQueryRequest["scope"] },
    context: TrustedExecutionContext,
    grants: readonly string[],
    authority?: (context: TrustedExecutionContext) => void,
  ): Promise<ReturnType<typeof worldAuthorization>> {
    try {
      for (const grant of grants) assertWorldCommandContext(context, input.scope, grant);
      authority?.(context);
      if (!context.privacyCeiling.allowedCategories.includes("operator_evidence"))
        throw new AuthorizationRefusedError("inspection ceiling refused");
    } catch (error) {
      await this.deny(input, context.principalId, undefined);
      throw error;
    }
    const authorization = worldAuthorization(context);
    await this.audit.admit(authorization);
    return authorization;
  }

  private async audited<T>(
    input: { readonly scope: UsageQueryRequest["scope"] },
    target: AuditTarget,
    context: TrustedExecutionContext,
    operation: (authorization: ReturnType<typeof worldAuthorization>) => Promise<T>,
  ): Promise<T> {
    const authorization = await this.admitted(input, context, [INSPECT_GRANT]);
    let reasonCode: InspectorAccess["reasonCode"] = "failed";
    try {
      const output = await operation(authorization);
      reasonCode = "served";
      return output;
    } finally {
      await this.audit.record(authorization, access(input, "allow", reasonCode, target));
    }
  }

  /** Records a refused access under the requested tenant, whether or not the principal is a member. */
  deny(
    input: { readonly scope: UsageQueryRequest["scope"] },
    principalId: PrincipalId,
    denial: RuntimeAuthorizationDenial | undefined,
  ): Promise<void> {
    return this.audit.record(
      { tenantId: input.scope.tenantId, principalId, privacyCeiling: NO_PRIVACY_CEILING },
      access(input, "deny", denial?.reasonCode ?? "authority-mismatch"),
    );
  }
}

type AuditTarget =
  | { readonly subject: "usage-events" }
  | {
      readonly subject:
        | "usage-webhook"
        | "usage-budget"
        | "usage-admission-hook"
        | "world-mode"
        | "world-offer";
      readonly entryId: string;
    };

const READ: AuditTarget = { subject: "usage-events" };

function access(
  input: { readonly scope: UsageQueryRequest["scope"] },
  decision: InspectorAccess["decision"],
  reasonCode: InspectorAccess["reasonCode"],
  target: AuditTarget = READ,
): InspectorAccess {
  const { worldId, timelineId, spaceId } = input.scope;
  return { ...target, worldId, timelineId, spaceId, decision, reasonCode };
}
