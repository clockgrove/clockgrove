// Routing metadata of a hosted environment manifest. The zero account/zone IDs and example.org
// domains are publication-safe placeholders: an environment still carrying one is not configured.
// Dependency-free, so the release selector can read it before any install.
import assert from "node:assert/strict";

export function missingRoutingMetadata(config) {
  return [
    ...Object.entries(config.safeIds).filter(([, value]) => /^0+$/u.test(value)),
    ...Object.entries(config.domains).filter(([, value]) => /(?:^|\.)example\.org$/u.test(value)),
  ].map(([name]) => name);
}

export function assertRoutingMetadata(config, target) {
  const [missing] = missingRoutingMetadata(config);
  assert(!missing, `missing routing metadata ${target}.${missing}`);
}
