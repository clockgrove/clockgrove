import { expect, it } from "vitest";
import { type ProjectionReduction } from "../src/convergence.js";
import {
  backfillRequest,
  buffered as bufferedState,
  deliver,
  elapsed,
  expectCleared,
  expectRecovery,
  expectRetired,
  later,
  patch,
  reconnect,
  scope,
  snapshot,
  snapshotAt,
  snapshotRequest,
  started,
} from "./convergence-fixture.js";

it("bounds gaps, retires recovery and preserves discarded revision obligations", () => {
  const { revision } = snapshot.payload;
  const obligation = {
    audienceHash: snapshot.payload.audienceHash,
    toRevision: later(3n).payload.toRevision,
  };
  const gap = deliver(started(), later(1n));
  expect(gap.requests).toEqual([]);
  expect(elapsed(gap.state, 9).requests).toEqual([]);
  const timed = elapsed(gap.state, 10);
  expect(timed.requests).toEqual([
    backfillRequest(snapshot.payload.revision, patch.payload.toRevision),
  ]);
  expect(elapsed(timed.state, 10).requests).toEqual([]);
  const repaired = deliver(timed.state, patch);
  expectRecovery(repaired, revision + 2n, null);
  expect(repaired.state.projection?.feedCursor).toBe("feed-9");
  expect(repaired.state.pending).toEqual([]);
  const excessive = deliver(timed.state, later(6n));
  expect(excessive.requests).toEqual([snapshotRequest]);
  expect(elapsed(excessive.state, 10).requests).toEqual([]);
  const replaced = deliver(excessive.state, snapshotAt(patch.payload.toRevision));
  expectRecovery(replaced, revision + 2n, snapshotRequest);
  expect(replaced.state.pending.map((item) => item.messageId)).toEqual(["patch-6"]);
  for (const messages of [
    [later(3n), later(2n), later(1n)],
    [later(1n), later(3n), later(2n)],
  ]) {
    const { state, requests } = messages.reduce<ProjectionReduction>(
      (current, message) => deliver(current.state, message),
      { state: started(), requests: [] },
    );
    expect(state.pending.map((item) => item.messageId)).toEqual(["patch-1", "patch-2"]);
    expect(requests).toEqual([snapshotRequest]);
    const insufficient = deliver(state, snapshot);
    expectRecovery(insufficient, revision, snapshotRequest);
    expect(insufficient.state.obligation).toEqual(obligation);
    const partial = deliver(insufficient.state, patch);
    expectRecovery(partial, revision + 3n, snapshotRequest);
    const contiguous = deliver(partial.state, later(3n));
    expectRecovery(contiguous, revision + 4n, null);
    expect(contiguous.state.projection?.feedCursor).toBe("feed-11");
    expect(contiguous.state.obligation).toBeNull();
    const covered = deliver(insufficient.state, snapshotAt(later(3n).payload.toRevision));
    expectRecovery(covered, revision + 4n, null);
    expect(covered.state.pending).toEqual([]);
    expect(covered.state.obligation).toBeNull();
  }
  const buffered = bufferedState();
  const changedAudience = deliver(buffered, {
    ...patch,
    payload: { ...patch.payload, audienceHash: "replacement" },
  });
  expectCleared(changedAudience, [{ ...snapshotRequest, audienceHash: "replacement" }]);
  const newAudience = {
    ...snapshot,
    payload: {
      ...snapshot.payload,
      audienceHash: "replacement",
      entities: [],
      presentationBindings: [],
      interactions: [],
    },
  };
  expect(deliver(changedAudience.state, newAudience).state.projection).toEqual(newAudience.payload);
  expectRetired(changedAudience.state, buffered.intent);
});

it("escalates an unanswered recovery request from backfill to snapshot to reconnect", () => {
  const backfill = backfillRequest(snapshot.payload.revision, patch.payload.toRevision);
  const timed = elapsed(deliver(started(), later(1n)).state, 10);
  expect(timed.requests).toEqual([backfill]);
  const waiting = elapsed(timed.state, 99);
  expectRecovery(waiting, snapshot.payload.revision, backfill);
  const fallback = elapsed(waiting.state, 1);
  expect(fallback.requests).toEqual([snapshotRequest]);
  expectRecovery(elapsed(fallback.state, 99), snapshot.payload.revision, snapshotRequest);
  const stalled = elapsed(fallback.state, 100);
  expect(stalled.requests).toEqual([{ type: "reconnect", scope }]);
  const reopened = reconnect(stalled.state, snapshot.payload.audienceHash);
  expect([reopened.state.outstanding, reopened.state.requestElapsedMs]).toEqual([
    snapshotRequest,
    0,
  ]);
  expect(elapsed(reopened.state, 100).requests).toEqual([{ type: "reconnect", scope }]);
});

it("does not re-request a backfill while its range is answered one patch at a time", () => {
  const limits = {
    maxBufferedPatches: 4,
    maxRevisionGap: 64n,
    gapTimeoutMs: 1_000,
    requestTimeoutMs: 30_000,
  };
  const { revision } = snapshot.payload;
  const timed = elapsed(deliver(started(), later(30n), 0, limits).state, 1_000, limits);
  expect(timed.requests).toEqual([backfillRequest(revision, revision + 30n)]);
  let state = timed.state;
  for (const message of [patch, ...Array.from({ length: 29 }, (_, i) => later(BigInt(i + 1)))]) {
    const repaired = deliver(state, message, 29_999, limits);
    expect(repaired.requests).toEqual([]);
    state = repaired.state;
  }
  expect([state.projection?.revision, state.outstanding, state.pending]).toEqual([
    revision + 31n,
    null,
    [],
  ]);
});
