import {
  type BrowserScope,
  ContractDecodeError,
  type CorrelationId,
  type DiagnosticSceneProjection,
  decodeProjectionMessage,
  decodeSceneServerControl,
  encodeSceneConnectionControl,
  type LivingScene,
  type ProjectionConnect,
  SCENE_ASSET_MANIFEST_VERSION,
  SCENE_PROTOCOL,
  SCENE_PROTOCOL_VERSION,
  type SceneCompatibilityCode,
  SceneCompatibilityError,
  type SceneProjection,
} from "@clockgrove/contracts";
import {
  initialConvergence,
  type ProjectionReduction,
  type RecoveryBudget,
  reduceProjection,
} from "./convergence.js";
import { measure, timed } from "./measurements.js";
import { livingSceneOf, sameYardScope } from "./yard-projection.js";

export { applyScenePatch } from "./world-scene-adapter.js";
export interface ProjectionSocket {
  readonly closed?: Promise<void>;
  readonly protocol?: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export type ProjectionStatus = "connecting" | "ready" | "degraded" | "unavailable";
export class ProjectionClient {
  private socket: ProjectionSocket | undefined;
  private scene: DiagnosticSceneProjection | undefined;
  private generation = 0;
  constructor(
    private readonly scope: BrowserScope,
    private readonly correlationId: CorrelationId,
    private readonly open: () => ProjectionSocket,
    private readonly changed: (
      status: ProjectionStatus,
      scene: DiagnosticSceneProjection | undefined,
    ) => void,
  ) {}
  connect(): void {
    this.disconnect();
    const generation = ++this.generation;
    this.changed("connecting", this.scene);
    const socket = this.open();
    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.generation) return;
      const envelope: ProjectionConnect = {
        tenantId: this.scope.tenantId,
        worldId: this.scope.worldId,
        timelineId: this.scope.timelineId,
        spaceId: this.scope.spaceId,
        version: 1,
        type: "connect",
        correlationId: this.correlationId,
        resumeRevision: this.scene?.revision ?? null,
      };
      socket.send(JSON.stringify(envelope));
    };
    socket.onmessage = ({ data }) => {
      if (generation !== this.generation) return;
      try {
        const message = decodeProjectionMessage(JSON.parse(data));
        if (message.correlationId !== this.correlationId)
          throw new Error("projection correlation mismatch");
        if (message.type === "unavailable") {
          this.disconnect();
          this.changed("unavailable", this.scene);
          return;
        }
        const scope = message.type === "snapshot" ? message.scene : message.scope;
        if (!sameYardScope(this.scope, scope)) throw new Error("projection scope mismatch");
        if (message.type === "snapshot") {
          if (this.scene && message.scene.revision < this.scene.revision) return;
          this.scene = message.scene;
        } else {
          if (this.scene && message.revision <= this.scene.revision) return;
          if (!this.scene || message.fromRevision !== this.scene.revision) {
            this.scene = undefined;
            this.changed("degraded", undefined);
            this.connect();
            return;
          }
          this.scene = { ...this.scene, revision: message.revision, entities: message.entities };
        }
        this.changed("ready", this.scene);
      } catch {
        this.disconnect();
        this.changed("unavailable", this.scene);
      }
    };
    socket.onclose = () => {
      if (generation === this.generation) {
        this.disconnect();
        this.changed("degraded", this.scene);
      }
    };
    socket.onerror = () => {
      measure("client_errors", "socket");
      if (generation === this.generation) {
        this.disconnect();
        this.changed("degraded", this.scene);
      }
    };
  }
  disconnect(): void {
    this.generation++;
    this.socket?.close();
    this.socket = undefined;
  }
}
export type SceneStreamStatus =
  | "connecting"
  | "ready"
  | "recovering"
  | "unavailable"
  | "authorization_lost"
  // A final incompatibility: the projection is discarded and the client retired.
  | SceneCompatibilityCode;

/**
 * Reconnection after a retryable loss: a close, pressure, a lost server ledger or a rejoin.
 * Decisions: the first delay is the runtime's 1 s retry hint (`SPACE_MAILBOX_BOUNDS.retryAfterSeconds`),
 * doubling over five attempts to 16 s, about 31 s in all, past the owner mailbox's 30 s request
 * deadline. Each delay is cut by up to half at random so a reconnect storm spreads out. A gap this
 * client detected uses reducer-directed resume recovery. An applied
 * projection resets the count; the sixth loss in a row is `unavailable`.
 */
export const SCENE_RECONNECT = { firstDelayMs: 1_000, attempts: 5 } as const;

// Runtime delivery permits four outstanding frames and at most 64 recovery revisions.
// Decision: wait one first-reconnect interval for reordered predecessors before requesting repair.
// Decision: an outstanding backfill or snapshot request lives 30 s without progress, the runtime
// owner mailbox's request deadline (`SPACE_MAILBOX_BOUNDS.requestDeadlineMs`), within which an
// admitted resume is answered or refused. Then a backfill escalates to a snapshot request, and a
// snapshot request to a `SCENE_RECONNECT` reconnect.
export const SCENE_RECOVERY: RecoveryBudget = {
  maxBufferedPatches: 4,
  maxRevisionGap: 64n,
  gapTimeoutMs: SCENE_RECONNECT.firstDelayMs,
  requestTimeoutMs: 30_000,
};

/**
 * Snapshot retries after a protocol or projection version mismatch, which a deployment swap can
 * cause transiently. Decision: two retries, one runtime retry hint (`SCENE_RECONNECT.firstDelayMs`)
 * apart. Each rejected snapshot stays unacknowledged, so the retries stay below the runtime's four
 * unacknowledged frames (`SCENE_DELIVERY_BOUNDS.unacknowledged`). The next mismatch is final.
 * Client and asset-manifest mismatches are never retried: only a refreshed client can match them.
 */
export const SCENE_SNAPSHOT_RETRY = { attempts: 2, delayMs: SCENE_RECONNECT.firstDelayMs } as const;

/** One current transport, with a retained successfully applied recovery cursor. */
export class SceneProjectionClient {
  private socket: ProjectionSocket | undefined;
  private convergence;
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  private reducedAt = 0;
  private generation = 0;
  private retiring: Promise<void> = Promise.resolve();
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  // Snapshot retries spent since the last compatible delivery, across reconnects.
  private snapshotRetries = 0;
  private snapshotRetry: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly scope: BrowserScope,
    private readonly open: () => ProjectionSocket,
    private readonly changed: (
      status: SceneStreamStatus,
      scene: LivingScene | undefined,
      projection?: SceneProjection,
    ) => void,
  ) {
    this.convergence = initialConvergence(scope);
  }
  async connect(): Promise<void> {
    const retirement = this.retire();
    const generation = this.generation;
    await retirement;
    if (generation !== this.generation) return;
    this.changed("connecting", undefined);
    if (generation !== this.generation) return;
    let socket: ProjectionSocket;
    try {
      socket = this.open();
    } catch {
      measure("client_errors", "socket");
      if (generation === this.generation) this.fail("unavailable");
      return;
    }
    this.socket = socket;
    this.convergence = timed(
      "reducer_latency_ms",
      "control",
      () =>
        reduceProjection(this.convergence, {
          type: "reconnect",
          scope: this.scope,
          audienceHash: this.convergence.audienceHash,
          elapsedMs: 0,
          budget: SCENE_RECOVERY,
        }).state,
    );
    this.reducedAt = performance.now();
    let delivered = false;
    let awaitingDelivery = true;
    let reachedReady = false;
    let notifiedStatus: SceneStreamStatus | undefined;
    let connectionVersion = 0;
    let endpoints: bigint[] = [];
    let acknowledged: bigint | null = null;
    // When the resume that opened this delivery wait was sent.
    let resumedAt: number | undefined;
    const resume = (revision: bigint | null) => {
      endpoints = [];
      acknowledged = null;
      connectionVersion++;
      socket.send(
        encodeSceneConnectionControl({
          protocolVersion: SCENE_PROTOCOL_VERSION,
          type: "resume",
          lastAppliedRevision: revision,
          assetManifestVersion: SCENE_ASSET_MANIFEST_VERSION,
        }),
      );
    };
    // One timer: the outstanding request's lifetime, else the gap wait for buffered patches.
    const arm = () => {
      clearTimeout(this.gapTimer);
      const { outstanding, pending, requestElapsedMs, gapElapsedMs } = this.convergence;
      if (!outstanding && !pending.length) {
        // A resume of a retained projection is no reducer request, but has the same lifetime.
        if (awaitingDelivery && resumedAt !== undefined)
          this.gapTimer = setTimeout(
            () => {
              if (generation === this.generation && awaitingDelivery) this.recover();
            },
            Math.max(0, SCENE_RECOVERY.requestTimeoutMs - (performance.now() - resumedAt)),
          );
        return;
      }
      this.gapTimer = setTimeout(
        () => {
          if (generation !== this.generation) return;
          try {
            const now = performance.now();
            const elapsedMs = now - this.reducedAt;
            this.reducedAt = now;
            commit(
              timed("reducer_latency_ms", "control", () =>
                reduceProjection(this.convergence, {
                  type: "elapsed",
                  intent: this.convergence.intent,
                  elapsedMs,
                  budget: SCENE_RECOVERY,
                }),
              ),
            );
          } catch {
            if (generation === this.generation) this.fail("unavailable");
          }
        },
        Math.max(
          0,
          outstanding
            ? SCENE_RECOVERY.requestTimeoutMs - requestElapsedMs
            : SCENE_RECOVERY.gapTimeoutMs - gapElapsedMs,
        ),
      );
    };
    const commit = (reduction: ProjectionReduction, snapshotRevision?: bigint) => {
      const previous = this.convergence.projection;
      this.convergence = reduction.state;
      clearTimeout(this.gapTimer);
      const next = this.convergence.projection;
      // Ignored snapshots, duplicate patches and elapsed actions cannot satisfy delivery.
      // A compatible snapshot at the retained revision does deliver that committed state.
      if (next && (next !== previous || snapshotRevision === next.revision))
        awaitingDelivery = false;
      const status =
        awaitingDelivery || !next || this.convergence.pending.length || this.convergence.outstanding
          ? reachedReady
            ? "recovering"
            : "connecting"
          : "ready";
      if (status === "ready") reachedReady = true;
      const publishProjection = next && (next !== previous || (!delivered && !awaitingDelivery));
      if (publishProjection) {
        delivered = true;
        this.attempts = 0;
        this.snapshotRetries = 0;
      }
      if (publishProjection || status === "recovering" || status !== notifiedStatus) {
        notifiedStatus = status;
        this.changed(status, next ? livingSceneOf(next) : undefined, next ?? undefined);
        if (generation !== this.generation) return;
      }
      if (next && acknowledged !== next.revision && endpoints.includes(next.revision)) {
        socket.send(
          encodeSceneConnectionControl({
            protocolVersion: SCENE_PROTOCOL_VERSION,
            type: "ack",
            revision: next.revision,
            connectionVersion,
          }),
        );
        acknowledged = next.revision;
        endpoints = endpoints.filter((revision) => revision > next.revision);
      }
      if (generation !== this.generation) return;
      for (const request of reduction.requests) {
        if (request.type === "reconnect") {
          this.recover();
          return;
        }
        measure("scene_recovery", request.type === "backfill" ? "gap" : "snapshot_fallback");
        delivered = false;
        resume(request.type === "backfill" ? request.fromRevision : null);
      }
      arm();
    };
    // A mismatched scene never stays live: the committed projection is discarded first.
    const incompatible = (code: SceneCompatibilityCode) => {
      if (
        (code !== "unsupported_protocol_version" && code !== "unsupported_projection_version") ||
        this.snapshotRetries >= SCENE_SNAPSHOT_RETRY.attempts
      ) {
        this.fail(code);
        return;
      }
      this.snapshotRetries += 1;
      clearTimeout(this.gapTimer);
      this.convergence = initialConvergence(this.scope);
      delivered = false;
      awaitingDelivery = true;
      this.changed(reachedReady ? "recovering" : "connecting", undefined);
      if (generation !== this.generation) return;
      this.snapshotRetry = setTimeout(() => {
        if (generation !== this.generation) return;
        try {
          resume(null);
          resumedAt = performance.now();
          arm();
        } catch {
          if (generation === this.generation) this.fail("unavailable");
        }
      }, SCENE_SNAPSHOT_RETRY.delayMs);
    };
    socket.onopen = () => {
      if (generation !== this.generation) return;
      try {
        if (socket.protocol !== undefined && socket.protocol !== SCENE_PROTOCOL) {
          this.fail("unavailable");
          return;
        }
        resume(
          this.convergence.outstanding?.type === "snapshot"
            ? null
            : (this.convergence.projection?.revision ?? null),
        );
        resumedAt = performance.now();
        arm();
      } catch {
        if (generation === this.generation) this.fail("unavailable");
      }
    };
    socket.onmessage = ({ data }) => {
      if (generation !== this.generation) return;
      try {
        const value: unknown = JSON.parse(data);
        if (
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          (value.type === "recovery" || value.type === "disconnect")
        ) {
          const control = decodeSceneServerControl(value);
          if (control.type === "disconnect" && control.reason === "unauthorized") {
            this.fail("authorization_lost");
          } else if (control.type === "disconnect" && control.reason !== "stale_authority_epoch") {
            this.fail("unavailable");
          } else if (control.reason === "asset_manifest_changed") {
            this.fail("unavailable");
          } else if (control.reason !== "snapshot_required") {
            // Pressure, a lost server ledger or a rejoin: only a fresh connection restarts at
            // connection version 1 under the current authority epoch.
            this.recover();
          } else {
            delivered = false;
            awaitingDelivery = true;
            const current = this.convergence.projection;
            this.changed(
              reachedReady ? "recovering" : "connecting",
              current ? livingSceneOf(current) : undefined,
              current ?? undefined,
            );
          }
          return;
        }
        const now = performance.now();
        const elapsedMs = now - this.reducedAt;
        // A projection snapshot or patch is timed as itself; every other frame (a cue, recovery,
        // connections or disconnect) is a control frame and never counted as a patch.
        const frame =
          typeof value === "object" && value !== null && "type" in value ? value.type : undefined;
        const reduction = timed(
          "reducer_latency_ms",
          frame === "snapshot" || frame === "patch" ? frame : "control",
          () =>
            reduceProjection(this.convergence, {
              type: "message",
              message: value,
              intent: this.convergence.intent,
              elapsedMs,
              budget: SCENE_RECOVERY,
            }),
        );
        if (!sameYardScope(this.scope, reduction.state.scope))
          throw new ContractDecodeError("message", "scope mismatch");
        // The reducer has strictly validated the whole message. Only read envelope metadata
        // here; decoding again would traverse every snapshot collection or patch operation.
        if (
          typeof value !== "object" ||
          value === null ||
          !("lane" in value) ||
          value.lane !== "projection" ||
          !("projectionRevision" in value) ||
          typeof value.projectionRevision !== "string"
        )
          return;
        const revision = BigInt(value.projectionRevision);
        endpoints = [...endpoints, revision].slice(-SCENE_RECOVERY.maxBufferedPatches);
        this.reducedAt = now;
        commit(reduction, "type" in value && value.type === "snapshot" ? revision : undefined);
      } catch (error) {
        if (generation !== this.generation) return;
        // Only the compatibility code leaves; other decoder diagnostics stay at their boundary.
        if (error instanceof SceneCompatibilityError) incompatible(error.code);
        else this.fail("unavailable");
      }
    };
    socket.onclose = () => {
      if (generation === this.generation) this.recover();
    };
    socket.onerror = () => {
      measure("client_errors", "socket");
      if (generation === this.generation) this.recover();
    };
  }
  /** Reconnects with jittered exponential backoff (`SCENE_RECONNECT`), keeping the applied cursor. */
  private recover(): void {
    if (this.attempts >= SCENE_RECONNECT.attempts) {
      this.fail("unavailable");
      return;
    }
    measure("scene_recovery", "reconnect");
    const delay = SCENE_RECONNECT.firstDelayMs * 2 ** this.attempts * (1 - Math.random() / 2);
    this.attempts += 1;
    void this.retire();
    const generation = this.generation;
    const current = this.convergence.projection;
    this.changed("recovering", current ? livingSceneOf(current) : undefined, current ?? undefined);
    this.retry = setTimeout(() => {
      if (generation !== this.generation) return;
      const reconnect = this.connect();
      const connecting = this.generation;
      void reconnect.catch(() => {
        if (connecting === this.generation) this.fail("unavailable");
      });
    }, delay);
  }
  private fail(status: "unavailable" | "authorization_lost" | SceneCompatibilityCode): void {
    void this.disconnect();
    this.changed(status, undefined);
  }
  disconnect(): Promise<void> {
    this.convergence = initialConvergence(this.scope);
    this.attempts = 0;
    this.snapshotRetries = 0;
    return this.retire();
  }
  private retire(): Promise<void> {
    clearTimeout(this.retry);
    clearTimeout(this.gapTimer);
    clearTimeout(this.snapshotRetry);
    this.generation++;
    const generation = this.generation;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      // Detach callbacks before close, which may synchronously notify the old transport.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
        this.retiring = Promise.resolve(socket.closed);
      } catch {
        this.retiring = Promise.reject();
      }
      this.retiring = this.retiring.catch(() => {
        if (generation !== this.generation) return;
        this.convergence = initialConvergence(this.scope);
        this.changed("unavailable", undefined);
      });
    }
    return this.retiring;
  }
}
