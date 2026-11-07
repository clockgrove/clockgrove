import { NO_METRICS, type RuntimeMetrics } from "@clockgrove/application";

/** Workers Analytics Engine dataset binding (only the write used here). */
export interface AnalyticsEngineDataset {
  writeDataPoint(point: {
    readonly blobs: readonly string[];
    readonly doubles: readonly number[];
    readonly indexes: readonly string[];
  }): void;
}

/**
 * Writes each metric as one data point: blobs [name, tenant, world, label], doubles [value, count],
 * index tenant. The index is Analytics Engine's sampling key, so a busy tenant is sampled without
 * sampling others; query with `_sample_interval` weights. Writes are fire-and-forget and telemetry is
 * not canonical, so a refused write is dropped rather than failing the command.
 */
export function analyticsEngineMetrics(
  dataset: AnalyticsEngineDataset | undefined,
): RuntimeMetrics {
  if (dataset === undefined) return NO_METRICS;
  return {
    record(point) {
      try {
        dataset.writeDataPoint({
          blobs: [point.name, point.tenantId, point.worldId, point.label],
          doubles: [point.value, point.count ?? 0],
          indexes: [point.tenantId],
        });
      } catch {
        /* Dropped: the inspector reads canonical tables and needs no telemetry. */
      }
    },
  };
}
