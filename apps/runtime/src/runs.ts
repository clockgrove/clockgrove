import {
  type ArtifactStore,
  AuthorizationRefusedError,
  NO_PRIVACY_CEILING,
  type RuntimeAuthorizationDenial,
} from "@clockgrove/application";
import type {
  PrincipalId,
  RunInspectRequest,
  RunSearch,
  RunSearchRequest,
  RunWalk,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import {
  type InspectorAccess,
  type PostgreSqlClient,
  PostgreSqlInspectorAudit,
  PostgreSqlRunReader,
} from "@clockgrove/persistence";
import { INSPECT_GRANT } from "./inspector.js";
import { assertWorldCommandContext, worldAuthorization } from "./world-commands.js";

/** The run inspector's routes (`docs/protocols/runs.md`). */
export const RUN_ROUTES = ["/v1/runtime/runs/inspect", "/v1/runtime/runs/search"] as const;

/** No run of the scope is reachable from the entry: an unknown and another world's are alike. */
export class RunNotFoundError extends Error {
  constructor() {
    super("run not found");
    this.name = "RunNotFoundError";
  }
}

/**
 * Run evidence for inspectors (Wave 5 §8): the causal inspector's `runtime:world-inspect` grant and
 * `operator_evidence` ceiling, rate limit and audit, with subject `agent-runs`. A walk shows a
 * protected payload's text only when the ceiling also holds `conversation`, the payloads' class;
 * metadata search never reads one.
 */
export class PostgreSqlRunInspector {
  private readonly audit: PostgreSqlInspectorAudit;
  private readonly reader: PostgreSqlRunReader;
  constructor(client: PostgreSqlClient, artifacts: ArtifactStore) {
    this.audit = new PostgreSqlInspectorAudit(client);
    this.reader = new PostgreSqlRunReader(client, artifacts);
  }

  walk(input: RunInspectRequest, context: TrustedExecutionContext): Promise<RunWalk> {
    return this.read(input, context, async (authorization) => {
      const runs = await this.reader.walk(authorization, input.scope, input.entry);
      if (runs.length === 0) throw new RunNotFoundError();
      return { entry: input.entry, runs };
    });
  }

  search(input: RunSearchRequest, context: TrustedExecutionContext): Promise<RunSearch> {
    return this.read(input, context, async (authorization) => ({
      runs: await this.reader.search(authorization, input),
    }));
  }

  /** Records a refused access under the requested tenant, whether or not the principal is a member. */
  deny(
    input: { readonly scope: RunInspectRequest["scope"] },
    principalId: PrincipalId,
    denial: RuntimeAuthorizationDenial | undefined,
  ): Promise<void> {
    return this.audit.record(
      { tenantId: input.scope.tenantId, principalId, privacyCeiling: NO_PRIVACY_CEILING },
      access(input, "deny", denial?.reasonCode ?? "authority-mismatch"),
    );
  }

  private async read<T>(
    input: { readonly scope: RunInspectRequest["scope"] },
    context: TrustedExecutionContext,
    run: (authorization: ReturnType<typeof worldAuthorization>) => Promise<T>,
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
      const output = await run(authorization);
      reasonCode = "served";
      return output;
    } catch (error) {
      if (error instanceof RunNotFoundError) reasonCode = "not-found";
      throw error;
    } finally {
      await this.audit.record(authorization, access(input, "allow", reasonCode));
    }
  }
}

function access(
  input: { readonly scope: RunInspectRequest["scope"] },
  decision: InspectorAccess["decision"],
  reasonCode: InspectorAccess["reasonCode"],
): InspectorAccess {
  const { worldId, timelineId, spaceId } = input.scope;
  return { subject: "agent-runs", worldId, timelineId, spaceId, decision, reasonCode };
}
