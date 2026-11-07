import type {
  AuthorityDecisionInputs,
  ExecutionContext,
  ExternalIdentityId,
  GrantRef,
  PrincipalId,
  PrivacyCeiling,
  RoleId,
  SpaceId,
  TenantId,
  TimelineId,
  WorkspaceMembershipId,
  WorldId,
  WorldMembershipId,
  WorldPersonaId,
} from "@clockgrove/contracts";

import { NO_PRIVACY_CEILING } from "./authority-decision.js";

/** A provider adapter verifies session mechanics and translates its subject to an opaque link ID. */
export interface VerifiedExternalIdentity {
  readonly externalIdentityId: ExternalIdentityId;
}

export interface AuthProviderPort {
  authenticate(credential: string): Promise<VerifiedExternalIdentity>;
}

/** Management authority. Resolving or linking identity never provisions a world. */
export interface PrincipalMappingPort {
  resolvePrincipal(identity: VerifiedExternalIdentity): Promise<PrincipalId | undefined>;
}

export interface RuntimeAuthorizationScope {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly spaceId: SpaceId;
}

export interface WorkspaceAuthorization {
  readonly principalId: PrincipalId;
  readonly tenantId: TenantId;
  readonly membershipId: WorkspaceMembershipId;
  readonly roles: readonly RoleId[];
  readonly grants: readonly GrantRef[];
}

/** Management-owned administrative membership; absent for visitors. Never inferred from provider claims. */
export interface WorkspaceAuthorizationPort {
  resolveWorkspace(
    principalId: PrincipalId,
    tenantId: TenantId,
  ): Promise<WorkspaceAuthorization | undefined>;
}

export interface WorldAuthorization extends RuntimeAuthorizationScope {
  readonly principalId: PrincipalId;
  readonly membershipId: WorldMembershipId;
  readonly personaId: WorldPersonaId;
  readonly roles: readonly RoleId[];
  readonly grants: readonly GrantRef[];
  readonly privacyCeiling: PrivacyCeiling;
}

/** Read-only runtime authority over already committed participation facts. */
export interface WorldAuthorizationPort {
  resolveWorld(
    principalId: PrincipalId,
    scope: RuntimeAuthorizationScope,
  ): Promise<WorldAuthorization | undefined>;
}

export class AuthenticationRefusedError extends Error {
  override readonly name = "AuthenticationRefusedError";
}

/** What a refused authorization resolved, recorded as a deny AuthorityDecision's inputs. */
export interface RuntimeAuthorizationDenial {
  readonly reasonCode: "world-participation-absent" | "runtime-grant-missing";
  readonly inputs: AuthorityDecisionInputs;
}

export class AuthorizationRefusedError extends Error {
  override readonly name = "AuthorizationRefusedError";

  /**
   * Present when the refusal rests on consistent authority facts for the requested scope, so it can
   * be recorded. Absent when an authority source contradicted the request; such refusals are not
   * recorded.
   */
  readonly denial?: RuntimeAuthorizationDenial;

  constructor(message: string, denial?: RuntimeAuthorizationDenial) {
    super(message);
    if (denial !== undefined) this.denial = denial;
  }
}

export type RuntimeAuthority = Pick<
  ExecutionContext,
  | "principalId"
  | "externalIdentityId"
  | "workspaceMembershipId"
  | "worldMembershipId"
  | "personaId"
  | "roles"
  | "grants"
  | "privacyCeiling"
>;

/** Authentication: maps a verified provider identity to its principal, or refuses. */
export async function resolveRuntimePrincipal(
  identity: VerifiedExternalIdentity,
  mapping: PrincipalMappingPort,
): Promise<PrincipalId> {
  const principalId = await mapping.resolvePrincipal(identity);
  if (principalId === undefined) throw new AuthenticationRefusedError("unmapped identity");
  return principalId;
}

/** Authorization of an authenticated principal for one runtime scope. */
export async function authorizeRuntimePrincipal(
  identity: VerifiedExternalIdentity,
  principalId: PrincipalId,
  scope: RuntimeAuthorizationScope,
  ports: {
    readonly workspace: WorkspaceAuthorizationPort;
    readonly world: WorldAuthorizationPort;
  },
  requiredGrant = "runtime:no-op",
): Promise<RuntimeAuthority> {
  const workspace = await ports.workspace.resolveWorkspace(principalId, scope.tenantId);
  const world = await ports.world.resolveWorld(principalId, scope);
  if (
    (workspace !== undefined &&
      (workspace.principalId !== principalId || workspace.tenantId !== scope.tenantId)) ||
    (world !== undefined &&
      (world.principalId !== principalId ||
        world.tenantId !== scope.tenantId ||
        world.worldId !== scope.worldId ||
        world.timelineId !== scope.timelineId ||
        world.spaceId !== scope.spaceId))
  )
    throw new AuthorizationRefusedError("runtime scope or grant refused");
  if (world === undefined)
    throw new AuthorizationRefusedError("runtime scope or grant refused", {
      reasonCode: "world-participation-absent",
      inputs: { principalId, roles: [], grants: [], privacyCeiling: NO_PRIVACY_CEILING },
    });
  if (!world.grants.some((grant) => grant === requiredGrant))
    throw new AuthorizationRefusedError("runtime scope or grant refused", {
      reasonCode: "runtime-grant-missing",
      inputs: {
        principalId,
        worldMembershipId: world.membershipId,
        personaId: world.personaId,
        roles: world.roles,
        grants: world.grants,
        privacyCeiling: world.privacyCeiling,
      },
    });
  return {
    principalId,
    externalIdentityId: identity.externalIdentityId,
    ...(workspace === undefined ? {} : { workspaceMembershipId: workspace.membershipId }),
    worldMembershipId: world.membershipId,
    personaId: world.personaId,
    // Administrative roles do not grant in-world capabilities.
    roles: world.roles,
    grants: world.grants,
    privacyCeiling: world.privacyCeiling,
  };
}

export async function resolveRuntimeAuthorization(
  identity: VerifiedExternalIdentity,
  scope: RuntimeAuthorizationScope,
  ports: {
    readonly mapping: PrincipalMappingPort;
    readonly workspace: WorkspaceAuthorizationPort;
    readonly world: WorldAuthorizationPort;
  },
): Promise<RuntimeAuthority> {
  const principalId = await resolveRuntimePrincipal(identity, ports.mapping);
  return authorizeRuntimePrincipal(identity, principalId, scope, ports);
}
