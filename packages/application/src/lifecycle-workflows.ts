import {
  ContractDecodeError,
  decodeOpaqueId,
  decodePrivacyCeiling,
  type RunId,
  type TenantId,
} from "@clockgrove/contracts";
import { canonicalBytes, sha256Hex } from "@clockgrove/kernel";
import { type CanonicalNode, decodeCanonicalNode, encodeCanonicalNode } from "./canonical-node.js";
import type { ProvisionWorldRequest } from "./world-provisioning-ports.js";

/** Local boundary helpers: contracts/validation.ts does not export these through its package API. */
export function lifecycleRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ContractDecodeError(path, "expected record");
  return Object.fromEntries(Object.entries(value));
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    throw new ContractDecodeError(path, "unexpected or missing fields");
}

function literalVersion(value: unknown, expected: number, path: string): void {
  if (value !== expected) throw new ContractDecodeError(path, "unsupported version");
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ContractDecodeError(path, "expected non-empty string");
  return value;
}

/** Provider-neutral reference to an already authorized, durable provisioning case. */
export interface LifecycleWorkflowEnvelope {
  readonly version: 1;
  readonly tenantId: TenantId;
  readonly caseId: string;
  readonly applicationRunId: RunId;
}

export function decodeLifecycleWorkflowEnvelope(value: unknown): LifecycleWorkflowEnvelope {
  const input = lifecycleRecord(value, "workflow");
  exactKeys(input, ["version", "tenantId", "caseId", "applicationRunId"], [], "workflow");
  literalVersion(input.version, 1, "workflow.version");
  return {
    version: 1,
    tenantId: decodeOpaqueId(input.tenantId, "TenantId", "workflow.tenantId"),
    caseId: string(input.caseId, "workflow.caseId"),
    applicationRunId: decodeOpaqueId(input.applicationRunId, "RunId", "workflow.applicationRunId"),
  };
}

export interface LifecycleWorkflowStatus {
  readonly status: "requested" | "seeding" | "verified" | "ready" | "failed";
  readonly worldId?: string;
  readonly receiptCommandIds: readonly string[];
}

export interface LifecycleWorkflowStore {
  /** Only a trusted launch path supplies the actual authorized request. */
  register(
    request: ProvisionWorldRequest,
    applicationRunId: string,
  ): Promise<LifecycleWorkflowEnvelope>;
  /** An envelope is only a lookup key: the accepted request supplies all authority and input. */
  read(envelope: LifecycleWorkflowEnvelope): Promise<ProvisionWorldRequest>;
  status(envelope: LifecycleWorkflowEnvelope): Promise<LifecycleWorkflowStatus>;
  cancel(envelope: LifecycleWorkflowEnvelope): Promise<void>;
}

/** Byte strings collected by `encodeProvisioningSource` for storage outside the JSON tree. */
interface SourceByteSink {
  readonly chunks: Uint8Array[];
  length: number;
}

/**
 * Tagged JSON form of a pack source, preserving Uint8Arrays; recursively tagged containers
 * distinguish user values from tags. With a sink, each byte string becomes its [offset, length] in
 * the sink, so stored bytes are kept once and uninflated; without one they are inline numbers.
 */
export function encodeProvisioningSource(value: unknown, sink?: SourceByteSink): CanonicalNode {
  if (value instanceof Uint8Array) {
    if (sink === undefined) return ["bytes", Array.from(value)];
    const offset = sink.length;
    sink.chunks.push(value);
    sink.length += value.byteLength;
    return ["stored-bytes", [offset, value.byteLength]];
  }
  if (Array.isArray(value))
    return ["array", value.map((item) => encodeProvisioningSource(item, sink))];
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) !== null &&
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return ["canonical", encodeCanonicalNode(value)];
  }
  if (value !== null && typeof value === "object") {
    return [
      "record",
      Object.entries(value).map(([key, item]) => [key, encodeProvisioningSource(item, sink)]),
    ];
  }
  return ["canonical", encodeCanonicalNode(value)];
}

/** Inverse of `encodeProvisioningSource`; `stored` holds the bytes its sink collected. */
export function decodeProvisioningSource(value: unknown, stored?: Uint8Array): unknown {
  if (!Array.isArray(value) || value.length !== 2)
    throw new TypeError("Malformed provisioning source node");
  const [tag, body] = value;
  if (tag === "canonical") return decodeCanonicalNode(body);
  if (!Array.isArray(body)) throw new TypeError("Malformed provisioning source container");
  if (tag === "stored-bytes") {
    const [offset, length] = body;
    if (
      stored === undefined ||
      body.length !== 2 ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > stored.byteLength
    )
      throw new TypeError("Malformed stored provisioning source bytes");
    return stored.slice(offset, offset + length);
  }
  if (tag === "bytes") {
    if (
      !body.every(
        (byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
      )
    ) {
      throw new TypeError("Malformed provisioning source bytes");
    }
    return Uint8Array.from(body);
  }
  if (tag === "array") return body.map((item) => decodeProvisioningSource(item, stored));
  if (tag === "record") {
    return Object.fromEntries(
      body.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
          throw new TypeError("Malformed provisioning source field");
        return [entry[0], decodeProvisioningSource(entry[1], stored)];
      }),
    );
  }
  throw new TypeError("Unknown provisioning source tag");
}

/** Matches the stored-source CHECK in migration 0025 (128 MB Worker memory / 6 copies, 21 MiB). */
export const MAX_STORED_PROVISIONING_SOURCE_BYTES = 22_020_096;

/** Durable form of a request: a small permanent header, and the source held while the case is open. */
export interface StoredProvisioningRequest {
  readonly request: {
    readonly version: 1;
    readonly authorization: ProvisionWorldRequest["authorization"];
    readonly caseId: string;
    readonly artifact: ProvisionWorldRequest["artifact"];
  };
  readonly source: CanonicalNode;
  readonly sourceBytes: Uint8Array;
}

export function storedProvisioningRequest(
  request: ProvisionWorldRequest,
): StoredProvisioningRequest {
  const sink: SourceByteSink = { chunks: [], length: 0 };
  const source = encodeProvisioningSource(request.source, sink);
  const sourceBytes = new Uint8Array(sink.length);
  let offset = 0;
  for (const chunk of sink.chunks) {
    sourceBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    request: {
      version: 1,
      authorization: request.authorization,
      caseId: request.caseId,
      artifact: request.artifact,
    },
    source,
    sourceBytes,
  };
}

/** Exact identity of the prepared accepted request, shared by registration and direct callers. */
export function storedProvisioningRequestIdentity(stored: StoredProvisioningRequest): string {
  return sha256Hex(
    canonicalBytes({
      ...stored.request,
      source: stored.source,
      sourceBytesSha256: sha256Hex(stored.sourceBytes),
    }),
  );
}

/** Boundary decoder for the versioned request stored by trusted registration. */
export function decodeStoredProvisioningRequest(
  value: unknown,
  requestIdentityHash: string,
  source: unknown,
  sourceBytes: unknown,
): ProvisionWorldRequest {
  const input = lifecycleRecord(value, "request");
  exactKeys(input, ["version", "authorization", "caseId", "artifact"], [], "request");
  if (typeof requestIdentityHash !== "string" || !/^[0-9a-f]{64}$/u.test(requestIdentityHash))
    throw new ContractDecodeError("request.identity", "expected sha256 hex");
  // Only a terminal case has released its source; it then needs none to report its outcome.
  if (
    (source === null) !== (sourceBytes === null) ||
    (sourceBytes !== null && !(sourceBytes instanceof Uint8Array))
  )
    throw new ContractDecodeError("request.source", "malformed stored source");
  literalVersion(input.version, 1, "request.version");
  const authorization = lifecycleRecord(input.authorization, "request.authorization");
  exactKeys(
    authorization,
    ["tenantId", "principalId", "privacyCeiling"],
    [],
    "request.authorization",
  );
  const artifact = lifecycleRecord(input.artifact, "request.artifact");
  exactKeys(
    artifact,
    [
      "packId",
      "version",
      "contentHash",
      "engineCompatibility",
      "resourceManifestHash",
      "assetManifestHash",
      "migrationSetHash",
      "buildToolVersion",
    ],
    [],
    "request.artifact",
  );
  return {
    authorization: {
      tenantId: decodeOpaqueId(authorization.tenantId, "TenantId"),
      principalId: decodeOpaqueId(authorization.principalId, "PrincipalId"),
      privacyCeiling: decodePrivacyCeiling(authorization.privacyCeiling),
    },
    caseId: string(input.caseId, "request.caseId"),
    artifact: {
      packId: string(artifact.packId, "artifact.packId"),
      version: string(artifact.version, "artifact.version"),
      contentHash: string(artifact.contentHash, "artifact.contentHash"),
      engineCompatibility: string(artifact.engineCompatibility, "artifact.engineCompatibility"),
      resourceManifestHash: string(artifact.resourceManifestHash, "artifact.resourceManifestHash"),
      assetManifestHash: string(artifact.assetManifestHash, "artifact.assetManifestHash"),
      migrationSetHash: string(artifact.migrationSetHash, "artifact.migrationSetHash"),
      buildToolVersion: string(artifact.buildToolVersion, "artifact.buildToolVersion"),
    },
    source: source === null ? null : decodeProvisioningSource(source, sourceBytes as Uint8Array),
    registeredIdentityHash: requestIdentityHash,
  };
}
