import type {
  AuthProviderPort,
  PrincipalMappingPort,
  WorldAuthorization,
  WorldAuthorizationPort,
} from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import { PostgreSqlManagementReaders } from "@clockgrove/persistence";
import { DeterministicTestAuthProvider } from "../local/test-auth.js";
import { composeReferenceAuthentication } from "../src/better-auth-adapter.js";
import { TrustedRuntimeRequestAuthenticator } from "../src/trusted-composition.js";
import { connectionString, type ProvisionedPartition, withClient } from "./world-fixture.js";

/** The observation journeys' trusted authenticator over a provider's sessions. */
export function observationAuthenticator(
  provider: DeterministicTestAuthProvider,
  world: WorldAuthorizationPort,
): TrustedRuntimeRequestAuthenticator;
export function observationAuthenticator(
  provider: AuthProviderPort,
  world: WorldAuthorizationPort,
  mapping: PrincipalMappingPort,
): TrustedRuntimeRequestAuthenticator;
export function observationAuthenticator(
  provider: AuthProviderPort,
  world: WorldAuthorizationPort,
  mapping: PrincipalMappingPort = provider as DeterministicTestAuthProvider,
) {
  return new TrustedRuntimeRequestAuthenticator({
    provider,
    mapping,
    workspace: { resolveWorkspace: async () => undefined },
    world,
    codeVersion: "living-hall-journey",
    requestMetadata: () => ({
      requestId: "request-hall-read",
      correlationId: decodeOpaqueId("correlation-hall-read", "CorrelationId"),
    }),
  });
}

/**
 * The product's session store: Better Auth verifies a credential against `clockgrove_auth.session`
 * and Management's identity links map it to a principal, as the runtime composes them.
 */
export function sessionStoreAuthentication(environment: Readonly<Record<string, string>>) {
  const management = <T>(operation: (reader: PostgreSqlManagementReaders) => Promise<T>) =>
    withClient(
      environment,
      (client) => operation(new PostgreSqlManagementReaders(client, "local")),
      "clockgrove",
      "clockgrove_management_reader",
    );
  return {
    provider: composeReferenceAuthentication("local-reader-verification".repeat(2), {
      baseURL: "https://auth.example.test",
      environment: "local",
      connectionString: connectionString(environment, "clockgrove", "clockgrove_auth_verifier"),
      resolveIdentity: (provider, subject) =>
        management((reader) => reader.resolveIdentity(provider, subject)),
    }),
    mapping: {
      resolvePrincipal: (identity) => management((reader) => reader.resolvePrincipal(identity)),
    } satisfies PrincipalMappingPort,
  };
}

/** Observation-only authority for the real provisioned pack, independent of command authority. */
export function livingHallAuthentication(
  provisioned: ProvisionedPartition,
  /** Further authority spaces of the same world this observer may also observe. */
  extraSpaces: readonly string[] = [],
) {
  const { authorization, partition } = provisioned;
  const scope = { ...partition.target, spaceId: partition.route.spaceId };
  const provider = new DeterministicTestAuthProvider(() => 100);
  const identity = { provider: "test-auth", environment: "local", subject: "hall-observer" };
  provider.linkAccount(
    identity,
    decodeOpaqueId("identity-hall", "ExternalIdentityId"),
    authorization.principalId,
  );
  provider.applyEvent({
    eventId: "hall-session",
    revision: 1,
    credential: "hall-inspect",
    identity,
    expiresAt: 200,
    revoked: false,
  });
  let world: WorldAuthorization = {
    ...scope,
    principalId: authorization.principalId,
    membershipId: decodeOpaqueId("membership-hall", "WorldMembershipId"),
    personaId: decodeOpaqueId("persona-hall", "WorldPersonaId"),
    roles: [],
    grants: [decodeOpaqueId("runtime:world-observe", "GrantRef")],
    privacyCeiling: decodePrivacyCeiling({
      version: 1,
      allowedCategories: ["public_scene", "operator_evidence", "private_cognition"],
    }),
  };
  // A second observer, without relationship-private access, whose session also opens scene sockets.
  const stranger = { provider: "test-auth", environment: "local", subject: "hall-stranger" };
  const strangerId = decodeOpaqueId("principal-outsider", "PrincipalId");
  provider.linkAccount(
    stranger,
    decodeOpaqueId("identity-hall-stranger", "ExternalIdentityId"),
    strangerId,
  );
  provider.applyEvent({
    eventId: "hall-stranger-session",
    revision: 1,
    credential: "outsider-session-token",
    identity: stranger,
    expiresAt: 200,
    revoked: false,
  });
  const strangerWorld: WorldAuthorization = {
    ...world,
    principalId: strangerId,
    membershipId: decodeOpaqueId("membership-hall-stranger", "WorldMembershipId"),
    personaId: decodeOpaqueId("persona-hall-stranger", "WorldPersonaId"),
    privacyCeiling: decodePrivacyCeiling({ version: 1, allowedCategories: ["public_scene"] }),
  };
  const worlds: WorldAuthorizationPort = {
    resolveWorld: async (principalId, requested) =>
      principalId === strangerId
        ? strangerWorld
        : extraSpaces.includes(requested.spaceId)
          ? { ...world, spaceId: requested.spaceId }
          : world,
  };
  return {
    scope,
    revoke: () => {
      world = { ...world, grants: [] };
    },
    /** Adds `grant` to the observer's membership. */
    grant: (grant: string) => {
      world = { ...world, grants: [...world.grants, decodeOpaqueId(grant, "GrantRef")] };
    },
    /** The observe grant under a privacy ceiling without the public scene. */
    withoutPublicScene: () => {
      world = {
        ...world,
        grants: [decodeOpaqueId("runtime:world-observe", "GrantRef")],
        privacyCeiling: decodePrivacyCeiling({
          version: 1,
          allowedCategories: ["operator_evidence"],
        }),
      };
    },
    authenticator: observationAuthenticator(provider, worlds),
    /** The same world authority over credentials the product's session store verifies. */
    sessionStoreAuthenticator: (environment: Readonly<Record<string, string>>) => {
      const store = sessionStoreAuthentication(environment);
      return observationAuthenticator(store.provider, worlds, store.mapping);
    },
  };
}
