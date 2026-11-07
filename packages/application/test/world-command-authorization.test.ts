import { decodeOpaqueId } from "@clockgrove/contracts";
import { describe, expect, it } from "vitest";
import {
  authorizeRuntimePrincipal,
  NO_PRIVACY_CEILING,
  type WorldAuthorization,
  type WorldAuthorizationPort,
} from "../src/index.js";

const principalId = decodeOpaqueId("world-owner-principal", "PrincipalId");
const identity = {
  externalIdentityId: decodeOpaqueId("world-owner-identity", "ExternalIdentityId"),
};
const scope = {
  tenantId: decodeOpaqueId("world-owner-tenant", "TenantId"),
  worldId: decodeOpaqueId("world-owner-world", "WorldId"),
  timelineId: decodeOpaqueId("world-owner-timeline", "TimelineId"),
  spaceId: decodeOpaqueId("world-owner-space", "SpaceId"),
};
const workspace = {
  async resolveWorkspace() {
    return {
      principalId,
      tenantId: scope.tenantId,
      membershipId: decodeOpaqueId("admin-membership", "WorkspaceMembershipId"),
      roles: [decodeOpaqueId("administrator", "RoleId")],
      grants: [decodeOpaqueId("runtime:world-command", "GrantRef")],
    };
  },
};
const participant: WorldAuthorization = {
  ...scope,
  principalId,
  membershipId: decodeOpaqueId("committed-participant", "WorldMembershipId"),
  personaId: decodeOpaqueId("committed-persona", "WorldPersonaId"),
  roles: [],
  grants: [decodeOpaqueId("runtime:world-command", "GrantRef")],
  privacyCeiling: NO_PRIVACY_CEILING,
};

describe("physical world-command authorization", () => {
  it.each([
    {
      name: "administration without participation",
      membership: undefined,
      reason: "world-participation-absent",
    },
    {
      name: "participation without a grant",
      membership: { ...participant, grants: [] },
      reason: "runtime-grant-missing",
    },
    {
      name: "no-op grant only",
      membership: { ...participant, grants: [decodeOpaqueId("runtime:no-op", "GrantRef")] },
      reason: "runtime-grant-missing",
    },
  ])("refuses $name", async ({ membership, reason }) => {
    const world: WorldAuthorizationPort = {
      async resolveWorld() {
        return membership;
      },
    };
    await expect(
      authorizeRuntimePrincipal(
        identity,
        principalId,
        scope,
        { workspace, world },
        "runtime:world-command",
      ),
    ).rejects.toMatchObject({
      name: "AuthorizationRefusedError",
      denial: {
        reasonCode: reason,
        inputs: {
          principalId,
          roles: [],
          grants: membership?.grants ?? [],
          privacyCeiling: NO_PRIVACY_CEILING,
        },
      },
    });
  });
  it("accepts only committed participation's world-command authority", async () => {
    const world: WorldAuthorizationPort = {
      async resolveWorld() {
        return participant;
      },
    };
    await expect(
      authorizeRuntimePrincipal(
        identity,
        principalId,
        scope,
        { workspace, world },
        "runtime:world-command",
      ),
    ).resolves.toEqual({
      principalId,
      externalIdentityId: identity.externalIdentityId,
      workspaceMembershipId: "admin-membership",
      worldMembershipId: "committed-participant",
      personaId: "committed-persona",
      roles: [],
      grants: ["runtime:world-command"],
      privacyCeiling: NO_PRIVACY_CEILING,
    });
    await expect(
      authorizeRuntimePrincipal(identity, principalId, scope, { workspace, world }),
    ).rejects.toMatchObject({
      name: "AuthorizationRefusedError",
      denial: {
        reasonCode: "runtime-grant-missing",
        inputs: {
          principalId,
          worldMembershipId: "committed-participant",
          personaId: "committed-persona",
          roles: [],
          grants: ["runtime:world-command"],
          privacyCeiling: NO_PRIVACY_CEILING,
        },
      },
    });
  });
});
