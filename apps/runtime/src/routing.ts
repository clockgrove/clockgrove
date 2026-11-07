import type { RunId, SubjectId } from "@clockgrove/contracts";

import type { RuntimeScope } from "./types.js";

export type RuntimeOwnerKind = "world" | "space" | "actor-agent";

/** The route-name derivation and visible name format versions (runtime.md, route-name version policy). */
export const ROUTE_VERSION = "clockgrove-route-v1";
export const ROUTE_NAME_PREFIX = "v1";
const WORKFLOW_VERSION = "clockgrove-workflow-v1";

/**
 * The Durable Object name of each owner kind. Each kind's ID tuple is written only here, and every
 * route call site uses this function, so the golden route vectors pin every tuple.
 */
export async function runtimeRouteName(
  kind: RuntimeOwnerKind,
  scope: RuntimeScope,
  subjectId?: SubjectId,
): Promise<string> {
  const { tenantId, worldId, timelineId, spaceId } = scope;
  switch (kind) {
    case "world":
      return stableRuntimeRouteName(kind, [tenantId, worldId, timelineId]);
    case "space":
      return stableRuntimeRouteName(kind, [tenantId, worldId, timelineId, spaceId]);
    case "actor-agent":
      if (subjectId === undefined) throw new Error("actor-agent route requires subjectId");
      return stableRuntimeRouteName(kind, [tenantId, worldId, timelineId, subjectId]);
  }
}

/**
 * Pure, versioned route-name derivation. Length-prefixing prevents tuple
 * ambiguity; only opaque IDs enter the digest. Call sites use `runtimeRouteName`.
 */
export async function stableRuntimeRouteName(
  kind: RuntimeOwnerKind,
  opaqueIds: readonly string[],
): Promise<string> {
  return `${ROUTE_NAME_PREFIX}-${kind}-${await sha256Hex(frame(ROUTE_VERSION, kind, ...opaqueIds))}`;
}

export async function stableWorkflowInstanceId(workflow: string, runId: RunId): Promise<string> {
  return `v1-${workflow}-${await sha256Hex(frame(WORKFLOW_VERSION, workflow, runId))}`;
}

function frame(...parts: readonly string[]): string {
  return parts.map((part) => `${new TextEncoder().encode(part).byteLength}:${part}`).join("|");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
