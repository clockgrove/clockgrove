import {
  AuthorizationRefusedError,
  NO_PRIVACY_CEILING,
  type RuntimeAuthorizationDenial,
} from "@clockgrove/application";
import type {
  PrincipalId,
  UsagePage,
  UsageQueryRequest,
  UsageWebhookRegistration,
  UsageWebhookRequest,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import {
  type InspectorAccess,
  type PostgreSqlClient,
  PostgreSqlInspectorAudit,
  PostgreSqlUsageReader,
  PostgreSqlUsageWebhooks,
} from "@clockgrove/persistence";
import { INSPECT_GRANT } from "./inspector.js";
import { usageWebhookSecret } from "./usage-webhooks.js";
import { assertWorldCommandContext, worldAuthorization } from "./world-commands.js";

/** The usage query's and webhook registration's routes (`docs/protocols/usage.md`). */
export const USAGE_ROUTES = ["/v1/runtime/usage/query", "/v1/runtime/usage/webhook"] as const;

/**
 * Usage events for inspectors (issue 329): the run inspector's `runtime:world-inspect` grant and
 * `operator_evidence` ceiling, rate limit and audit, with subject `usage-events`.
 */
export class PostgreSqlUsageInspector {
  private readonly audit: PostgreSqlInspectorAudit;
  private readonly reader: PostgreSqlUsageReader;
  private readonly webhooks: PostgreSqlUsageWebhooks;
  constructor(client: PostgreSqlClient) {
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
   * signing secret, derived from the deployment secret and the webhook's ID.
   */
  register(
    input: UsageWebhookRequest,
    context: TrustedExecutionContext,
    deploymentSecret: string,
  ): Promise<UsageWebhookRegistration> {
    // Audited as a registration, naming where the export now goes; a refusal is a usage access.
    const target: AuditTarget = {
      subject: "usage-webhook",
      entryId: input.url === null ? "disabled" : new URL(input.url).origin,
    };
    return this.audited(input, target, context, async (authorization) => {
      const webhookId = await this.webhooks.register(authorization, input.scope, input.url);
      return {
        webhookId,
        url: input.url,
        signingSecret:
          input.url === null ? null : await usageWebhookSecret(deploymentSecret, webhookId),
      };
    });
  }

  private async audited<T>(
    input: { readonly scope: UsageQueryRequest["scope"] },
    target: AuditTarget,
    context: TrustedExecutionContext,
    operation: (authorization: ReturnType<typeof worldAuthorization>) => Promise<T>,
  ): Promise<T> {
    try {
      assertWorldCommandContext(context, input.scope, INSPECT_GRANT);
      if (!context.privacyCeiling.allowedCategories.includes("operator_evidence"))
        throw new AuthorizationRefusedError("inspection ceiling refused");
    } catch (error) {
      await this.deny(input, context.principalId, undefined);
      throw error;
    }
    const authorization = worldAuthorization(context);
    await this.audit.admit(authorization);
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
  | { readonly subject: "usage-webhook"; readonly entryId: string };

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
