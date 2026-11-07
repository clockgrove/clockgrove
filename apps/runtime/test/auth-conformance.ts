import { AuthenticationRefusedError } from "@clockgrove/application";
import { describe, expect, it, vi } from "vitest";
import { RuntimeWorker } from "../src/worker.js";
import { type authenticationFixture, authenticationRequest } from "./auth-fixture.js";

export interface AuthConformanceFixture {
  readonly authority: ReturnType<typeof authenticationFixture>;
  readonly credential: string;
  readonly expire: () => Promise<void>;
  readonly revoke: () => Promise<void>;
  readonly linkAccount: () => Promise<string>;
  readonly repeatNotification: () => Promise<void>;
  readonly olderNotification: () => Promise<void>;
  readonly driftOrganization: () => Promise<void>;
  readonly isolateEnvironment: () => Promise<void>;
  readonly outage: () => void;
}

/** All provider implementations exercise these same assertions with their own real storage. */
export function authenticationConformance(
  name: string,
  create: () => Promise<AuthConformanceFixture>,
): void {
  describe(`${name} shared authentication conformance`, () => {
    it("verifies a session and returns only an opaque Management-owned identity", async () => {
      const f = await create();
      const context = await f.authority.authenticator.authenticate(
        authenticationRequest({}, f.credential),
      );
      expect(context.principalId).toBe("principal-runtime");
      expect(context.externalIdentityId).toBe("identity-runtime");
      expect(context.personaId).toBe("world-persona");
      expect(context.grants).toEqual(["runtime:no-op"]);
      expect(context).not.toHaveProperty("subject");
      expect(context).not.toHaveProperty("user");
    });
    it("refuses invalid credentials", async () => {
      const f = await create();
      await expect(
        f.authority.authenticator.authenticate(authenticationRequest({}, "invalid")),
      ).rejects.toBeInstanceOf(AuthenticationRefusedError);
    });
    it("refuses expiry at the expiry boundary", async () => {
      const f = await create();
      await f.expire();
      await expect(
        f.authority.authenticator.authenticate(authenticationRequest({}, f.credential)),
      ).rejects.toBeInstanceOf(AuthenticationRefusedError);
    });
    it("checks revocation after a previously successful authentication", async () => {
      const f = await create();
      await f.authority.authenticator.authenticate(authenticationRequest({}, f.credential));
      await f.revoke();
      await expect(
        f.authority.authenticator.authenticate(authenticationRequest({}, f.credential)),
      ).rejects.toBeInstanceOf(AuthenticationRefusedError);
    });
    it("linked provider accounts retain the canonical principal", async () => {
      const f = await create();
      const credential = await f.linkAccount();
      const context = await f.authority.authenticator.authenticate(
        authenticationRequest({}, credential),
      );
      expect(context.principalId).toBe("principal-runtime");
      expect(context.worldMembershipId).toBe("world-membership");
    });
    it("duplicate provider notifications do not change canonical state", async () => {
      const f = await create();
      const before = f.authority.canonicalSnapshot();
      await f.repeatNotification();
      await f.repeatNotification();
      expect(
        (await f.authority.authenticator.authenticate(authenticationRequest({}, f.credential)))
          .externalIdentityId,
      ).toBe("identity-runtime");
      expect(f.authority.canonicalSnapshot()).toBe(before);
    });
    it("older provider notifications cannot revive a revoked session", async () => {
      const f = await create();
      const before = f.authority.canonicalSnapshot();
      await f.revoke();
      await f.olderNotification();
      await f.olderNotification();
      await expect(
        f.authority.authenticator.authenticate(authenticationRequest({}, f.credential)),
      ).rejects.toBeInstanceOf(AuthenticationRefusedError);
      expect(f.authority.canonicalSnapshot()).toBe(before);
    });
    it("isolates provider environments and refuses unmapped external subjects", async () => {
      const f = await create();
      await f.isolateEnvironment();
      await expect(
        f.authority.authenticator.authenticate(authenticationRequest({}, f.credential)),
      ).rejects.toBeInstanceOf(AuthenticationRefusedError);
    });
    it("isolates tenants even for a verified session", async () => {
      const f = await create();
      await expect(
        f.authority.authenticator.authenticate(
          authenticationRequest({ tenantId: "tenant-other" }, f.credential),
        ),
      ).rejects.toThrow("runtime scope or grant refused");
    });
    it("provider organization drift cannot grant membership or in-world authority", async () => {
      const f = await create();
      const before = f.authority.canonicalSnapshot();
      await f.driftOrganization();
      expect(
        (await f.authority.authenticator.authenticate(authenticationRequest({}, f.credential)))
          .roles,
      ).toEqual([]);
      expect(f.authority.canonicalSnapshot()).toBe(before);
      f.authority.removeWorld();
      await expect(
        f.authority.authenticator.authenticate(authenticationRequest({}, f.credential)),
      ).rejects.toThrow("runtime scope or grant refused");
    });
    it("outage refuses new authentication without routing or modifying canonical state", async () => {
      const f = await create();
      await f.authority.authenticator.authenticate(authenticationRequest({}, f.credential));
      const before = f.authority.canonicalSnapshot();
      const getSpace = vi.fn(() => {
        throw new Error("must not route");
      });
      f.outage();
      const response = await new RuntimeWorker(f.authority.authenticator, { getSpace }).fetch(
        authenticationRequest({}, f.credential),
      );
      expect(response.status).toBe(401);
      expect(getSpace).not.toHaveBeenCalled();
      expect(f.authority.canonicalSnapshot()).toBe(before);
    });
  });
}
