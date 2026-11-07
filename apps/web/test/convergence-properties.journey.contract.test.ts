import { decodeSceneProjection } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { initialConvergence, type RecoveryRequest } from "../src/convergence.js";
import {
  backfillRequest,
  budget,
  deliver,
  elapsed,
  golden,
  later,
  patch,
  scope,
  semantic,
  snapshot,
  snapshotRequest,
} from "./convergence-fixture.js";

it("permutations, duplicates, delays and drops converge or request the exact missing interval", () => {
  const complete = [snapshot, patch, later(1n), later(2n)];
  const prefixes = [
    golden.initial,
    golden.commit,
    semantic({
      ...decodeSceneProjection(golden.commit.content),
      revision: snapshot.payload.revision + 2n,
      feedCursor: "feed-9",
    }),
    golden.final,
  ];
  for (const a of [0, 1, 2, 3])
    for (const b of [0, 1, 2, 3])
      for (const c of [0, 1, 2, 3])
        for (const d of [0, 1, 2, 3]) {
          const order = [a, b, c, d];
          if (new Set(order).size !== complete.length) continue;
          for (let drops = 0; drops < 1 << complete.length; drops++)
            for (const copies of [1, 2]) {
              let state = initialConvergence(scope);
              const history = order.filter((index) => !(drops & (1 << index)));
              const start = history.indexOf(0);
              const initialized = start !== -1;
              const received = new Set(initialized ? history.slice(start + 1) : []);
              const discarded = Math.max(
                0,
                ...history.slice(0, initialized ? start : history.length),
              );
              let prefix = 0;
              while (received.has(prefix + 1)) prefix++;
              let outstanding: RecoveryRequest | null = discarded > prefix ? snapshotRequest : null;
              for (const index of history) {
                for (let copy = 0; copy < copies; copy++) {
                  // A delayed initial snapshot must not erase or repeat its outstanding request.
                  if (index === 0) {
                    const delayed = elapsed(state, budget.gapTimeoutMs);
                    expect(delayed.requests).toEqual([]);
                    state = delayed.state;
                  }
                  const result = deliver(state, complete[index], 1);
                  const expected =
                    index === history[0] && index !== 0 && copy === 0 ? [snapshotRequest] : [];
                  expect(result.requests).toEqual(expected);
                  state = result.state;
                }
              }
              const next = [1, 2, 3].find((index) => index > prefix && received.has(index));
              const recovery: RecoveryRequest[] =
                !outstanding && initialized && next !== undefined
                  ? [
                      backfillRequest(
                        snapshot.payload.revision + BigInt(prefix),
                        snapshot.payload.revision + BigInt(next - 1),
                      ),
                    ]
                  : [];
              const timed = elapsed(state, budget.gapTimeoutMs);
              expect(timed.requests).toEqual(recovery);
              outstanding = recovery[0] ?? outstanding;
              expect(timed.state.outstanding).toEqual(outstanding);
              expect(timed.state.obligation).toEqual(
                discarded > prefix
                  ? {
                      audienceHash: snapshot.payload.audienceHash,
                      toRevision: snapshot.payload.revision + BigInt(discarded),
                    }
                  : null,
              );
              const actual = semantic(timed.state.projection);
              expect(
                actual,
                `order=${order} drops=${drops} copies=${copies}; actual normalized projection and hash: ${JSON.stringify(actual)}`,
              ).toEqual(initialized ? prefixes[prefix] : semantic(null));
              expect(timed.state.pending.map((message) => message.messageId)).toEqual(
                complete
                  .filter((_message, index) => index > prefix && received.has(index))
                  .map((message) => message.messageId),
              );
              // Terminal outcome precedes any repair; quiet tails cannot solicit replay.
              expect(elapsed(timed.state, budget.gapTimeoutMs).requests).toEqual([]);
            }
        }
});
