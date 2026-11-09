import { expect, it } from "vitest";

import { ContractDecodeError, decodeExecutionContext, decodePrivacyCeiling } from "../src/index.js";
import { constructTrustedExecutionContext, narrowTrustedExecutionContext } from "../src/trusted.js";

const context = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  tenantId: "tenant-a",
  principalId: "principal-alex",
  externalIdentityId: "identity-42",
  worldMembershipId: "world-membership-a",
  personaId: "persona-caretaker",
  worldId: "world-a",
  timelineId: "timeline-main",
  roles: ["participant"],
  grants: ["world.observe"],
  privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
  correlationId: "correlation-request-1",
  requestId: "request-1",
  codeVersion: "git:abc123",
  protocolVersion: 1,
  ...overrides,
});

it("refuses raw provider identity, unknown fields and a persona without world membership", () => {
  expect(decodeExecutionContext(context())).toEqual(context());
  expect(() =>
    decodeExecutionContext(
      context({ externalIdentity: { provider: "test-auth", subject: "raw" } }),
    ),
  ).toThrow("unknown field");
  const { worldMembershipId: _membership, ...withoutMembership } = context();
  expect(() => decodeExecutionContext(withoutMembership)).toThrow("required by personaId");
});

it("refuses unknown and duplicate privacy categories", () => {
  expect(() => decodePrivacyCeiling({ version: 1, allowedCategories: ["public-world"] })).toThrow(
    "unknown privacy category",
  );
  expect(() =>
    decodePrivacyCeiling({ version: 1, allowedCategories: ["public_scene", "public_scene"] }),
  ).toThrow("duplicate category");
});

it("refuses every authority broadening and accepts a strict trusted-context narrowing", () => {
  const broad = {
    grants: ["world.observe", "world.act"],
    privacyCeiling: { version: 1, allowedCategories: ["public_scene", "conversation"] },
  };
  const source = constructTrustedExecutionContext(context(broad));
  const ceiling = ["public_scene", "conversation", "private_cognition"];
  for (const [change, message] of [
    [{ tenantId: "tenant-b" }, "executionContextNarrowing.tenantId: immutable field changed"],
    [
      { principalId: "principal-blair" },
      "executionContextNarrowing.principalId: immutable field changed",
    ],
    [{ worldId: "world-b" }, "executionContextNarrowing.worldId: cannot change or add scope"],
    [{ spaceId: "space-hall" }, "executionContextNarrowing.spaceId: cannot change or add scope"],
    [
      { roles: ["participant", "operator"] },
      "executionContextNarrowing.roles: cannot add authority",
    ],
    [
      { grants: ["world.observe", "world.act", "world.admin"] },
      "executionContextNarrowing.grants: cannot add authority",
    ],
    [
      { privacyCeiling: { version: 1, allowedCategories: ceiling } },
      "executionContextNarrowing.privacyCeiling: cannot broaden privacy authority",
    ],
  ] as const) {
    const candidate = context({ ...broad, ...change });
    // The candidate is a valid context, so the refusal is narrowing's, not the decoder's.
    expect(decodeExecutionContext(candidate)).toEqual(candidate);
    let refusal: unknown;
    try {
      narrowTrustedExecutionContext(source, candidate);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ContractDecodeError);
    expect((refusal as Error).message).toBe(message);
  }
  // context() drops the "world.act" grant and the "conversation" category.
  expect(narrowTrustedExecutionContext(source, context())).toEqual(context());
  expect(source).toEqual(context(broad));
});
