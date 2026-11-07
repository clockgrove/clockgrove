import type {
  PrincipalMappingPort,
  WorldAuthorization,
  WorldAuthorizationPort,
} from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import { DeterministicTestAuthProvider } from "../local/test-auth.js";
import { TrustedRuntimeRequestAuthenticator } from "../src/trusted-composition.js";
import type { ProvisionedPartition } from "./world-fixture.js";

/** The observation journeys' trusted authenticator over a deterministic provider's sessions. */
export function observationAuthenticator(
  provider: DeterministicTestAuthProvider,
  world: WorldAuthorizationPort,
  mapping: PrincipalMappingPort = provider,
) {
  return new TrustedRuntimeRequestAuthenticator({
    provider,
    mapping,
    workspace: { resolveWorkspace: async () => undefined },
    world,
    codeVersion: "living-yard-journey",
    requestMetadata: () => ({
      requestId: "request-yard-read",
      correlationId: decodeOpaqueId("correlation-yard-read", "CorrelationId"),
    }),
  });
}

/** Observation-only authority for the real provisioned pack, independent of command authority. */
export function livingYardAuthentication(
  provisioned: ProvisionedPartition,
  /** Further authority spaces of the same world this observer may also observe. */
  extraSpaces: readonly string[] = [],
) {
  const { authorization, partition } = provisioned;
  const scope = { ...partition.target, spaceId: partition.route.spaceId };
  const provider = new DeterministicTestAuthProvider(() => 100);
  const identity = { provider: "test-auth", environment: "local", subject: "yard-observer" };
  provider.linkAccount(
    identity,
    decodeOpaqueId("identity-yard", "ExternalIdentityId"),
    authorization.principalId,
  );
  provider.applyEvent({
    eventId: "yard-session",
    revision: 1,
    credential: "yard-inspect",
    identity,
    expiresAt: 200,
    revoked: false,
  });
  let world: WorldAuthorization = {
    ...scope,
    principalId: authorization.principalId,
    membershipId: decodeOpaqueId("membership-yard", "WorldMembershipId"),
    personaId: decodeOpaqueId("persona-yard", "WorldPersonaId"),
    roles: [],
    grants: [decodeOpaqueId("runtime:world-observe", "GrantRef")],
    privacyCeiling: decodePrivacyCeiling({
      version: 1,
      allowedCategories: ["public_scene", "operator_evidence", "private_cognition"],
    }),
  };
  // A second observer, without relationship-private access, whose session also opens scene sockets.
  const stranger = { provider: "test-auth", environment: "local", subject: "yard-stranger" };
  const strangerId = decodeOpaqueId("principal-outsider", "PrincipalId");
  provider.linkAccount(
    stranger,
    decodeOpaqueId("identity-yard-stranger", "ExternalIdentityId"),
    strangerId,
  );
  provider.applyEvent({
    eventId: "yard-stranger-session",
    revision: 1,
    credential: "outsider-session-token",
    identity: stranger,
    expiresAt: 200,
    revoked: false,
  });
  const strangerWorld: WorldAuthorization = {
    ...world,
    principalId: strangerId,
    membershipId: decodeOpaqueId("membership-yard-stranger", "WorldMembershipId"),
    personaId: decodeOpaqueId("persona-yard-stranger", "WorldPersonaId"),
    privacyCeiling: decodePrivacyCeiling({ version: 1, allowedCategories: ["public_scene"] }),
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
    authenticator: observationAuthenticator(provider, {
      resolveWorld: async (principalId, requested) =>
        principalId === strangerId
          ? strangerWorld
          : extraSpaces.includes(requested.spaceId)
            ? { ...world, spaceId: requested.spaceId }
            : world,
    }),
  };
}
