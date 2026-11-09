import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import {
  ContractDecodeError,
  decodeActorTargetBinding,
  decodeAuthorityDecision,
  decodeCommandReceipt,
} from "../src/index.js";

// Goldens under fixtures/journal-records/ are the published record shapes (docs/protocols/shared-contracts.md).
const binding = decodeActorTargetBinding({
  tenantId: "tenant-a",
  worldId: "world-a",
  timelineId: "timeline-main",
  kind: "space",
  id: "space-hall",
});
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/journal-records/${name}.json`, import.meta.url), "utf8"),
  );
const with_ = (base: Record<string, unknown>, changes: Record<string, unknown>) => {
  const copy = { ...base, ...changes };
  for (const [key, value] of Object.entries(changes)) if (value === undefined) delete copy[key];
  return copy;
};

const allow = fixture("allow-decision");
const deny = fixture("deny-decision");
const committed = fixture("committed-receipt");
const rejected = fixture("rejected-receipt");

it("decodes the record goldens to frozen values", () => {
  expect(decodeAuthorityDecision(allow)).toEqual(allow);
  expect(decodeAuthorityDecision(deny).reasonCode).toBe("missing-grant");
  const receipt = decodeCommandReceipt(committed, binding);
  expect(receipt.expected).toEqual({ streamSequence: 4n, partitionRevision: 9n, routingEpoch: 2 });
  expect(Object.isFrozen(receipt.committedEventIds)).toBe(true);
  expect(decodeCommandReceipt(rejected, binding).status).toBe("rejected");
});

it("refuses records whose status, attribution or decision do not agree", () => {
  for (const value of [
    with_(deny, { reasonCode: undefined }),
    with_(allow, { actionId: "action-other" }),
  ])
    expect(() => decodeAuthorityDecision(value)).toThrow(ContractDecodeError);
  for (const value of [
    with_(committed, { committedAt: undefined }),
    with_(rejected, { committedEventIds: ["event-x"] }),
    with_(committed, { authorityDecisionId: undefined }),
    with_(committed, { actionId: "action-other" }),
    with_(committed, { provenance: "legacy-wave0" }),
  ])
    expect(() => decodeCommandReceipt(value, binding)).toThrow(ContractDecodeError);
  const other = decodeActorTargetBinding({ ...binding, id: "space-other" });
  expect(() => decodeCommandReceipt(committed, other)).toThrow(ContractDecodeError);
});
