import {
  ContractDecodeError,
  decodeOpaqueId,
  SceneCompatibilityError,
} from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  buffered as bufferedState,
  deliver,
  expectCleared,
  expectRetired,
  golden,
  later,
  patch,
  reconnect,
  scope,
  semantic,
  snapshot,
  snapshotRequest,
  started,
} from "./convergence-fixture.js";

it("commits complete validated projections atomically and distinguishes input refusals from defects", () => {
  const initial = started();
  const refusal = (message: unknown) => expect(() => deliver(initial, message));
  const committed = deliver(initial, patch);
  const actual = semantic(committed.state.projection);
  expect(actual, `actual normalized projection and hash: ${JSON.stringify(actual)}`).toEqual(
    golden.commit,
  );
  expect(committed.requests).toEqual([]);
  for (const message of [patch, snapshot])
    expect(deliver(committed.state, message).state).toEqual(committed.state);
  refusal({
    ...patch,
    payload: { ...patch.payload, operations: [{ op: "remove_frame", frameId: "hall-frame" }] },
  }).toThrow(ContractDecodeError);
  expect(semantic(initial.projection)).toEqual(golden.initial);
  refusal({ ...patch, extra: true }).toThrowError(
    expect.objectContaining({ name: "ContractDecodeError" }),
  );
  refusal({ ...patch, protocolVersion: 2 }).toThrowError(
    expect.objectContaining({
      constructor: SceneCompatibilityError,
      code: "unsupported_protocol_version",
      actual: 2,
      expected: 1,
    }),
  );
  for (const [field, code] of [
    ["projectionVersion", "unsupported_projection_version"],
    ["assetManifestVersion", "unsupported_asset_manifest_version"],
    ["clientVersion", "unsupported_client_version"],
  ] as const)
    refusal({
      ...snapshot,
      payload: {
        ...snapshot.payload,
        compatibility: { ...snapshot.payload.compatibility, [field]: 3 },
      },
    }).toThrowError(
      expect.objectContaining({
        constructor: SceneCompatibilityError,
        code,
        actual: 3,
        expected: field === "projectionVersion" ? 2 : 1,
      }),
    );
  const defect = new Error("internal sentinel");
  try {
    deliver(initial, {
      get protocolVersion() {
        throw defect;
      },
    });
    throw new Error("missing defect");
  } catch (error) {
    expect(error).toBe(defect);
  }
  const buffered = bufferedState(initial);
  for (const replacementScope of [
    { ...scope, timelineId: decodeOpaqueId("other-timeline", "TimelineId") },
    { ...scope, spaceId: decodeOpaqueId("other-space", "SpaceId") },
  ]) {
    const mismatch = deliver(buffered, { ...patch, ...replacementScope });
    expectCleared(mismatch, [{ ...snapshotRequest, scope: replacementScope, audienceHash: null }]);
  }
  const reconnected = reconnect(buffered, "replacement");
  expectCleared(reconnected, [{ ...snapshotRequest, audienceHash: "replacement" }]);
  expectRetired(reconnected.state, buffered.intent);
  const resumed = reconnect(buffered, snapshot.payload.audienceHash);
  expect([
    resumed.state.projection,
    resumed.state.pending,
    resumed.state.obligation,
    resumed.requests,
  ]).toEqual([
    snapshot.payload,
    [],
    { audienceHash: snapshot.payload.audienceHash, toRevision: later(3n).payload.toRevision },
    [],
  ]);
});
