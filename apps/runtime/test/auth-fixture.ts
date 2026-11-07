import type {
  AuthProviderPort,
  PrincipalMappingPort,
  WorkspaceAuthorization,
  WorldAuthorization,
} from "@clockgrove/application";
import { decodeOpaqueId, type GrantRef } from "@clockgrove/contracts";

import {
  DeterministicTestAuthProvider,
  LOCAL_TEST_PRINCIPALS,
  type LocalTestRole,
  type TestSessionEvent,
} from "../local/test-auth.js";
import { TrustedRuntimeRequestAuthenticator } from "../src/trusted-composition.js";
import { trustedTestContext } from "./trusted-context.js";

export function authenticationFixture(
  override?: {
    provider: AuthProviderPort;
    mapping: PrincipalMappingPort;
  },
  role?: LocalTestRole,
) {
  const context = trustedTestContext();
  const provider = new DeterministicTestAuthProvider(() => 100);
  const identity = { provider: "test-auth", environment: "local", subject: "external-subject" };
  if (role === undefined)
    provider.linkAccount(
      identity,
      decodeOpaqueId("identity-runtime", "ExternalIdentityId"),
      context.principalId,
    );
  const event: TestSessionEvent =
    role === undefined
      ? {
          eventId: "event-session",
          revision: 1,
          credential: "valid",
          identity,
          expiresAt: 200,
          revoked: false,
        }
      : provider.createRoleSession(role, { revision: 1, expiresAt: 200 });
  if (role === undefined) provider.applyEvent(event);
  const principalId =
    role === undefined ? context.principalId : LOCAL_TEST_PRINCIPALS[role].principalId;
  const privacyCeiling: WorldAuthorization["privacyCeiling"] =
    role === undefined
      ? context.privacyCeiling
      : {
          version: 1,
          allowedCategories:
            role === "observer" ? ["public_scene"] : ["public_scene", "operator_evidence"],
        };
  let workspace: WorkspaceAuthorization | undefined = {
    principalId,
    tenantId: context.tenantId,
    membershipId: decodeOpaqueId("workspace-membership", "WorkspaceMembershipId"),
    roles: [],
    grants: [],
  };
  let world: WorldAuthorization | undefined = {
    principalId,
    tenantId: context.tenantId,
    worldId: context.worldId!,
    timelineId: context.timelineId!,
    spaceId: context.spaceId!,
    membershipId: decodeOpaqueId("world-membership", "WorldMembershipId"),
    personaId: decodeOpaqueId("world-persona", "WorldPersonaId"),
    roles: [],
    grants: (role === undefined
      ? ["runtime:no-op"]
      : role === "observer"
        ? ["runtime:world-observe"]
        : ["runtime:world-observe", "runtime:world-inspect"]
    ).map((grant) => decodeOpaqueId(grant, "GrantRef")),
    privacyCeiling,
  };
  let mapped = true;
  // Counts every world-authority resolution, the authority-decision step of a runtime request.
  let worldResolutions = 0;
  const authenticator = new TrustedRuntimeRequestAuthenticator({
    provider: override?.provider ?? provider,
    mapping: {
      resolvePrincipal: async (identity) =>
        mapped ? (override?.mapping ?? provider).resolvePrincipal(identity) : undefined,
    },
    workspace: { resolveWorkspace: async () => workspace },
    world: {
      resolveWorld: async () => {
        worldResolutions += 1;
        return world;
      },
    },
    codeVersion: "test",
    requestMetadata: () => ({ requestId: context.requestId, correlationId: context.correlationId }),
  });
  return {
    provider,
    event,
    authenticator,
    canonicalSnapshot: () => JSON.stringify({ workspace, world }),
    worldResolutions: () => worldResolutions,
    removeMapping: () => {
      mapped = false;
    },
    setWorldGrants: (grants: readonly GrantRef[]) => {
      if (world !== undefined) world = { ...world, grants };
    },
    removeWorkspace: () => {
      workspace = undefined;
    },
    removeWorld: () => {
      world = undefined;
    },
  };
}

export function authenticationRequest(
  overrides: Record<string, unknown> = {},
  credential = "valid",
): Request {
  return new Request("http://runtime.test/v1/runtime/no-op", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({
      tenantId: "tenant-runtime",
      worldId: "world-runtime",
      timelineId: "timeline-runtime",
      spaceId: "space-runtime",
      commandId: "command-runtime-no-op",
      actionId: "action-runtime-no-op",
      eventId: "event-runtime-no-op",
      authorityDecisionId: "authority-runtime-no-op",
      routingEpoch: "7",
      authorityEpoch: "7",
      expectedProjectionRevision: "0",
      issuedAt: "2026-10-01T00:00:00.000Z",
      ...overrides,
    }),
  });
}
