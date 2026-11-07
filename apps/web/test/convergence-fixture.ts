import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeObserverSceneMessage, type SceneProjection } from "@clockgrove/contracts";
import { expect } from "vitest";
import {
  type ConvergenceState,
  initialConvergence,
  type ProjectionReduction,
  type RecoveryBudget,
  reduceProjection,
} from "../src/convergence.js";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../packages/contracts/test/fixtures/realtime-projection/${name}.golden.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
const decodedSnapshot = decodeObserverSceneMessage(fixture("snapshot"));
const decodedPatch = decodeObserverSceneMessage(fixture("patch"));
if (decodedSnapshot.type !== "snapshot" || decodedPatch.type !== "patch")
  throw new Error("wrong wire fixtures");
export const snapshot = decodedSnapshot;
export const patch = decodedPatch;
export const snapshotAt = (revision: bigint) => ({
  ...snapshot,
  projectionRevision: revision,
  payload: { ...snapshot.payload, revision },
});
export const scope = {
  tenantId: snapshot.tenantId,
  worldId: snapshot.worldId,
  timelineId: snapshot.timelineId,
  spaceId: snapshot.spaceId,
};
export const budget: RecoveryBudget = {
  maxBufferedPatches: 2,
  maxRevisionGap: 4n,
  gapTimeoutMs: 10,
  requestTimeoutMs: 100,
};
export const snapshotRequest = {
  type: "snapshot",
  scope,
  audienceHash: snapshot.payload.audienceHash,
} as const;
export const resumeMessage = (lastAppliedRevision: string | null) =>
  ({ protocolVersion: 1, type: "resume", lastAppliedRevision, assetManifestVersion: 1 }) as const;
export const ackMessage = (revision: string, connectionVersion: number) =>
  ({ protocolVersion: 1, type: "ack", revision, connectionVersion }) as const;
export const later = (offset: bigint) => ({
  ...patch,
  messageId: `patch-${offset}`,
  projectionRevision: patch.payload.toRevision + offset,
  payload: {
    ...patch.payload,
    fromRevision: patch.payload.fromRevision + offset,
    toRevision: patch.payload.toRevision + offset,
    operations: [{ op: "set_feed_cursor", feedCursor: `feed-${8n + offset}` }],
  },
});
export const deliver = (
  state: ConvergenceState,
  message: unknown,
  elapsedMs = 0,
  limits = budget,
) =>
  reduceProjection(state, {
    type: "message",
    message,
    intent: state.intent,
    elapsedMs,
    budget: limits,
  });
export const started = () => deliver(initialConvergence(scope), snapshot).state;
export const buffered = (state = started()) =>
  [later(1n), later(2n), later(3n)].reduce(
    (current, message) => deliver(current, message).state,
    state,
  );
export const reconnect = (state: ConvergenceState, audienceHash: string) =>
  reduceProjection(state, { type: "reconnect", scope, audienceHash, elapsedMs: 0, budget });
export const backfillRequest = (fromRevision: bigint, toRevision: bigint) =>
  ({ ...snapshotRequest, type: "backfill", fromRevision, toRevision }) as const;
export function expectCleared(
  result: ProjectionReduction,
  requests: ProjectionReduction["requests"],
) {
  expect([
    result.state.projection,
    result.state.pending,
    result.state.obligation,
    result.requests,
  ]).toEqual([null, [], null, requests]);
}
export function expectRetired(state: ConvergenceState, intent: number) {
  for (const message of [snapshot, patch, later(1n)])
    expect(
      reduceProjection(state, { type: "message", message, intent, elapsedMs: 0, budget }),
    ).toEqual({ state, requests: [] });
}
export function expectRecovery(
  result: ProjectionReduction,
  revision: bigint,
  outstanding: ConvergenceState["outstanding"],
) {
  expect([result.state.projection?.revision, result.state.outstanding, result.requests]).toEqual([
    revision,
    outstanding,
    [],
  ]);
}
export const elapsed = (state: ConvergenceState, elapsedMs: number, limits = budget) =>
  reduceProjection(state, { type: "elapsed", intent: state.intent, elapsedMs, budget: limits });
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function semantic(projection: SceneProjection | null) {
  const content = projection && {
    ...projection,
    hierarchy: [...projection.hierarchy].sort((a, b) => compareText(a.spaceId, b.spaceId)),
    frames: [...projection.frames].sort((a, b) => compareText(a.frameId, b.frameId)),
    entities: [...projection.entities].sort((a, b) => compareText(a.objectId, b.objectId)),
    presentationBindings: [...projection.presentationBindings].sort((a, b) =>
      compareText(a.objectId, b.objectId),
    ),
    interactions: [...projection.interactions].sort((a, b) => compareText(a.entityId, b.entityId)),
  };
  const normalized = JSON.stringify(content, (_key, value: unknown) =>
    typeof value === "bigint"
      ? value.toString()
      : value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareText(a, b)))
        : value,
  );
  const normalizedContent: unknown = JSON.parse(normalized);
  return {
    content: normalizedContent,
    hash: createHash("sha256").update(normalized).digest("hex"),
  };
}
export const golden: {
  initial: ReturnType<typeof semantic>;
  commit: ReturnType<typeof semantic>;
  final: ReturnType<typeof semantic>;
} = JSON.parse(
  readFileSync(new URL("./fixtures/convergence-golden.json", import.meta.url), "utf8"),
);
