import { describe, expect, it } from "vitest";
import { providerMessage, tofuDiagnostics } from "../../scripts/ci/deploy.mjs";

const diagnostic = (detail: string) =>
  JSON.stringify({
    type: "diagnostic",
    diagnostic: {
      severity: "error",
      summary: "Client Error",
      detail,
      address: "neon_project.world[0]",
    },
  });

describe("deploy diagnostics", () => {
  it("names the resource, the codes and the provider's message", () => {
    expect(
      tofuDiagnostics(
        diagnostic("Unable to create project, got error: status 400: not allowed on the free plan"),
      ),
    ).toBe(
      "Client Error at neon_project.world[0] (codes 400): status 400: not allowed on the free plan",
    );
  });

  it("never prints credential-shaped text from a detail", () => {
    const said = providerMessage(
      "got error: postgres://role:s3cretPassw0rdLongValue1234@host/db token=abcd password: hunter2 AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    );
    for (const secret of ["s3cret", "abcd", "hunter2", "AbCdEfGhIjKlMnOp"])
      expect(said).not.toContain(secret);
  });

  it("ignores everything but error diagnostics", () => {
    expect(tofuDiagnostics('{"type":"apply_start"}\nnot json')).toBe("");
  });
});
