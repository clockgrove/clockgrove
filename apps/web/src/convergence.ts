import {
  type BrowserScope,
  decodeObserverSceneMessage,
  type ObserverSceneMessage,
  type SceneProjection,
} from "@clockgrove/contracts";
import { sameSceneScope as sameScope } from "./scene-projection.js";
import { applyScenePatch } from "./world-scene-adapter.js";

export interface RecoveryBudget {
  readonly maxBufferedPatches: number;
  readonly maxRevisionGap: bigint;
  readonly gapTimeoutMs: number;
  /** The lifetime of an outstanding request without progress, after which it escalates. */
  readonly requestTimeoutMs: number;
}
export type RecoveryRequest =
  | {
      readonly type: "snapshot";
      readonly scope: BrowserScope;
      readonly audienceHash: string | null;
    }
  | {
      readonly type: "backfill";
      readonly scope: BrowserScope;
      readonly audienceHash: string | null;
      readonly fromRevision: bigint;
      readonly toRevision: bigint;
    }
  /** An outstanding snapshot request expired: only a fresh connection can recover. */
  | { readonly type: "reconnect"; readonly scope: BrowserScope };
type PendingPatch = Extract<ObserverSceneMessage, { type: "patch" }>;
export interface ConvergenceState {
  readonly intent: number;
  readonly scope: BrowserScope;
  readonly projection: SceneProjection | null;
  readonly audienceHash: string | null;
  readonly pending: readonly PendingPatch[];
  readonly gapElapsedMs: number;
  readonly outstanding: Exclude<RecoveryRequest, { type: "reconnect" }> | null;
  /** Time since the outstanding request was issued or last made progress. */
  readonly requestElapsedMs: number;
  readonly obligation: { readonly audienceHash: string; readonly toRevision: bigint } | null;
}
type Timing = { readonly elapsedMs: number; readonly budget: RecoveryBudget };
export type ProjectionAction = Timing &
  (
    | { readonly type: "message"; readonly message: unknown; readonly intent: number }
    | { readonly type: "elapsed"; readonly intent: number }
    | {
        readonly type: "reconnect";
        readonly scope: BrowserScope;
        readonly audienceHash: string | null;
      }
  );
export interface ProjectionReduction {
  readonly state: ConvergenceState;
  readonly requests: readonly RecoveryRequest[];
}
export function initialConvergence(scope: BrowserScope): ConvergenceState {
  const { tenantId, worldId, timelineId, spaceId } = scope;
  return {
    intent: 0,
    scope: { tenantId, worldId, timelineId, spaceId },
    projection: null,
    audienceHash: null,
    pending: [],
    gapElapsedMs: 0,
    outstanding: null,
    requestElapsedMs: 0,
    obligation: null,
  };
}
function comparePatch(a: PendingPatch, b: PendingPatch): number {
  for (const key of ["fromRevision", "toRevision"] as const) {
    if (a.payload[key] !== b.payload[key]) return a.payload[key] < b.payload[key] ? -1 : 1;
  }
  return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}
function request(
  state: ConvergenceState,
  next: NonNullable<ConvergenceState["outstanding"]>,
): ProjectionReduction {
  const previous = state.outstanding;
  // An outstanding request covers the same snapshot, or a backfill within its revision range.
  const covered =
    previous?.type === next.type &&
    sameScope(previous.scope, next.scope) &&
    previous.audienceHash === next.audienceHash &&
    (previous.type === "snapshot" ||
      (next.type === "backfill" &&
        previous.fromRevision <= next.fromRevision &&
        next.toRevision <= previous.toRevision));
  return covered
    ? { state, requests: [] }
    : { state: { ...state, outstanding: next, requestElapsedMs: 0 }, requests: [next] };
}
/** An outstanding request without progress for its lifetime escalates: backfill, snapshot, reconnect. */
function expire(reduction: ProjectionReduction, budget: RecoveryBudget): ProjectionReduction {
  const { state } = reduction;
  if (!state.outstanding || state.requestElapsedMs < budget.requestTimeoutMs) return reduction;
  if (state.outstanding.type === "backfill")
    return request(state, {
      type: "snapshot",
      scope: state.scope,
      audienceHash: state.audienceHash,
    });
  return {
    state: { ...state, requestElapsedMs: 0 },
    requests: [...reduction.requests, { type: "reconnect", scope: state.scope }],
  };
}
/** Pure reduction. Elapsed time is a delta since the preceding action, supplied by the caller. */
export function reduceProjection(
  previous: ConvergenceState,
  action: ProjectionAction,
): ProjectionReduction {
  if (action.type !== "reconnect" && action.intent !== previous.intent)
    return { state: previous, requests: [] };
  return expire(converge(previous, action), action.budget);
}
function converge(previous: ConvergenceState, action: ProjectionAction): ProjectionReduction {
  const { budget, elapsedMs } = action;
  if (
    !Number.isSafeInteger(budget.maxBufferedPatches) ||
    budget.maxBufferedPatches < 0 ||
    budget.maxRevisionGap < 0n ||
    !Number.isFinite(budget.gapTimeoutMs) ||
    budget.gapTimeoutMs < 0 ||
    !Number.isFinite(budget.requestTimeoutMs) ||
    budget.requestTimeoutMs < 0 ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0
  )
    throw new RangeError("invalid convergence budget or elapsed time");
  let state = {
    ...previous,
    gapElapsedMs: previous.pending.length
      ? Math.min(budget.gapTimeoutMs, previous.gapElapsedMs + elapsedMs)
      : 0,
    requestElapsedMs: previous.outstanding
      ? Math.min(budget.requestTimeoutMs, previous.requestElapsedMs + elapsedMs)
      : 0,
  };
  let snapshotRequired = false;
  if (action.type === "reconnect") {
    const retain =
      sameScope(state.scope, action.scope) && state.audienceHash === action.audienceHash;
    state = {
      ...initialConvergence(action.scope),
      intent: previous.intent + 1,
      projection: retain ? state.projection : null,
      audienceHash: action.audienceHash,
      outstanding: retain ? state.outstanding : null,
      obligation: retain ? state.obligation : null,
      pending: retain ? state.pending : [],
    };
    if (retain && state.pending.length) snapshotRequired = true;
    // Reconnect discards operations, but keeps their revision obligation in this audience.
    for (const item of state.pending) {
      if (!state.obligation || item.payload.toRevision > state.obligation.toRevision)
        state = {
          ...state,
          obligation: {
            audienceHash: item.payload.audienceHash,
            toRevision: item.payload.toRevision,
          },
        };
    }
    state = { ...state, pending: [] };
    if (!retain || !state.projection) snapshotRequired = true;
  } else if (action.type === "message") {
    const message = decodeObserverSceneMessage(action.message);
    if (!sameScope(state.scope, message)) {
      state = { ...initialConvergence(message), intent: previous.intent + 1 };
      snapshotRequired = true;
    } else if (message.lane === "projection") {
      const audienceHash = message.payload.audienceHash;
      if (state.audienceHash !== null && state.audienceHash !== audienceHash) {
        state = { ...initialConvergence(state.scope), intent: previous.intent + 1, audienceHash };
        snapshotRequired = true;
      } else if (message.type === "snapshot") {
        if (
          !state.projection ||
          message.payload.revision > state.projection.revision ||
          (message.payload.revision === state.projection.revision &&
            state.outstanding?.type === "snapshot")
        ) {
          const committed =
            state.projection?.revision === message.payload.revision
              ? state.projection
              : message.payload;
          state = {
            ...state,
            projection: committed,
            audienceHash,
            gapElapsedMs: 0,
            outstanding: state.obligation ? state.outstanding : null,
          };
        }
      } else if (!state.projection) {
        state = {
          ...state,
          audienceHash,
          obligation: {
            audienceHash,
            toRevision:
              state.obligation && state.obligation.toRevision > message.payload.toRevision
                ? state.obligation.toRevision
                : message.payload.toRevision,
          },
        };
        snapshotRequired = true;
      } else if (message.payload.toRevision > state.projection.revision) {
        if (message.payload.fromRevision < state.projection.revision) {
          state = {
            ...state,
            obligation: {
              audienceHash,
              toRevision:
                state.obligation && state.obligation.toRevision > message.payload.toRevision
                  ? state.obligation.toRevision
                  : message.payload.toRevision,
            },
          };
          snapshotRequired = true;
        } else if (!state.pending.some((item) => item.messageId === message.messageId)) {
          state = { ...state, pending: [...state.pending, message].sort(comparePatch) };
        }
      }
    }
  }
  let projection = state.projection;
  let pending = state.pending.filter(
    (item) => !projection || item.payload.toRevision > projection.revision,
  );
  while (projection) {
    const revision = projection.revision;
    const next = pending.find((item) => item.payload.fromRevision === revision);
    if (!next) break;
    projection = applyScenePatch(projection, next.payload);
    const committedRevision = projection.revision;
    pending = pending.filter((item) => item.payload.toRevision > committedRevision);
  }
  const revision = projection?.revision;
  const excessive =
    revision !== undefined &&
    pending.some(
      (item) =>
        item.payload.fromRevision - revision > budget.maxRevisionGap ||
        item.payload.fromRevision < revision,
    );
  const overflow = pending.length > budget.maxBufferedPatches;
  for (const item of excessive ? pending : pending.slice(budget.maxBufferedPatches)) {
    if (!state.obligation || item.payload.toRevision > state.obligation.toRevision)
      state = {
        ...state,
        obligation: {
          audienceHash: item.payload.audienceHash,
          toRevision: item.payload.toRevision,
        },
      };
  }
  if (
    projection &&
    state.obligation &&
    projection.audienceHash === state.obligation.audienceHash &&
    projection.revision >= state.obligation.toRevision
  )
    state = { ...state, obligation: null, outstanding: null };
  // Committed progress restarts the outstanding request's lifetime.
  state = {
    ...state,
    projection,
    pending: pending.slice(0, budget.maxBufferedPatches),
    requestElapsedMs:
      state.outstanding && projection?.revision === previous.projection?.revision
        ? state.requestElapsedMs
        : 0,
  };
  if (
    snapshotRequired ||
    excessive ||
    overflow ||
    state.obligation ||
    state.outstanding?.type === "snapshot"
  ) {
    return request(state, {
      type: "snapshot",
      scope: state.scope,
      audienceHash: state.audienceHash,
    });
  }
  if (!pending.length)
    return { state: { ...state, gapElapsedMs: 0, outstanding: null }, requests: [] };
  const first = pending[0];
  if (projection && first && state.gapElapsedMs >= budget.gapTimeoutMs) {
    return request(state, {
      type: "backfill",
      scope: state.scope,
      audienceHash: state.audienceHash,
      fromRevision: projection.revision,
      toRevision: first.payload.fromRevision,
    });
  }
  return { state, requests: [] };
}
