import {
  AuthorizationRefusedError,
  JournalRouteNotFoundError,
  NO_METRICS,
  type RuntimeMetrics,
  recordMetric,
} from "@clockgrove/application";
import {
  decodeSceneConnectionAttachment,
  encodeObserverSceneMessage,
  encodeSceneConnectionControl,
  type ObserverSceneMessage,
  type SceneAcknowledgementControl,
  type SceneConnectionAttachment,
  type SceneDisconnectReason,
  type ScenePatch,
  type ScenePatchOperation,
  type SceneProjection,
  type SceneRecoveryReason,
  type SceneResumeControl,
  type SceneTransientCue,
} from "@clockgrove/contracts";
import { OwnerMailboxError } from "./mailbox.js";
import type { SceneAudienceDecision } from "./scene-audience.js";

/** Engineering budgets: one existing four-command owner activation's worth of outstanding frames
 * and lag turns (`OWNER_ACTIVATION_BUDGET` in owner-activation.ts).
 * Each connection retains one replaceable projection; the PostgreSQL reader bounds history separately.
 */
export const SCENE_DELIVERY_BOUNDS = { unacknowledged: 4, lagTurns: 4 } as const;

/**
 * Resident scene sockets one SpaceDO admits. Decisions:
 * - `perSpace` 256: a commit's fanout reads once per decided audience and cursor, one owner mailbox entry at
 *   a time; at the 41 to 43 ms an entry measured for `SPACE_MAILBOX_BOUNDS`, 256 distinct audiences
 *   drain in about 11 s, inside its 30 s request deadline.
 * - `perPrincipal` 4: one principal's sockets share their reads, so the cap bounds frames and
 *   memory. Four holds a few tabs and a reconnect overlapping its closing socket; 64 principals fill
 *   a space.
 */
export const SCENE_SOCKET_BOUNDS = { perSpace: 256, perPrincipal: 4 } as const;

export interface SceneSocket {
  deserializeAttachment(): unknown;
  serializeAttachment(value: SceneConnectionAttachment): void;
  send(message: string): void;
  close(code: number, reason: string): void;
}
export interface SceneReadResult {
  readonly projection: SceneProjection;
  readonly patch: ScenePatch | null;
  /** The canonical routing epoch the read observed, which is the scene authority epoch. */
  readonly authorityEpoch: bigint;
  /** The server's audience decision, made before the projection was built. */
  readonly decision: SceneAudienceDecision;
}
/** A principal's current authority; equal keys decide equal audiences whoever the principal is. */
export interface SceneAuthority {
  readonly key: string;
}
/**
 * One fanout turn's shared work: one authority lookup per principal and interest, one read per
 * decided-audience key and cursor, and one encoding per distinct audience frame.
 */
export interface SceneReads {
  readonly authorities: Map<string, Promise<SceneAuthority>>;
  readonly reads: Map<string, Promise<SceneReadResult>>;
  readonly frames: Map<string, string>;
  /** Measurement accumulators, flushed and reset by `SceneDelivery.measure`. */
  recipients: number;
  readonly sent: Record<"snapshot" | "patch", { bytes: number; frames: number }>;
  readonly audiences: Record<"public_scene" | "private_cognition", number>;
  currentRevision: bigint | undefined;
  scope: { readonly tenantId: string; readonly worldId: string } | undefined;
}
export function sceneReads(): SceneReads {
  return {
    authorities: new Map(),
    reads: new Map(),
    frames: new Map(),
    recipients: 0,
    sent: { snapshot: { bytes: 0, frames: 0 }, patch: { bytes: 0, frames: 0 } },
    audiences: { public_scene: 0, private_cognition: 0 },
    currentRevision: undefined,
    scope: undefined,
  };
}

/** Typed reasons only: an unexpected failure is internal, and its detail stays in the log. */
function refusal(error: unknown): SceneDisconnectReason {
  return error instanceof AuthorizationRefusedError || error instanceof JournalRouteNotFoundError
    ? "unauthorized"
    : "internal_error";
}
/** Replace visible fields, removing obsolete public identities when a live baseline exists. */
export function scenePatchOperations(
  projection: SceneProjection,
  previous?: SceneProjection,
): ScenePatchOperation[] {
  const replacement: ScenePatchOperation[] = [
    ...projection.frames.map((frame): ScenePatchOperation => ({ op: "upsert_frame", frame })),
    ...projection.entities.map((entity): ScenePatchOperation => ({ op: "upsert_entity", entity })),
    ...projection.hierarchy.map((space): ScenePatchOperation => ({ op: "upsert_space", space })),
    ...projection.presentationBindings.map(
      (binding): ScenePatchOperation => ({ op: "upsert_presentation", binding }),
    ),
    ...projection.interactions.map(
      (interaction): ScenePatchOperation => ({ op: "upsert_interaction", interaction }),
    ),
    { op: "set_clock", simulationTime: projection.simulationTime },
    { op: "set_weather", weather: projection.weather },
    { op: "set_effects", effects: projection.effects ?? [] },
    { op: "set_feed_cursor", feedCursor: projection.feedCursor },
    { op: "set_compatibility", compatibility: projection.compatibility },
    ...(projection.privateCognition === undefined
      ? []
      : [
          {
            op: "set_private_cognition",
            entries: projection.privateCognition,
          } satisfies ScenePatchOperation,
        ]),
  ];
  if (previous === undefined) return replacement;
  const entities = new Set(projection.entities.map((entity) => entity.objectId));
  const frames = new Set(projection.frames.map((frame) => frame.frameId));
  const spaces = new Set(projection.hierarchy.map((space) => space.spaceId));
  const presentations = new Set(projection.presentationBindings.map((binding) => binding.objectId));
  const interactions = new Set(projection.interactions.map((interaction) => interaction.entityId));
  return [
    ...previous.entities
      .filter((entity) => !entities.has(entity.objectId))
      .map((entity): ScenePatchOperation => ({ op: "remove_entity", objectId: entity.objectId })),
    ...previous.presentationBindings
      .filter((binding) => !presentations.has(binding.objectId))
      .map(
        (binding): ScenePatchOperation => ({
          op: "remove_presentation",
          objectId: binding.objectId,
        }),
      ),
    ...previous.interactions
      .filter((interaction) => !interactions.has(interaction.entityId))
      .map(
        (interaction): ScenePatchOperation => ({
          op: "remove_interaction",
          objectId: interaction.entityId,
        }),
      ),
    ...replacement,
    ...previous.frames
      .filter((frame) => !frames.has(frame.frameId))
      .map((frame): ScenePatchOperation => ({ op: "remove_frame", frameId: frame.frameId })),
    ...previous.hierarchy
      .filter((space) => !spaces.has(space.spaceId))
      .map((space): ScenePatchOperation => ({ op: "remove_space", spaceId: space.spaceId })),
  ];
}
interface DeliveryIntent {
  readonly attachment: SceneConnectionAttachment;
  readonly delivered: bigint[];
  debt: number;
  lastSent: bigint | null;
  projection: SceneProjection | undefined;
  pending: boolean;
  dirty: boolean;
  lagTurns: number;
  /** The fanout turn whose read last decided an audience including the operator interest. */
  operator: SceneReads | undefined;
  /** Each unacknowledged sent revision's audience hash, and the acknowledged revision's. */
  readonly audiences: Map<bigint, string>;
  acknowledgedAudience: string | undefined;
}

/** Rebuildable connection work. Attachments are the only durable recovery hints. */
export class SceneDelivery<A extends SceneAuthority = SceneAuthority> {
  private intents = new WeakMap<SceneSocket, DeliveryIntent>();
  /** Sockets this incarnation admitted that have not resumed yet. */
  private fresh = new WeakSet<SceneSocket>();
  /** Sockets this incarnation dropped on purpose: unlike memory loss, they are never restored. */
  private retired = new WeakSet<SceneSocket>();
  /** Each socket's authority epoch: its admission's, or after memory loss the first one read. */
  private epochs = new WeakMap<SceneSocket, bigint>();
  constructor(
    private readonly authorize: (attachment: SceneConnectionAttachment) => Promise<A>,
    private readonly read: (
      attachment: SceneConnectionAttachment,
      authority: A,
      from: bigint | null,
    ) => Promise<SceneReadResult>,
    private readonly obsoleteError: (error: unknown) => void,
    private readonly metrics: () => RuntimeMetrics = () => NO_METRICS,
  ) {}

  /** Admission times of sockets that have not yet been sent their first projection frame. */
  private admissions = new WeakMap<SceneSocket, number>();

  private scopeOf(socket: SceneSocket) {
    try {
      const { tenantId, worldId } = decodeSceneConnectionAttachment(
        socket.deserializeAttachment(),
      ).audience;
      return { tenantId, worldId };
    } catch {
      return undefined;
    }
  }

  /**
   * Records one fanout turn's aggregates, then resets them so a repeat call records nothing.
   * Points are aggregated per turn, not per socket: Workers Analytics Engine accepts at most 250
   * data points per invocation and a space holds up to `SCENE_SOCKET_BOUNDS.perSpace` (256) sockets.
   */
  measure(turn: SceneReads, operatorRecipients = 0): void {
    const scope = turn.scope;
    if (scope !== undefined) {
      const metrics = this.metrics();
      const point = (
        name:
          | "scene_revision"
          | "scene_patch_bytes"
          | "scene_fanout_recipients"
          | "scene_audience_decisions",
        label: string,
        value: number,
        count?: number,
      ) => {
        if (value === 0 && !(name === "scene_patch_bytes" && count)) return;
        recordMetric(metrics, { name, ...scope, label, value, count } as never);
      };
      if (turn.currentRevision !== undefined)
        point("scene_revision", "current", Number(turn.currentRevision));
      for (const type of ["snapshot", "patch"] as const)
        if (turn.sent[type].frames > 0)
          point("scene_patch_bytes", type, turn.sent[type].bytes, turn.sent[type].frames);
      point("scene_fanout_recipients", "projection", turn.recipients);
      point("scene_fanout_recipients", "operator", operatorRecipients);
      for (const label of ["public_scene", "private_cognition"] as const)
        point("scene_audience_decisions", label, turn.audiences[label]);
    }
    turn.recipients = 0;
    turn.sent.snapshot = { bytes: 0, frames: 0 };
    turn.sent.patch = { bytes: 0, frames: 0 };
    turn.audiences.public_scene = 0;
    turn.audiences.private_cognition = 0;
    turn.currentRevision = undefined;
  }

  /**
   * Forgets every connection's runtime state, fencing even unfinished reads, as owner or code
   * replacement does. Production loses this state with its incarnation and never calls this; the
   * native test worker calls it to model that memory loss against still-resident sockets.
   */
  reset(): void {
    this.intents = new WeakMap();
    this.fresh = new WeakSet();
    this.retired = new WeakSet();
    this.epochs = new WeakMap();
    this.admissions = new WeakMap();
  }

  /** A socket this incarnation accepted: it receives nothing until it resumes. */
  admitted(socket: SceneSocket, authorityEpoch: bigint): void {
    this.fresh.add(socket);
    this.epochs.set(socket, authorityEpoch);
    this.admissions.set(socket, Date.now());
  }

  /** A changed authority epoch ends a socket admitted under the old one: it must rejoin. */
  private stale(socket: SceneSocket, result: SceneReadResult): boolean {
    const epoch = this.epochs.get(socket);
    if (epoch === undefined) this.epochs.set(socket, result.authorityEpoch);
    if (epoch === undefined || epoch === result.authorityEpoch) return false;
    this.disconnect(socket, "stale_authority_epoch");
    return true;
  }

  private async readFor(
    attachment: SceneConnectionAttachment,
    from: bigint | null,
    turn: SceneReads | undefined,
  ): Promise<SceneReadResult> {
    if (turn === undefined) return this.read(attachment, await this.authorize(attachment), from);
    // Every principal's own membership is checked; only then do equal audiences share a read.
    const principal = JSON.stringify([attachment.principalId, attachment.audience]);
    let authorized = turn.authorities.get(principal) as Promise<A> | undefined;
    if (authorized === undefined) {
      authorized = this.authorize(attachment);
      turn.authorities.set(principal, authorized);
    }
    const authority = await authorized;
    const key = JSON.stringify([authority.key, from?.toString() ?? null]);
    let read = turn.reads.get(key);
    if (read === undefined) {
      read = this.read(attachment, authority, from);
      turn.reads.set(key, read);
    }
    return read;
  }

  private current(socket: SceneSocket, intent: DeliveryIntent): boolean {
    return this.intents.get(socket) === intent;
  }

  private intend(
    socket: SceneSocket,
    attachment: SceneConnectionAttachment,
    debt: number,
  ): DeliveryIntent {
    const intent: DeliveryIntent = {
      attachment,
      delivered: [],
      debt,
      lastSent: null,
      projection: undefined,
      pending: false,
      dirty: false,
      lagTurns: 0,
      operator: undefined,
      audiences: new Map(),
      // After memory loss the attachment alone knows which audience the client acknowledged.
      acknowledgedAudience: attachment.acknowledgedAudienceHash,
    };
    this.fresh.delete(socket);
    this.retired.delete(socket);
    this.intents.set(socket, intent);
    return intent;
  }

  async resume(socket: SceneSocket, control: SceneResumeControl): Promise<void> {
    const stored = decodeSceneConnectionAttachment(socket.deserializeAttachment());
    const previous = this.intents.get(socket);
    const debt = previous === undefined ? 0 : previous.debt + previous.delivered.length;
    if (debt >= SCENE_DELIVERY_BOUNDS.unacknowledged) {
      this.backpressure(socket);
      return;
    }
    const replacing = previous !== undefined;
    const attachment = {
      ...stored,
      connectionVersion: stored.connectionVersion + (replacing ? 1 : 0),
    };
    const intent = this.intend(socket, attachment, debt);
    if (previous !== undefined) intent.acknowledgedAudience = previous.acknowledgedAudience;
    socket.serializeAttachment(attachment);
    // A client sent a changed audience has discarded its acknowledged state: only a snapshot helps.
    const changed =
      previous?.projection !== undefined &&
      previous.projection.audienceHash !== previous.acknowledgedAudience;
    await this.deliver(
      socket,
      intent,
      changed ? null : (stored.acknowledgedRevision ?? control.lastAppliedRevision),
    );
  }

  async acknowledge(socket: SceneSocket, control: SceneAcknowledgementControl): Promise<void> {
    const intent = this.intents.get(socket);
    if (intent === undefined && !this.fresh.has(socket) && !this.retired.has(socket)) {
      const stored = decodeSceneConnectionAttachment(socket.deserializeAttachment());
      if (
        control.connectionVersion === stored.connectionVersion &&
        (stored.acknowledgedRevision === null || control.revision > stored.acknowledgedRevision)
      ) {
        // Memory loss dropped the delivery ledger, not the delivery: the PostgreSQL read bounds
        // the acknowledged revision instead, then delivery continues from it.
        await this.deliver(socket, this.intend(socket, stored, 0), control.revision, true);
        return;
      }
    }
    if (
      intent === undefined ||
      control.connectionVersion !== intent.attachment.connectionVersion ||
      !intent.delivered.includes(control.revision)
    ) {
      this.notify(socket, "revision_unavailable");
      return;
    }
    const audience = intent.audiences.get(control.revision);
    if (!this.record(socket, control, audience)) return;
    const scope = this.scopeOf(socket);
    if (scope !== undefined)
      recordMetric(this.metrics(), {
        name: "scene_revision",
        ...scope,
        label: "acknowledged",
        value: Number(control.revision),
      });
    intent.delivered.splice(0, intent.delivered.indexOf(control.revision) + 1);
    intent.acknowledgedAudience = audience;
    for (const revision of intent.audiences.keys())
      if (revision <= control.revision) intent.audiences.delete(revision);
    intent.lagTurns = 0;
    intent.debt = 0;
    await this.flush(socket, intent);
  }

  /**
   * Stores an acknowledgement on its own connection version, never moving the cursor back, with
   * the acknowledged frame's audience hash when known; an unknown one keeps the stored hash.
   */
  private record(
    socket: SceneSocket,
    control: { revision: bigint; connectionVersion: number },
    audience?: string,
  ) {
    const stored = decodeSceneConnectionAttachment(socket.deserializeAttachment());
    if (stored.connectionVersion !== control.connectionVersion) return false;
    if (stored.acknowledgedRevision === null || control.revision > stored.acknowledgedRevision)
      socket.serializeAttachment({
        ...stored,
        acknowledgedRevision: control.revision,
        ...(audience === undefined ? {} : { acknowledgedAudienceHash: audience }),
      });
    return true;
  }

  /** `reads` shares one fanout turn's reads between sockets with the same audience and cursor. */
  async publish(socket: SceneSocket, reads?: SceneReads): Promise<void> {
    const intent = this.intents.get(socket);
    if (intent === undefined) {
      // A fresh upgrade has not declared compatibility or a recovery cursor yet; a retired socket
      // was already told to reconnect.
      if (this.fresh.has(socket) || this.retired.has(socket)) return;
      const stored = decodeSceneConnectionAttachment(socket.deserializeAttachment());
      if (stored.acknowledgedRevision === null) {
        // Memory loss dropped whatever this socket was sent before its first acknowledgement.
        this.notify(socket, "runtime_restarted");
        return;
      }
      // Native hibernation lost the delivery ledger. Re-establish it using the stored connection version.
      await this.resume(socket, {
        protocolVersion: 1,
        type: "resume",
        lastAppliedRevision: stored.acknowledgedRevision,
        assetManifestVersion: 1,
      });
      return;
    }
    const full = intent.debt + intent.delivered.length >= SCENE_DELIVERY_BOUNDS.unacknowledged;
    if (intent.pending || full) {
      // No audience is decided for this socket this turn, so the operator lane skips it.
      intent.dirty = true;
      // Only a full frame ledger is the client's lag; a pending read is the server's own latency.
      if (full) intent.lagTurns += 1;
      if (intent.lagTurns >= SCENE_DELIVERY_BOUNDS.lagTurns) this.backpressure(socket);
      return;
    }
    await this.deliver(socket, intent, intent.lastSent, false, reads);
  }

  private async flush(socket: SceneSocket, intent: DeliveryIntent): Promise<void> {
    if (
      this.current(socket, intent) &&
      intent.dirty &&
      !intent.pending &&
      intent.debt + intent.delivered.length < SCENE_DELIVERY_BOUNDS.unacknowledged
    ) {
      intent.dirty = false;
      await this.deliver(socket, intent, intent.lastSent);
    }
  }

  /** With `acknowledged`, `from` is a restored acknowledgement the read must not be behind. */
  private async deliver(
    socket: SceneSocket,
    intent: DeliveryIntent,
    from: bigint | null,
    acknowledged = false,
    reads?: SceneReads,
  ): Promise<void> {
    intent.pending = true;
    // Without a fanout turn the delivery is accounted alone; the turn is never shared for reads.
    const accounting = reads ?? sceneReads();
    try {
      const result = await this.readFor(intent.attachment, from, reads);
      const projection = result.projection;
      let patch = result.patch;
      if (!this.current(socket, intent) || this.stale(socket, result)) return;
      const { tenantId, worldId } = intent.attachment.audience;
      accounting.scope = { tenantId, worldId };
      if (
        accounting.currentRevision === undefined ||
        projection.revision > accounting.currentRevision
      )
        accounting.currentRevision = projection.revision;
      accounting.audiences[
        result.decision.descriptor.privacyCategories.includes("private_cognition")
          ? "private_cognition"
          : "public_scene"
      ] += 1;
      // The audience the client holds: its live projection's, else its acknowledged frame's.
      const held = intent.projection?.audienceHash ?? intent.acknowledgedAudience;
      // A changed audience (grant, ceiling or interest) never patches the prior audience's state,
      // even across memory loss, and is snapshotted even at an unchanged revision.
      const changed = held !== undefined && held !== projection.audienceHash;
      if (changed) patch = null;
      if (acknowledged && from !== null) {
        if (projection.revision < from) {
          this.forget(socket);
          this.notify(socket, "revision_unavailable");
          return;
        }
        this.record(socket, {
          revision: from,
          connectionVersion: intent.attachment.connectionVersion,
        });
        intent.lastSent = from;
        if (projection.revision === from && !changed) intent.projection = projection;
      }
      if (reads !== undefined)
        intent.operator = result.decision.descriptor.interest.operator ? reads : undefined;
      if (projection.revision === intent.lastSent && !changed) return;
      const previous = intent.projection;
      if (
        patch === null &&
        previous !== undefined &&
        previous.revision === from &&
        previous.revision < projection.revision &&
        previous.audienceHash === projection.audienceHash &&
        previous.compatibility.assetManifestVersion ===
          projection.compatibility.assetManifestVersion &&
        previous.compatibility.clientVersion === projection.compatibility.clientVersion &&
        previous.compatibility.projectionVersion === projection.compatibility.projectionVersion
      ) {
        // Live convergence needs only the previous authorized projection and the current PostgreSQL
        // observation. Empty provenance avoids inventing event identities beyond the history budget.
        patch = {
          fromRevision: previous.revision,
          toRevision: projection.revision,
          operations: scenePatchOperations(projection, previous),
          sourceEventIds: [],
          audienceHash: projection.audienceHash,
        };
      }
      const base = {
        protocolVersion: 1 as const,
        tenantId: projection.tenantId,
        worldId: projection.worldId,
        timelineId: projection.timelineId,
        spaceId: projection.spaceId,
        messageId: crypto.randomUUID(),
        sentAt: new Date().toISOString(),
        projectionRevision: projection.revision,
        lane: "projection" as const,
      };
      if (patch === null) this.notify(socket, "snapshot_required");
      // Equal audience frames are encoded once per turn and shared, never re-serialized per socket.
      const frame = JSON.stringify([
        projection.audienceHash,
        projection.revision.toString(),
        patch?.fromRevision.toString() ?? null,
        patch?.sourceEventIds ?? null,
      ]);
      let wire = reads?.frames.get(frame);
      if (wire === undefined) {
        const message: ObserverSceneMessage =
          patch === null
            ? { ...base, type: "snapshot", payload: projection }
            : { ...base, type: "patch", payload: patch };
        wire = encodeObserverSceneMessage(message);
        reads?.frames.set(frame, wire);
      }
      socket.send(wire);
      const type = patch === null ? "snapshot" : "patch";
      accounting.recipients += 1;
      accounting.sent[type].bytes += wire.length;
      accounting.sent[type].frames += 1;
      const admittedAt = this.admissions.get(socket);
      if (admittedAt !== undefined) {
        this.admissions.delete(socket);
        recordMetric(this.metrics(), {
          name: "scene_handshake_ms",
          tenantId,
          worldId,
          label: type,
          value: Date.now() - admittedAt,
        });
      }
      intent.lastSent = projection.revision;
      intent.projection = projection;
      intent.delivered.push(projection.revision);
      intent.audiences.set(projection.revision, projection.audienceHash);
    } catch (error) {
      if (!this.current(socket, intent)) {
        this.obsoleteError(error);
        return;
      }
      // Every mailbox refusal is retryable: the client reconnects after its backoff and resumes.
      if (error instanceof OwnerMailboxError) {
        this.backpressure(socket);
        return;
      }
      this.disconnect(socket, refusal(error));
      throw error;
    } finally {
      if (reads === undefined) this.measure(accounting);
      if (this.current(socket, intent)) {
        intent.pending = false;
        await this.flush(socket, intent);
      }
    }
  }

  /** Transient presentation never queues behind projection recovery or survives its expiration. */
  async cue(socket: SceneSocket, cue: SceneTransientCue, now = Date.now()): Promise<void> {
    const intent = this.intents.get(socket);
    if (
      intent === undefined ||
      intent.pending ||
      intent.debt + intent.delivered.length >= SCENE_DELIVERY_BOUNDS.unacknowledged ||
      Date.parse(cue.expiresAt) <= now
    )
      return;
    intent.pending = true;
    try {
      const result = await this.readFor(intent.attachment, null, undefined);
      const { projection } = result;
      if (
        !this.current(socket, intent) ||
        this.stale(socket, result) ||
        Date.parse(cue.expiresAt) <= Date.now() ||
        !projection.entities.some((entity) => entity.objectId === cue.objectId)
      )
        return;
      socket.send(
        encodeObserverSceneMessage({
          protocolVersion: 1,
          messageId: crypto.randomUUID(),
          sentAt: new Date(now).toISOString(),
          tenantId: projection.tenantId,
          worldId: projection.worldId,
          timelineId: projection.timelineId,
          spaceId: projection.spaceId,
          lane: "transient",
          type: "cue",
          payload: cue,
        }),
      );
    } catch (error) {
      if (!this.current(socket, intent)) {
        this.obsoleteError(error);
        return;
      }
      // A cue may be dropped, so a retryable mailbox refusal costs only this cue.
      if (error instanceof OwnerMailboxError) return;
      this.disconnect(socket, refusal(error));
      throw error;
    } finally {
      if (this.current(socket, intent)) {
        intent.pending = false;
        await this.flush(socket, intent);
      }
    }
  }

  /**
   * Operator-lane diagnostics reach only a socket whose audience, decided in this fanout turn,
   * includes them: a socket whose read the turn skipped waits for its next decision.
   */
  operate(socket: SceneSocket, wire: string, turn: SceneReads): boolean {
    const intent = this.intents.get(socket);
    if (intent === undefined || intent.operator !== turn) return false;
    socket.send(wire);
    return true;
  }

  private notify(socket: SceneSocket, reason: SceneRecoveryReason): void {
    const scope = this.scopeOf(socket);
    if (scope !== undefined)
      recordMetric(this.metrics(), { name: "scene_recovery", ...scope, label: reason, value: 1 });
    socket.send(encodeSceneConnectionControl({ protocolVersion: 1, type: "recovery", reason }));
  }

  private backpressure(socket: SceneSocket): void {
    this.notify(socket, "backpressure");
    this.forget(socket);
    socket.close(1013, "backpressure");
  }

  disconnect(socket: SceneSocket, reason: SceneDisconnectReason): void {
    this.forget(socket);
    socket.send(encodeSceneConnectionControl({ protocolVersion: 1, type: "disconnect", reason }));
    socket.close(reason === "internal_error" ? 1011 : 1008, reason);
  }
  forget(socket: SceneSocket): void {
    this.intents.delete(socket);
    this.retired.add(socket);
  }
}
