import {
  type BrowserScope,
  decodeBrowserScope,
  decodeWorldModeState,
  type WorldMode,
} from "./browser-protocol.js";
import { ContractDecodeError, exactKeys, record } from "./validation.js";

// World modes: see docs/protocols/usage.md, "World modes". The mode itself is part of the world's
// status (`WorldModeState` in browser-protocol.ts), which every observer reads.

/** Sets the mode of the caller's space. */
export interface WorldModeRequest {
  readonly version: 1;
  readonly scope: BrowserScope;
  readonly mode: WorldMode;
  readonly reason: string | null;
}

export function decodeWorldModeRequest(value: unknown): WorldModeRequest {
  const path = "worldMode";
  const v = record(value, path);
  exactKeys(
    v,
    ["version", "tenantId", "worldId", "timelineId", "spaceId", "mode", "reason"],
    [],
    path,
  );
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  const scope = decodeBrowserScope({ tenantId, worldId, timelineId, spaceId });
  return Object.freeze({
    version: 1,
    scope,
    ...decodeWorldModeState({ mode: v.mode, reason: v.reason }, path),
  });
}
