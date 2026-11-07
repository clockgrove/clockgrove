import { decodeOpaqueId } from "@clockgrove/contracts";
import { betterAuth } from "better-auth";
import { type MemoryDB, memoryAdapter } from "better-auth/adapters/memory";
import { organization } from "better-auth/plugins/organization";
import { BetterAuthProvider, referenceSessionOptions } from "../src/better-auth-adapter.js";
import type { AuthConformanceFixture } from "./auth-conformance.js";
import { authenticationFixture } from "./auth-fixture.js";

/** Real Better Auth API and memory storage; no SDK/session mock and no network. */
export async function betterAuthFixture(): Promise<AuthConformanceFixture> {
  const fixtureSecret = "conformance".repeat(4);
  const fixturePassword = "conformance".repeat(3);
  const storage: MemoryDB = {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  let available = true;
  let mappedEnvironment = "local";
  const database = memoryAdapter(storage);
  const options = {
    ...referenceSessionOptions(fixtureSecret, "http://auth.test"),
    plugins: [...referenceSessionOptions("", "").plugins, organization()],
    emailAndPassword: { enabled: true },
    database: (config: Parameters<typeof database>[0]) => {
      const adapter = database(config);
      return new Proxy(adapter, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (!available) throw new Error("local provider storage unavailable");
            return Reflect.apply(value, target, args);
          };
        },
      });
    },
  };
  const auth = betterAuth(options);
  const signedUp = await auth.api.signUpEmail({
    body: { name: "Conformance", email: "user@example.test", password: fixturePassword },
  });
  const credential = signedUp.token!;
  const subject = signedUp.user.id;
  const internal = (await auth.$context).internalAdapter;
  const externalIdentityId = decodeOpaqueId("identity-runtime", "ExternalIdentityId");
  const principalId = decodeOpaqueId("principal-runtime", "PrincipalId");
  const provider = new BetterAuthProvider(auth, "local", async (environment, id) =>
    environment === mappedEnvironment && id === subject ? externalIdentityId : undefined,
  );
  const authority = authenticationFixture({
    provider,
    mapping: {
      resolvePrincipal: async (identity) =>
        identity.externalIdentityId === externalIdentityId ? principalId : undefined,
    },
  });
  return {
    authority,
    credential,
    expire: async () => {
      await (await auth.$context).adapter.update({
        model: "session",
        where: [{ field: "token", value: credential }],
        update: { expiresAt: new Date(Date.now()) },
      });
    },
    revoke: async () => {
      await auth.api.signOut({ headers: new Headers({ authorization: `Bearer ${credential}` }) });
      if ((await internal.findSession(credential)) !== null)
        throw new Error("session was not revoked in storage");
    },
    linkAccount: async () => {
      await internal.linkAccount({
        userId: subject,
        providerId: "conformance-oauth",
        accountId: "linked-provider-account",
      });
      if ((await internal.findAccounts(subject)).length !== 2)
        throw new Error("account was not linked in storage");
      return (await internal.createSession(subject)).token;
    },
    // Better Auth has no external session-event ingestion. Notifications are reads,
    // never writes over its authoritative session store; old hints cannot restore rows.
    repeatNotification: async () => {
      await internal.findSession(credential);
    },
    olderNotification: async () => {
      await internal.findSession(credential);
    },
    driftOrganization: async () => {
      const org = await auth.api.createOrganization({
        headers: new Headers({ authorization: `Bearer ${credential}` }),
        body: { name: "Provider organization", slug: "provider-org" },
      });
      await auth.api.setActiveOrganization({
        headers: new Headers({ authorization: `Bearer ${credential}` }),
        body: { organizationId: org!.id },
      });
    },
    isolateEnvironment: async () => {
      mappedEnvironment = "production";
    },
    outage: () => {
      available = false;
    },
  };
}
