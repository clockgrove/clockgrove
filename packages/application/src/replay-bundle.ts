import type { PrincipalId, PrivacyClass, StreamId } from "@clockgrove/contracts";
import {
  CANONICAL_ENCODING_VERSION,
  canonicalBytes,
  canonicalSerialize,
  sha256Hex,
} from "@clockgrove/kernel";

import type { ArtifactScope } from "./artifacts.js";
import { CanonicalNodeError, decodeCanonicalNode } from "./canonical-node.js";
import { JOURNAL_EVENT_REGISTRY } from "./event-registry.js";
import type { JournalRangeSource, SequenceRange } from "./journal-reader.js";
import { JournalRangeReader } from "./journal-reader.js";
import { replayBirth, replayPartition } from "./partition-replay.js";
import { plainValue } from "./partition-state.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";
import type { PartitionSnapshotStore, SnapshotCompatibility } from "./snapshots.js";
import { snapshotCompatibility } from "./snapshots.js";
import type { BirthSeedResource, BirthState, DecodeResource } from "./world-birth.js";
import type { WorldPartitionScope } from "./world-command.js";
import type { WorldProvisioningStore } from "./world-provisioning-ports.js";

export const REPLAY_BUNDLE_VERSION = 1;
const BUNDLE_KIND = "clockgrove.replay-bundle";
const EXPORT_PAGE = 2_000n;

export interface ReplayBundleSections {
  /** Lowercase hex SHA-256 of the canonical bytes of the birth section and of the events section. */
  readonly birth: string;
  readonly events: string;
  readonly eventCount: number;
}

/** What a bundle claims. Its canonical bytes hash to the bundle ID. */
export interface ReplayBundleManifest {
  readonly scope: ArtifactScope & { readonly streamId: StreamId };
  readonly head: { readonly partitionSequence: bigint };
  readonly compatibility: SnapshotCompatibility;
  /** The classes of the exported events; v1 never redacts, so nothing is omitted. */
  readonly privacy: {
    readonly included: readonly PrivacyClass[];
    readonly omitted: readonly PrivacyClass[];
  };
  readonly expected: { readonly finalStateHash: string };
  readonly sections: ReplayBundleSections;
}

/** The stored birth, with each seed resource's bytes in lowercase hex. */
export interface ReplayBundleBirth {
  readonly birth: BirthState;
  readonly seedResources: readonly (Omit<BirthSeedResource, "bytes"> & {
    readonly bytes: string;
  })[];
}

/** Format v1: one partition of one timeline, from its birth through its committed head. */
export interface ReplayBundle {
  readonly manifest: ReplayBundleManifest;
  readonly birth: ReplayBundleBirth;
  /** The partition's stored event bytes, sequence 1 through the head, as UTF-8 text. */
  readonly events: readonly string[];
}

export interface ReplayBundleExportPorts {
  readonly snapshots: Pick<PartitionSnapshotStore, "readCommitted">;
  /** Reads under the exporting principal's authorization; a hidden row leaves a gap. */
  readonly events: JournalRangeSource;
  readonly birth: Pick<WorldProvisioningStore, "readBirth">;
}

export interface ReplayBundleVerification {
  readonly bundleId: string;
  readonly finalStateHash: string;
  readonly eventsApplied: number;
  readonly coveredPartitionSequence: bigint;
  readonly privacy: ReplayBundleManifest["privacy"];
}

export type ReplayBundleIntegrityReason = "malformed" | "section-hash" | "final-state" | "privacy";

/** The bundle is not format v1, a section does not hash to its manifest, or replay disagrees with it. */
export class ReplayBundleIntegrityError extends Error {
  constructor(
    readonly reason: ReplayBundleIntegrityReason,
    options?: ErrorOptions,
  ) {
    super(`replay bundle failed verification (${reason})`, options);
    this.name = "ReplayBundleIntegrityError";
  }
}

/** The bundle was written under a different compatibility set than this verifier's. */
export class ReplayBundleIncompatibleError extends Error {
  constructor(readonly field: keyof SnapshotCompatibility) {
    super(`replay bundle is incompatible: ${field}`);
    this.name = "ReplayBundleIncompatibleError";
  }
}

export function replayBundleSections(
  birth: ReplayBundleBirth,
  events: readonly string[],
): ReplayBundleSections {
  return {
    birth: sha256Hex(canonicalBytes(birth)),
    events: sha256Hex(canonicalBytes(events)),
    eventCount: events.length,
  };
}

export const replayBundleId = (manifest: ReplayBundleManifest): string =>
  sha256Hex(canonicalBytes(manifest));

export function encodeReplayBundle(bundle: ReplayBundle): Uint8Array {
  return canonicalBytes({ kind: BUNDLE_KIND, version: REPLAY_BUNDLE_VERSION, ...bundle });
}

/**
 * Exports one partition at its committed head: the committed row fixes the head, the final hash and
 * the pack, then the birth and the event rows 1 through the head are read under `authorization`. It
 * writes nothing, so an interrupted export is rerun. v1 exports public events only.
 */
export async function exportReplayBundle(
  authorization: RuntimeAuthorizationContext,
  scope: WorldPartitionScope,
  ports: ReplayBundleExportPorts,
): Promise<{ bytes: Uint8Array; bundleId: string; manifest: ReplayBundleManifest }> {
  const committed = await ports.snapshots.readCommitted(authorization, scope);
  if (committed === undefined) throw new RangeError("the partition has no committed state");
  const head = committed.coveredPartitionSequence;
  const stored = await ports.birth.readBirth({
    authorization,
    worldId: scope.worldId,
    timelineId: scope.timelineId,
  });
  const text = new TextDecoder("utf-8", { fatal: true });
  const events: string[] = [];
  for (let from = 1n; from <= head; from += EXPORT_PAGE) {
    const to = from + EXPORT_PAGE - 1n < head ? from + EXPORT_PAGE - 1n : head;
    const rows = await ports.events.readPartitionRows(scope, { from, to });
    for (const bytes of rows.eventBytes) events.push(text.decode(bytes));
  }
  const included = privacyClasses(events);
  if (included.some((privacyClass) => privacyClass !== "public_scene"))
    throw new RangeError("replay bundle v1 exports public_scene events only");
  const birth: ReplayBundleBirth = {
    birth: stored.birth,
    seedResources: stored.seedResources.map((resource) => ({
      ...resource,
      bytes: Array.from(resource.bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    })),
  };
  const manifest: ReplayBundleManifest = {
    scope: { ...committed.scope, streamId: committed.streamId },
    head: { partitionSequence: head },
    compatibility: snapshotCompatibility(committed.packContentHash),
    privacy: { included, omitted: [] },
    expected: { finalStateHash: committed.stored.stateHash },
    sections: replayBundleSections(birth, events),
  };
  const bytes = encodeReplayBundle({ manifest, birth, events });
  return { bytes, bundleId: replayBundleId(manifest), manifest };
}

/** The distinct privacy classes of event texts, sorted. */
function privacyClasses(events: readonly string[]): PrivacyClass[] {
  const classes = new Set(
    events.map((event) => (JSON.parse(event) as { privacyClass: PrivacyClass }).privacyClass),
  );
  return [...classes].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value === "object" ? "record" : typeof value;
}

/** The fields the verifier reads, by path; the replay ports check the rest. */
const SHAPE = [
  ["kind", "string"],
  ["version", "number"],
  ["events", "array"],
  ["birth.birth", "record"],
  ["birth.seedResources", "array"],
  ["manifest.scope", "record"],
  ["manifest.head.partitionSequence", "bigint"],
  ["manifest.compatibility", "record"],
  ["manifest.privacy.included", "array"],
  ["manifest.privacy.omitted", "array"],
  ["manifest.expected.finalStateHash", "string"],
  ["manifest.sections.birth", "string"],
  ["manifest.sections.events", "string"],
  ["manifest.sections.eventCount", "number"],
] as const;

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        typeOf(node) === "record" ? (node as Record<string, unknown>)[key] : undefined,
      value,
    );

/** Decodes format v1 in canonical form, or throws `ReplayBundleIntegrityError("malformed")`. */
export function decodeReplayBundle(bytes: Uint8Array): ReplayBundle {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const wrapper: unknown = JSON.parse(text);
    if (
      Array.isArray(wrapper) &&
      wrapper.length === 2 &&
      wrapper[0] === CANONICAL_ENCODING_VERSION
    ) {
      const decoded = plainValue(decodeCanonicalNode(wrapper[1]));
      if (canonicalSerialize(decoded) === text) value = decoded;
    }
  } catch (error) {
    if (
      !(
        error instanceof TypeError ||
        error instanceof SyntaxError ||
        error instanceof CanonicalNodeError
      )
    )
      throw error;
  }
  if (
    !SHAPE.every(([path, type]) => typeOf(at(value, path)) === type) ||
    at(value, "kind") !== BUNDLE_KIND ||
    at(value, "version") !== REPLAY_BUNDLE_VERSION ||
    !(at(value, "events") as unknown[]).every((event) => typeof event === "string")
  ) {
    throw new ReplayBundleIntegrityError("malformed");
  }
  const { kind: _kind, version: _version, ...bundle } = value as Record<string, unknown>;
  return bundle as unknown as ReplayBundle;
}

/** Never reaches a database: the offline ports ignore authorization. */
const OFFLINE: RuntimeAuthorizationContext = {
  tenantId: "" as RuntimeAuthorizationContext["tenantId"],
  principalId: "offline-bundle-verifier" as PrincipalId,
  privacyCeiling: { version: 1, allowedCategories: [] },
};

/**
 * Verifies a bundle with no database and no credentials: the section hashes first, then the
 * compatibility set, then replay of the birth and every event through the unchanged replay path over
 * in-memory ports, whose final hash must equal the manifest's. A bundle is hashed, not signed: compare
 * the returned `finalStateHash` with an independent reference to anchor authenticity. Manifest signing
 * and upcaster identifiers belong to Wave 9 RW-0902's private export (Wave 9 plan §6.2, issue 837).
 */
export async function verifyReplayBundle(
  bytes: Uint8Array,
  options: { readonly decodeResource: DecodeResource },
): Promise<ReplayBundleVerification> {
  const { manifest, birth, events } = decodeReplayBundle(bytes);
  const sections = replayBundleSections(birth, events);
  if (canonicalSerialize(sections) !== canonicalSerialize(manifest.sections))
    throw new ReplayBundleIntegrityError("section-hash");
  const current = snapshotCompatibility(manifest.compatibility.packContentHash);
  const field = (Object.keys(current) as (keyof SnapshotCompatibility)[]).find(
    (key) => manifest.compatibility[key] !== current[key],
  );
  if (field !== undefined) throw new ReplayBundleIncompatibleError(field);

  const head = manifest.head.partitionSequence;
  const encoder = new TextEncoder();
  const rows = async (_scope: unknown, range: SequenceRange) => {
    const to = range.to === undefined || range.to > head ? head : range.to;
    const from = range.from ?? 1n;
    const slice = from > to ? [] : events.slice(Number(from - 1n), Number(to));
    return { head, eventBytes: slice.map((event) => encoder.encode(event)) };
  };
  const ports = {
    events: new JournalRangeReader(
      { readPartitionRows: rows, readStreamRows: rows } as JournalRangeSource,
      JOURNAL_EVENT_REGISTRY,
    ),
    birth: {
      readBirth: async () => ({
        birth: birth.birth,
        seedResources: birth.seedResources.map((resource) => ({
          ...resource,
          bytes: Uint8Array.from(resource.bytes.match(/../gu) ?? [], (pair) =>
            Number.parseInt(pair, 16),
          ),
        })),
      }),
    },
    decodeResource: options.decodeResource,
  };
  const scope = manifest.scope;
  const start = await replayBirth(OFFLINE, scope, ports);
  const replayed = await replayPartition(scope, start, head, ports);
  if (replayed.stateHash !== manifest.expected.finalStateHash)
    throw new ReplayBundleIntegrityError("final-state");
  if (
    canonicalSerialize(privacyClasses(events)) !== canonicalSerialize(manifest.privacy.included) ||
    manifest.privacy.omitted.length > 0
  )
    throw new ReplayBundleIntegrityError("privacy");
  return {
    bundleId: replayBundleId(manifest),
    finalStateHash: replayed.stateHash,
    eventsApplied: replayed.eventsApplied,
    coveredPartitionSequence: replayed.coveredPartitionSequence,
    privacy: manifest.privacy,
  };
}
