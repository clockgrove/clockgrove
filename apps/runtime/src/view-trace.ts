import {
  AuthorizationRefusedError,
  JournalRouteNotFoundError,
  NO_PRIVACY_CEILING,
  type RuntimeAuthorizationDenial,
} from "@clockgrove/application";
import {
  CLIENT_VIEW_EVIDENCE,
  CLIENT_VIEW_VIEWERS,
  type ClientViewTrace,
  type ClientViewTraceRequest,
  type PrincipalId,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import {
  type InspectorAccess,
  type PostgreSqlClient,
  PostgreSqlInspectorAudit,
  PostgreSqlWorldOwnerReader,
} from "@clockgrove/persistence";
import { OBSERVE_GRANT } from "./inspector.js";
import { PostgreSqlLivingSceneReader } from "./observation.js";
import { decideSceneAudience, sceneAuthorityFacts } from "./scene-audience.js";
import type { RuntimeScope } from "./types.js";
import { assertWorldCommandContext, worldAuthorization } from "./world-commands.js";

/** The request's audit scope; a client view names no command or entry (0033). */
export interface ClientViewInput {
  readonly scope: RuntimeScope;
  readonly request: ClientViewTraceRequest;
}

/**
 * The viewer's own client view traced: under `runtime:world-observe` and a `public_scene`
 * ceiling in the requested scope, the server decides the audience of the caller's requested interest
 * against the current canonical state with issue 810's `decideSceneAudience`, from the caller's own grants
 * and ceiling, and returns the decision with its resolver reasons and the revision it projects. It is
 * audited in `inspector_accesses` with subject `client-view`, under the inspector rate limit.
 */
export class PostgreSqlClientViewInspector {
  private readonly audit: PostgreSqlInspectorAudit;
  constructor(private readonly client: PostgreSqlClient) {
    this.audit = new PostgreSqlInspectorAudit(client);
  }

  async inspect(
    input: ClientViewInput,
    context: TrustedExecutionContext,
  ): Promise<ClientViewTrace> {
    try {
      assertWorldCommandContext(context, input.scope, OBSERVE_GRANT);
      if (!context.privacyCeiling.allowedCategories.includes("public_scene"))
        throw new AuthorizationRefusedError("public scene refused");
    } catch (error) {
      await this.deny(input, context.principalId, undefined);
      throw error;
    }
    const authorization = worldAuthorization(context);
    await this.audit.admit(authorization);
    let reasonCode: InspectorAccess["reasonCode"] = "failed";
    try {
      const { stored } = await new PostgreSqlLivingSceneReader(
        new PostgreSqlWorldOwnerReader(this.client),
      ).hydrateObserved(input.scope, context);
      const { state } = stored.document;
      const decision = decideSceneAudience(
        state,
        { ...input.scope, privacyClass: "public_scene", interest: input.request.interest },
        sceneAuthorityFacts(context.grants, context.privacyCeiling),
      );
      reasonCode = "served";
      return {
        version: 1,
        ...input.scope,
        privacyClass: "public_scene",
        evidence: CLIENT_VIEW_EVIDENCE,
        requested: input.request.interest,
        audience: {
          privacyCategories: decision.descriptor.privacyCategories,
          interest: decision.descriptor.interest,
          hash: decision.hash,
          reasons: decision.reasons.flatMap((reason) => {
            const viewer = CLIENT_VIEW_VIEWERS.find(
              (name) => reason.observerId === `viewer:${name}`,
            );
            return viewer === undefined
              ? []
              : [
                  {
                    viewer,
                    outcome: reason.outcome,
                    code: reason.code,
                    detailLevel: reason.detailLevel,
                  },
                ];
          }),
        },
        projection: {
          revision: state.revision.toString(),
          simulationTime: state.simulationTime.toString(),
        },
      };
    } catch (error) {
      if (error instanceof JournalRouteNotFoundError) reasonCode = "not-found";
      throw error;
    } finally {
      await this.audit.record(authorization, access(input, "allow", reasonCode));
    }
  }

  deny(
    input: ClientViewInput,
    principalId: PrincipalId,
    denial: RuntimeAuthorizationDenial | undefined,
  ): Promise<void> {
    return this.audit.record(
      { tenantId: input.scope.tenantId, principalId, privacyCeiling: NO_PRIVACY_CEILING },
      access(input, "deny", denial?.reasonCode ?? "authority-mismatch"),
    );
  }
}

function access(
  input: ClientViewInput,
  decision: InspectorAccess["decision"],
  reasonCode: InspectorAccess["reasonCode"],
): InspectorAccess {
  const { worldId, timelineId, spaceId } = input.scope;
  return { subject: "client-view", worldId, timelineId, spaceId, decision, reasonCode };
}
