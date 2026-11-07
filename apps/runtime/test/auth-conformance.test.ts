import { decodeOpaqueId } from "@clockgrove/contracts";
import { type AuthConformanceFixture, authenticationConformance } from "./auth-conformance.js";
import { authenticationFixture } from "./auth-fixture.js";
import { betterAuthFixture } from "./better-auth-fixture.js";

async function deterministicFixture(): Promise<AuthConformanceFixture> {
  const authority = authenticationFixture();
  const { provider, event } = authority;
  return {
    authority,
    credential: event.credential,
    expire: async () => {
      provider.applyEvent({ ...event, eventId: "expired", revision: 2, expiresAt: 100 });
    },
    revoke: async () => {
      provider.applyEvent({ ...event, eventId: "revoked", revision: 3, revoked: true });
    },
    linkAccount: async () => {
      const identity = { ...event.identity, provider: "linked-provider" };
      provider.linkAccount(
        identity,
        decodeOpaqueId("identity-linked", "ExternalIdentityId"),
        decodeOpaqueId("principal-runtime", "PrincipalId"),
      );
      provider.applyEvent({ ...event, eventId: "linked", credential: "linked", identity });
      return "linked";
    },
    repeatNotification: async () => {
      provider.applyEvent(event);
    },
    olderNotification: async () => {
      provider.applyEvent({ ...event, eventId: "older", revision: 2 });
    },
    driftOrganization: async () => {
      provider.applyEvent({
        ...event,
        eventId: "organization",
        revision: 2,
        organization: "admin",
      });
    },
    isolateEnvironment: async () => {
      provider.applyEvent({
        ...event,
        eventId: "environment",
        revision: 2,
        identity: { ...event.identity, environment: "production" },
      });
    },
    outage: () => {
      provider.available = false;
    },
  };
}

authenticationConformance("deterministic adapter", deterministicFixture);
authenticationConformance("Better Auth reference adapter", betterAuthFixture);
