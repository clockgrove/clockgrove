import {
  AuthenticationRefusedError,
  type AuthProviderPort,
  authorizeRuntimePrincipal,
  type PrincipalMappingPort,
  type RuntimeAuthorizationScope,
  resolveRuntimePrincipal,
  type VerifiedExternalIdentity,
  type WorkspaceAuthorizationPort,
  type WorldAuthorizationPort,
} from "@clockgrove/application";
import { type CorrelationId, decodeOpaqueId, type PrincipalId } from "@clockgrove/contracts";
import {
  constructTrustedExecutionContext,
  type TrustedExecutionContext,
} from "@clockgrove/contracts/trusted";

import type { RuntimeRequestAuthenticator } from "./worker.js";

export interface RuntimeAuthenticationDependencies {
  readonly provider: AuthProviderPort;
  readonly mapping: PrincipalMappingPort;
  readonly workspace: WorkspaceAuthorizationPort;
  readonly world: WorldAuthorizationPort;
  readonly codeVersion: string;
  readonly requestMetadata: (commandId: string) => {
    readonly requestId: string;
    readonly correlationId: CorrelationId;
  };
}

/** An authenticated principal: a verified identity mapped to its principal, with no scope. */
export interface AuthenticatedRuntimePrincipal {
  readonly identity: VerifiedExternalIdentity;
  readonly principalId: PrincipalId;
  readonly correlationHeader: string | null;
}

/** An authenticated request: a verified identity mapped to its principal, before authorization. */
export interface IdentifiedRuntimeRequest extends AuthenticatedRuntimePrincipal {
  readonly scope: RuntimeAuthorizationScope;
  readonly commandId: unknown;
}

export interface RuntimeRequestMetadata {
  readonly requestId: string;
  readonly correlationId: CorrelationId;
}

/** Sole production composition step. No fallback identity or test credentials. */
export class TrustedRuntimeRequestAuthenticator implements RuntimeRequestAuthenticator {
  constructor(private readonly dependencies: RuntimeAuthenticationDependencies) {}

  async authenticate(request: Request): Promise<TrustedExecutionContext> {
    return this.authorize(await this.identify(request));
  }

  /**
   * Authentication only: the bearer session, verified by the provider and mapped to its principal.
   * Reads no request body and resolves no world authority; refuses with AuthenticationRefusedError.
   */
  async authenticatePrincipal(request: Request): Promise<AuthenticatedRuntimePrincipal> {
    return this.principalOf(request, await this.verifiedIdentity(request));
  }

  /**
   * Authentication with the request's scope: the steps of `authenticatePrincipal`, with the scope
   * decoded between verification and principal mapping. Never resolves world authority.
   */
  async identify(request: Request): Promise<IdentifiedRuntimeRequest> {
    const identity = await this.verifiedIdentity(request);
    const body: unknown = await request.clone().json();
    if (typeof body !== "object" || body === null)
      throw new AuthenticationRefusedError("scope required");
    const input = body as Record<string, unknown>;
    const scope = {
      tenantId: decodeOpaqueId(input.tenantId, "TenantId"),
      worldId: decodeOpaqueId(input.worldId, "WorldId"),
      timelineId: decodeOpaqueId(input.timelineId, "TimelineId"),
      spaceId: decodeOpaqueId(input.spaceId, "SpaceId"),
    };
    return { ...(await this.principalOf(request, identity)), scope, commandId: input.commandId };
  }

  private async verifiedIdentity(request: Request): Promise<VerifiedExternalIdentity> {
    const credential = request.headers.get("authorization");
    if (credential === null || !/^Bearer \S+$/u.test(credential)) {
      throw new AuthenticationRefusedError("session credential required");
    }
    return this.dependencies.provider.authenticate(credential.slice(7));
  }

  private async principalOf(
    request: Request,
    identity: VerifiedExternalIdentity,
  ): Promise<AuthenticatedRuntimePrincipal> {
    return {
      identity,
      principalId: await resolveRuntimePrincipal(identity, this.dependencies.mapping),
      correlationHeader: request.headers.get("x-correlation-id"),
    };
  }

  /** The request's trusted metadata. Call it once per request and reuse the result. */
  metadata(identified: IdentifiedRuntimeRequest): RuntimeRequestMetadata {
    const metadata = this.dependencies.requestMetadata(
      decodeOpaqueId(identified.commandId, "CommandId"),
    );
    return {
      requestId: metadata.requestId,
      correlationId:
        identified.correlationHeader === null
          ? metadata.correlationId
          : decodeOpaqueId(identified.correlationHeader, "CorrelationId"),
    };
  }

  /** Authorization: refuses with AuthorizationRefusedError, carrying its denial when recordable. */
  async authorize(
    identified: IdentifiedRuntimeRequest,
    metadata?: RuntimeRequestMetadata,
    requiredGrant = "runtime:no-op",
  ): Promise<TrustedExecutionContext> {
    const authority = await authorizeRuntimePrincipal(
      identified.identity,
      identified.principalId,
      identified.scope,
      this.dependencies,
      requiredGrant,
    );
    return constructTrustedExecutionContext({
      version: 1,
      ...identified.scope,
      ...authority,
      ...(metadata ?? this.metadata(identified)),
      codeVersion: this.dependencies.codeVersion,
      protocolVersion: 1,
    });
  }
}
