import {
  SCENE_CLIENT_VERSION,
  SCENE_PROJECTION_VERSION,
  SCENE_PROTOCOL_VERSION,
} from "@clockgrove/contracts";

/**
 * The browser client measurements (Wave 4 plan §17), each with its closed category list. Points
 * carry opaque ids and action categories only: no labels, names, text, principal ids or payloads.
 * Telemetry is not canonical: a lost point changes nothing.
 */
export const CLIENT_MEASUREMENTS = {
  reducer_latency_ms: ["snapshot", "patch", "control"],
  scene_apply_ms: ["snapshot", "patch"],
  dropped_cues: ["expired", "unknown_entity", "duplicate"],
  frame_ms: ["p95"],
  asset_cache: ["loaded", "failed"],
  interaction_outcome: ["accepted", "refused", "failed"],
  inspector_traversal: ["command", "event", "schedule", "view"],
  accessibility_mode: ["canvas", "text", "reduced_motion"],
  client_errors: ["socket", "renderer", "asset", "context_lost", "query", "shell"],
  scene_recovery: ["gap", "reconnect", "snapshot_fallback"],
} as const;

export type ClientMeasurementName = keyof typeof CLIENT_MEASUREMENTS;

export type ClientMeasurement = {
  [N in ClientMeasurementName]: {
    readonly name: N;
    readonly category: (typeof CLIENT_MEASUREMENTS)[N][number];
    readonly value: number;
    /** The client, protocol and projection versions this build speaks. */
    readonly release: string;
    /** The content hash of the loaded asset manifest, or `unloaded` before it is known. */
    readonly worldPack: string;
    readonly worldId?: string;
    /** Only on `asset_cache` points. */
    readonly assetHash?: string;
  };
}[ClientMeasurementName];

export interface ClientMeasurementSink {
  record(point: ClientMeasurement): void;
}

export const CLIENT_RELEASE = `client${SCENE_CLIENT_VERSION}.protocol${SCENE_PROTOCOL_VERSION}.projection${SCENE_PROJECTION_VERSION}`;

// Decision: bounded so a long session cannot grow memory; 512 covers a qualification journey's points.
const MAX_POINTS = 512;

class MeasurementRing implements ClientMeasurementSink {
  private ring: ClientMeasurement[] = [];
  private worldId: string | undefined;
  private worldPack = "unloaded";
  record(point: ClientMeasurement): void {
    this.ring.push(point);
    if (this.ring.length > MAX_POINTS) this.ring.shift();
  }
  points(): ClientMeasurement[] {
    return [...this.ring];
  }
  setWorld(world: { worldId?: string; worldPack?: string }): void {
    if (world.worldId !== undefined) this.worldId = world.worldId;
    if (world.worldPack !== undefined) this.worldPack = world.worldPack;
  }
  identity(): { worldPack: string; worldId?: string } {
    return this.worldId === undefined
      ? { worldPack: this.worldPack }
      : { worldPack: this.worldPack, worldId: this.worldId };
  }
}

export const clientMeasurements = new MeasurementRing();

let sink: ClientMeasurementSink = clientMeasurements;

/** Routes points to another sink; the default ring is restored with `clientMeasurements`. */
export function useMeasurementSink(next: ClientMeasurementSink): void {
  sink = next;
}

export function measure<N extends ClientMeasurementName>(
  name: N,
  category: (typeof CLIENT_MEASUREMENTS)[N][number],
  value = 1,
  extra: { assetHash?: string } = {},
): void {
  measurePoint({ name, category, value, ...extra });
}

/** Records a point from a caller that holds the name, category and value together. */
export function measurePoint(point: {
  readonly name: ClientMeasurementName;
  readonly category: string;
  readonly value: number;
  readonly assetHash?: string;
}): void {
  try {
    sink.record({
      name: point.name,
      category: point.category,
      value: point.value,
      release: CLIENT_RELEASE,
      ...clientMeasurements.identity(),
      ...(point.name === "asset_cache" && point.assetHash !== undefined
        ? { assetHash: point.assetHash }
        : {}),
    } as ClientMeasurement);
  } catch {
    // Telemetry is not canonical.
  }
}

/** Runs `run` and records its wall time as a latency point. */
export function timed<N extends "reducer_latency_ms" | "scene_apply_ms", T>(
  name: N,
  category: (typeof CLIENT_MEASUREMENTS)[N][number],
  run: () => T,
): T {
  const started = performance.now();
  try {
    return run();
  } finally {
    measure(name, category, performance.now() - started);
  }
}
