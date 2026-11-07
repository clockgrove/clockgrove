import { decodeOpaqueId } from "@clockgrove/contracts";
import { describe, expect, it, vi } from "vitest";

import { RuntimeWorker } from "../src/worker.js";
import { authenticationFixture, authenticationRequest } from "./auth-fixture.js";

// Session and identity conformance is shared in auth-conformance.ts; these are the canonical
// authorization regressions it does not cover.
describe("canonical authorization regressions", () => {
  it("refuses rebinding an explicitly linked account to another principal", () => {
    const fixture = authenticationFixture();
    const identity = { ...fixture.event.identity, provider: "other-provider" };
    const link = (principal: string) =>
      fixture.provider.linkAccount(
        identity,
        decodeOpaqueId("identity-other", "ExternalIdentityId"),
        decodeOpaqueId(principal, "PrincipalId"),
      );
    link("principal-runtime");
    expect(() => link("attacker")).toThrow();
  });
  it("checks world participation revocation on each request", async () => {
    const fixture = authenticationFixture();
    await fixture.authenticator.authenticate(authenticationRequest());
    fixture.removeWorld();
    await expect(fixture.authenticator.authenticate(authenticationRequest())).rejects.toThrow();
  });
  it("fails closed without authentication and never routes or trusts caller claims", async () => {
    const fixture = authenticationFixture();
    const getSpace = vi.fn(() => {
      throw new Error("must not route");
    });
    const worker = new RuntimeWorker(fixture.authenticator, { getSpace });
    const request = authenticationRequest();
    request.headers.delete("authorization");
    expect((await worker.fetch(request)).status).toBe(401);
    expect(
      (await worker.fetch(authenticationRequest({ roles: ["admin"], grants: ["all"] }))).status,
    ).toBe(400);
    expect(getSpace).not.toHaveBeenCalled();
  });
});
