import { assertCapabilityProposal } from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { LocalRuntimeOwnerBindings, RuntimeWorker } from "../../../apps/runtime/src/worker.js";
import {
  authenticationFixture,
  authenticationRequest,
} from "../../../apps/runtime/test/auth-fixture.js";
import { trustedTestContext } from "../../../apps/runtime/test/trusted-context.js";

// A provider proposal is intent bytes only: authority comes from the ordinary request boundary.
it("runs a model proposal through ordinary authorization, command validation and epoch checks", async () => {
  const auth = authenticationFixture();
  const context = trustedTestContext();
  const state = {
    tenantId: context.tenantId,
    worldId: context.worldId,
    timelineId: context.timelineId,
    spaceId: context.spaceId,
    runtimeCellId: decodeOpaqueId("partition-fixture", "RuntimeCellId"),
    partitionId: decodeOpaqueId("partition-fixture", "PartitionId"),
    primaryStreamId: decodeOpaqueId("stream-fixture", "StreamId"),
    routingEpoch: 7n,
    authorityEpoch: 7n,
    projectionRevision: 0n,
    fidelity: "hot",
    lifecycleStatus: "ready",
  };
  const accepted = [];
  const journal = {
    async execute(request) {
      accepted.push(request);
      return { value: request.stableResult, events: [], projectionDelta: request.projectionDelta };
    },
  };
  const worker = new RuntimeWorker(
    auth.authenticator,
    new LocalRuntimeOwnerBindings({ loadReadyRuntimeState: async () => state }, journal),
  );
  const proposal = {
    kind: "command",
    type: "RuntimeNoOp",
    payload: await authenticationRequest().json(),
  };
  assertCapabilityProposal(proposal);
  const { payload } = proposal;

  // A refused command is journaled once as a deny decision with no events.
  auth.setWorldGrants([]);
  expect(
    (await worker.fetch(authenticationRequest({ ...payload, commandId: "refused" }))).status,
  ).toBe(403);
  expect(accepted).toHaveLength(1);
  expect(accepted[0].authorityDecision).toMatchObject({
    outcome: "deny",
    reasonCode: "runtime-grant-missing",
  });
  expect(accepted[0].events).toEqual([]);

  auth.setWorldGrants([decodeOpaqueId("runtime:no-op", "GrantRef")]);
  for (const [invalid, status, body] of [
    [{ ...payload, mutation: "write-state" }, 400, { error: "invalid_noop_command" }],
    [{ ...payload, authorityEpoch: "6" }, 409, { error: "stale_epoch", kind: "authority" }],
    [{ ...payload, worldId: "world-other" }, 403, { error: "authorization_refused" }],
  ]) {
    const response = await worker.fetch(authenticationRequest(invalid));
    expect([response.status, await response.json()]).toEqual([status, body]);
  }
  expect((await worker.fetch(authenticationRequest(payload, "invalid"))).status).toBe(401);
  expect(accepted).toHaveLength(1);
  expect((await worker.fetch(authenticationRequest(payload))).status).toBe(200);
  expect(accepted[1].authorization.principalId).toBe(context.principalId);

  expect(() => assertCapabilityProposal({ kind: "direct-mutation" })).toThrow("direct mutation");
  expect(() => assertCapabilityProposal({ ...proposal, authority: "self-granted" })).toThrow(
    "proposals only",
  );
});
