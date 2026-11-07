import { type BrowserScope, decodeBrowserScope } from "./browser-protocol.js";
import { decodeOpaqueId, type ObjectId } from "./ids.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  freeze,
  literal,
  nonNegativeInteger,
  record,
  string,
} from "./validation.js";

/**
 * Governed actor documents and context manifests (Wave 5 §5.3, §9, RW-0505;
 * `docs/protocols/context-assembly.md`). A document is a logical Markdown resource of one actor
 * with a stable ID and immutable versions; its path fixes its kind and its kind fixes its write
 * class, so a path a model returns can never select a protected target.
 */
export const DOCUMENT_KINDS = [
  "identity",
  "policy",
  "goals",
  "working_context",
  "session_summary",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const WRITE_CLASSES = ["protected", "governed", "actor_writable"] as const;
export type WriteClass = (typeof WRITE_CLASSES)[number];
export const DOCUMENT_WRITE_CLASS: Readonly<Record<DocumentKind, WriteClass>> = freeze({
  identity: "protected",
  policy: "protected",
  goals: "governed",
  working_context: "actor_writable",
  session_summary: "actor_writable",
});

/** Decisions (issue 17 defaults): the bounds migration 0037 also holds. */
export const MAX_DOCUMENT_OCTETS = 8192;
export const MAX_CHANGE_SET_OPERATIONS = 8;
export const MAX_ACTOR_DOCUMENTS = 256;
export const MAX_DOCUMENT_VERSIONS = 1000;

export interface DocumentPath {
  readonly path: string;
  readonly kind: DocumentKind;
  readonly writeClass: WriteClass;
  /** The session a summary belongs to. */
  readonly sessionId: string | null;
}

const FIXED_PATHS: Readonly<Record<string, DocumentKind>> = {
  "identity.md": "identity",
  "policy.md": "policy",
  "goals.md": "goals",
  "working-context.md": "working_context",
};
const SUMMARY_PATH = /^sessions\/([A-Za-z0-9._:-]{1,255})\/summary\.md$/;

/**
 * The document a logical path names, or undefined when the path is outside the closed grammar.
 * Nothing is normalised: `./policy.md`, `Policy.md` and `../x/policy.md` are not paths.
 */
export function resolveDocumentPath(path: string): DocumentPath | undefined {
  const fixed = Object.hasOwn(FIXED_PATHS, path) ? FIXED_PATHS[path] : undefined;
  if (fixed !== undefined)
    return freeze({ path, kind: fixed, writeClass: DOCUMENT_WRITE_CLASS[fixed], sessionId: null });
  const summary = SUMMARY_PATH.exec(path);
  const sessionId = summary?.[1];
  if (sessionId === undefined || sessionId === "." || sessionId === "..") return undefined;
  return freeze({ path, kind: "session_summary", writeClass: "actor_writable", sessionId });
}

export type DocumentOperation =
  | { readonly op: "create"; readonly path: string; readonly content: string }
  | {
      readonly op: "patch";
      readonly path: string;
      readonly expectedVersion: number;
      readonly content: string;
    }
  | { readonly op: "archive"; readonly path: string; readonly expectedVersion: number };

export const DOCUMENT_REFUSAL_CODES = [
  "document_path_invalid",
  "write_class_refused",
  "document_scope_refused",
  "document_exists",
  "document_not_found",
  "document_archived",
  "version_conflict",
  "document_too_large",
  "change_set_too_large",
  "document_limit_reached",
  "version_limit_reached",
  "change_set_reused",
] as const;
export type DocumentRefusalCode = (typeof DOCUMENT_REFUSAL_CODES)[number];

/** An operator change set over one actor's documents, all or nothing. */
export interface DocumentChangeRequest {
  readonly scope: BrowserScope;
  readonly actorId: ObjectId;
  readonly changeSetId: string;
  readonly operations: readonly DocumentOperation[];
}

export interface DocumentVersionRef {
  readonly documentId: string;
  readonly path: string;
  readonly version: number;
  readonly state: "active" | "archived";
  readonly sourceHash: string;
}

export interface DocumentChangeReceipt {
  readonly changeSetId: string;
  readonly status: "committed";
  readonly documents: readonly DocumentVersionRef[];
}

export interface DocumentReadRequest {
  readonly scope: BrowserScope;
  readonly actorId: ObjectId;
  readonly path: string;
  readonly version?: number;
}

export interface DocumentVersionView extends DocumentVersionRef {
  readonly actorId: string;
  readonly kind: DocumentKind;
  readonly writeClass: WriteClass;
  readonly byteLength: number;
  readonly content: string;
  readonly changeSetId: string;
  readonly proposer: "operator" | "model";
  readonly principalId: string;
  readonly runId: string | null;
  readonly createdAt: string;
}

/** Where a manifest entry sits in the prompt; `null` for an excluded candidate. */
export const CONTEXT_SECTIONS = ["protected", "governed", "untrusted"] as const;
export type ContextSection = (typeof CONTEXT_SECTIONS)[number];
export const CONTEXT_EXCLUSION_RULES = [
  "other_session_private",
  "document_archived",
  "token_budget",
] as const;
export type ContextExclusionRule = (typeof CONTEXT_EXCLUSION_RULES)[number];

/**
 * One candidate source of a turn's context: what it was (a document version, a message of the
 * session, or the turn's input), the metadata its authorization decision read, and the decision.
 */
export interface ContextManifestEntry {
  readonly source: "document" | "message" | "input";
  /** A document's stable ID, or a message ID. */
  readonly sourceId: string;
  /** A document version, or a message's sequence in its session. */
  readonly version: number;
  /** A document path, or a message's role. */
  readonly label: string;
  readonly scope: "actor" | "session";
  readonly writeClass: WriteClass | null;
  readonly sessionId: string | null;
  readonly state: "active" | "archived";
  readonly sourceHash: string;
  readonly tokens: number;
  readonly decision: "included" | "excluded";
  readonly rule: ContextExclusionRule | null;
  readonly section: ContextSection | null;
  readonly trust: "trusted" | "untrusted";
  /** Position in the prompt from 1; `null` when excluded. */
  readonly promptOrder: number | null;
}

export interface ContextManifest {
  readonly runId: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly inputMessageId: string;
  /** The session's message count the turn read. */
  readonly inputRevision: number;
  readonly tokenBudget: number;
  readonly tokensUsed: number;
  readonly manifestHash: string;
  readonly entries: readonly ContextManifestEntry[];
}

export interface ContextInspectRequest {
  readonly scope: BrowserScope;
  readonly entry:
    | { readonly runId: string }
    | { readonly sessionId: string; readonly turn: number };
}

/**
 * A turn's manifest and, for an inspector who may read its sources, the same context assembled
 * again from the recorded inputs. `reassembledHash` equals `manifestHash` when it reproduces.
 */
export interface ContextInspection {
  readonly manifest: ContextManifest;
  readonly reassembledHash: string | null;
}

const SCOPE_KEYS = ["version", "tenantId", "worldId", "timelineId", "spaceId"] as const;
const encoder = new TextEncoder();

function scoped(value: unknown, path: string, required: readonly string[], optional: string[]) {
  const v = record(value, path);
  exactKeys(v, [...SCOPE_KEYS, ...required], optional, path);
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  return { v, scope: decodeBrowserScope({ tenantId, worldId, timelineId, spaceId }) };
}

function boundedId(value: unknown, path: string, octets = 128): string {
  const id = string(value, path);
  if (id === "" || id.trim() !== id || encoder.encode(id).length > octets)
    throw new ContractDecodeError(path, "ID length out of range");
  return id;
}

function version(value: unknown, path: string): number {
  const n = nonNegativeInteger(value, path);
  if (n < 1 || n > MAX_DOCUMENT_VERSIONS)
    throw new ContractDecodeError(path, "version out of range");
  return n;
}

/** Paths and contents are decoded as text; the grammar and size are change-set refusals. */
function operation(value: unknown, path: string): DocumentOperation {
  const v = record(value, path);
  const op = literal(v.op, ["create", "patch", "archive"] as const, `${path}.op`);
  const target = string(v.path, `${path}.path`);
  if (encoder.encode(target).length > 512)
    throw new ContractDecodeError(`${path}.path`, "too long");
  if (op === "create") {
    exactKeys(v, ["op", "path", "content"], [], path);
    return freeze({ op, path: target, content: string(v.content, `${path}.content`) });
  }
  if (op === "patch") {
    exactKeys(v, ["op", "path", "expectedVersion", "content"], [], path);
    return freeze({
      op,
      path: target,
      expectedVersion: version(v.expectedVersion, `${path}.expectedVersion`),
      content: string(v.content, `${path}.content`),
    });
  }
  exactKeys(v, ["op", "path", "expectedVersion"], [], path);
  return freeze({
    op,
    path: target,
    expectedVersion: version(v.expectedVersion, `${path}.expectedVersion`),
  });
}

export function decodeDocumentChangeRequest(value: unknown): DocumentChangeRequest {
  const path = "changeDocuments";
  const { v, scope } = scoped(value, path, ["actorId", "changeSetId", "operations"], []);
  const raw = v.operations;
  if (!Array.isArray(raw) || raw.length < 1)
    throw new ContractDecodeError(`${path}.operations`, "at least one operation");
  // Past the limit is a recorded refusal, not a malformed request; still bound what is decoded.
  if (raw.length > 64) throw new ContractDecodeError(`${path}.operations`, "too many operations");
  return freeze({
    scope,
    actorId: decodeOpaqueId(v.actorId, "ObjectId", `${path}.actorId`),
    changeSetId: boundedId(v.changeSetId, `${path}.changeSetId`),
    operations: freeze(array(raw, `${path}.operations`, operation)),
  });
}

export function decodeDocumentReadRequest(value: unknown): DocumentReadRequest {
  const path = "readDocument";
  const { v, scope } = scoped(value, path, ["actorId", "path"], ["version"]);
  return freeze({
    scope,
    actorId: decodeOpaqueId(v.actorId, "ObjectId", `${path}.actorId`),
    path: boundedId(v.path, `${path}.path`, 512),
    ...(v.version === undefined ? {} : { version: version(v.version, `${path}.version`) }),
  });
}

/** Exactly one entry: `runId`, or `sessionId` with `turn`. */
export function decodeContextInspectRequest(value: unknown): ContextInspectRequest {
  const path = "inspectContext";
  const { v, scope } = scoped(value, path, [], ["runId", "sessionId", "turn"]);
  const shape = ["runId", "sessionId", "turn"].filter((key) => v[key] !== undefined).join(",");
  if (shape === "runId")
    return freeze({ scope, entry: freeze({ runId: boundedId(v.runId, `${path}.runId`, 1024) }) });
  if (shape === "sessionId,turn") {
    const turn = nonNegativeInteger(v.turn, `${path}.turn`);
    if (turn < 1 || turn > 500) throw new ContractDecodeError(`${path}.turn`, "turn out of range");
    return freeze({
      scope,
      entry: freeze({ sessionId: boundedId(v.sessionId, `${path}.sessionId`, 1024), turn }),
    });
  }
  throw new ContractDecodeError(path, "exactly one entry required");
}
