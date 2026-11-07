import { AuthenticationRefusedError, AuthorizationRefusedError } from "@clockgrove/application";
import { expect, it } from "vitest";

import { authenticationFixture, authenticationRequest } from "./auth-fixture.js";

it("resolves explicit local roles with independent scoped observation and inspection authority", async () => {
  for (const expected of [
    {
      role: "observer",
      credential: "local-observer",
      principalId: "principal-observer",
      externalIdentityId: "identity-observer",
      grants: ["runtime:world-observe"],
      categories: ["public_scene"],
      otherRole: "operator",
      otherCredential: "local-operator",
      otherIdentityId: "identity-operator",
      otherPrincipalId: "principal-operator",
    },
    {
      role: "operator",
      credential: "local-operator",
      principalId: "principal-operator",
      externalIdentityId: "identity-operator",
      grants: ["runtime:world-observe", "runtime:world-inspect"],
      categories: ["public_scene", "operator_evidence"],
      otherRole: "observer",
      otherCredential: "local-observer",
      otherIdentityId: "identity-observer",
      otherPrincipalId: "principal-observer",
    },
  ] as const) {
    const fixture = authenticationFixture(undefined, expected.role);
    expect(fixture.event).toEqual({
      eventId: `event-session-${expected.role}`,
      revision: 1,
      credential: expected.credential,
      expiresAt: 200,
      revoked: false,
      identity: { provider: "test-auth", environment: "local", subject: expected.role },
    });
    const identified = await fixture.authenticator.identify(
      authenticationRequest({}, expected.credential),
    );
    expect(identified.identity).toEqual({ externalIdentityId: expected.externalIdentityId });
    expect(identified.principalId).toBe(expected.principalId);
    const context = await fixture.authenticator.authorize(
      identified,
      undefined,
      "runtime:world-observe",
    );
    expect(context).toEqual({
      version: 1,
      principalId: expected.principalId,
      externalIdentityId: expected.externalIdentityId,
      tenantId: "tenant-runtime",
      worldId: "world-runtime",
      timelineId: "timeline-runtime",
      spaceId: "space-runtime",
      workspaceMembershipId: "workspace-membership",
      worldMembershipId: "world-membership",
      personaId: "world-persona",
      roles: [],
      grants: expected.grants,
      privacyCeiling: { version: 1, allowedCategories: expected.categories },
      requestId: "request-runtime",
      correlationId: "correlation-runtime",
      codeVersion: "test",
      protocolVersion: 1,
    });
    const repeated = authenticationFixture(undefined, expected.role);
    expect(
      await repeated.authenticator.authorize(
        await repeated.authenticator.identify(authenticationRequest({}, expected.credential)),
        undefined,
        "runtime:world-observe",
      ),
    ).toEqual(context);
    if (expected.role === "operator") {
      expect(
        await fixture.authenticator.authorize(identified, undefined, "runtime:world-inspect"),
      ).toEqual(context);
    }
    for (const grant of [
      "runtime:world-operate",
      "runtime:world-command",
      "runtime:world-clock",
      "runtime:no-op",
      ...(expected.role === "observer" ? ["runtime:world-inspect"] : []),
    ]) {
      await expect(
        fixture.authenticator.authorize(identified, undefined, grant),
      ).rejects.toMatchObject({
        name: "AuthorizationRefusedError",
        denial: {
          reasonCode: "runtime-grant-missing",
          inputs: {
            principalId: expected.principalId,
            worldMembershipId: "world-membership",
            personaId: "world-persona",
            roles: [],
            grants: expected.grants,
            privacyCeiling: { version: 1, allowedCategories: expected.categories },
          },
        },
      });
    }
    for (const field of ["tenantId", "worldId", "timelineId", "spaceId"]) {
      const outside = await fixture.authenticator.identify(
        authenticationRequest({ [field]: "outside" }, expected.credential),
      );
      await expect(
        fixture.authenticator.authorize(outside, undefined, "runtime:world-observe"),
      ).rejects.toThrow(AuthorizationRefusedError);
    }
    await expect(fixture.provider.authenticate(expected.otherCredential)).rejects.toThrow(
      AuthenticationRefusedError,
    );
    fixture.provider.createRoleSession(expected.otherRole, { revision: 1, expiresAt: 200 });
    const other = await fixture.provider.authenticate(expected.otherCredential);
    expect(other).toEqual({ externalIdentityId: expected.otherIdentityId });
    expect(await fixture.provider.resolvePrincipal(other)).toBe(expected.otherPrincipalId);
    await expect(
      fixture.authenticator.authorize(
        await fixture.authenticator.identify(authenticationRequest({}, expected.otherCredential)),
        undefined,
        "runtime:world-observe",
      ),
    ).rejects.toThrow(AuthorizationRefusedError);
  }
});
