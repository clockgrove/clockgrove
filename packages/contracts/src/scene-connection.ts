import {
  type BrowserScope,
  decodeBrowserScope,
  decodeEvidenceLabels,
  decodeObservationRequest,
  type InspectorEvidenceClass,
} from "./browser-protocol.js";
import { decodeOpaqueId, type ObjectId } from "./ids.js";
import { PRIVACY_CATEGORIES, type PrivacyCategory } from "./privacy.js";
import {
  decodeSceneConnectionMetadata,
  SCENE_ASSET_MANIFEST_VERSION,
  SCENE_PROTOCOL_VERSION,
  SceneCompatibilityError,
  type SceneConnectionMetadata,
} from "./scene-protocol.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  literal,
  nonNegativeInteger,
  record,
  string,
  unsignedDecimal,
} from "./validation.js";

export const SCENE_PROTOCOL = "clockgrove.scene.v1";
export const SCENE_CREDENTIAL_PREFIX = "clockgrove.bearer.";

/**
 * Interest a join requests beyond the camera's space (the audience `spaceId`). The server decides
 * on every read which of it the principal's current grants and privacy ceiling allow.
 */
export interface SceneInterest {
  readonly selection: ObjectId | null;
  readonly conversation: boolean;
  readonly operator: boolean;
}
export const NO_SCENE_INTEREST: SceneInterest = Object.freeze({
  selection: null,
  conversation: false,
  operator: false,
});

/** Authorized connection scope, distinct from the projection's audience hash descriptor. */
export interface SceneConnectionAudience extends BrowserScope {
  readonly privacyClass: "public_scene";
  readonly interest: SceneInterest;
}

export function decodeSceneInterest(value: unknown, path = "interest"): SceneInterest {
  const v = record(value, path);
  exactKeys(v, ["selection", "conversation", "operator"], [], path);
  if (typeof v.conversation !== "boolean")
    throw new ContractDecodeError(`${path}.conversation`, "expected boolean");
  if (typeof v.operator !== "boolean")
    throw new ContractDecodeError(`${path}.operator`, "expected boolean");
  return {
    selection:
      v.selection === null ? null : decodeOpaqueId(v.selection, "ObjectId", `${path}.selection`),
    conversation: v.conversation,
    operator: v.operator,
  };
}

/** The operator inspector's safe connection metadata plus the authorized audience. */
export interface SceneConnectionAttachment extends SceneConnectionMetadata {
  readonly audience: SceneConnectionAudience;
  /**
   * The decided audience hash of `acknowledgedRevision`'s frame, when the server knew it. After
   * memory loss it alone tells a restored cursor's audience from the current one.
   */
  readonly acknowledgedAudienceHash?: string;
}

export function decodeSceneConnectionAudience(
  value: unknown,
  path = "audience",
): SceneConnectionAudience {
  const v = record(value, path);
  exactKeys(
    v,
    ["tenantId", "worldId", "timelineId", "spaceId", "privacyClass", "interest"],
    [],
    path,
  );
  return {
    ...decodeBrowserScope({
      tenantId: v.tenantId,
      worldId: v.worldId,
      timelineId: v.timelineId,
      spaceId: v.spaceId,
    }),
    privacyClass: literal(v.privacyClass, ["public_scene"], `${path}.privacyClass`),
    interest: decodeSceneInterest(v.interest, `${path}.interest`),
  };
}

export function decodeSceneConnectionAttachment(
  value: unknown,
  path = "attachment",
): SceneConnectionAttachment {
  const v = record(value, path);
  exactKeys(
    v,
    ["principalId", "audience", "acknowledgedRevision", "connectionVersion"],
    ["acknowledgedAudienceHash"],
    path,
  );
  const { audience, acknowledgedAudienceHash, ...metadata } = v;
  return {
    ...decodeSceneConnectionMetadata(metadata, path),
    audience: decodeSceneConnectionAudience(audience, `${path}.audience`),
    ...(acknowledgedAudienceHash === undefined
      ? {}
      : {
          acknowledgedAudienceHash: string(
            acknowledgedAudienceHash,
            `${path}.acknowledgedAudienceHash`,
          ),
        }),
  };
}

export interface SceneResumeControl {
  readonly protocolVersion: typeof SCENE_PROTOCOL_VERSION;
  readonly type: "resume";
  readonly lastAppliedRevision: bigint | null;
  readonly assetManifestVersion: typeof SCENE_ASSET_MANIFEST_VERSION;
}

export interface SceneAcknowledgementControl {
  readonly protocolVersion: typeof SCENE_PROTOCOL_VERSION;
  readonly type: "ack";
  readonly revision: bigint;
  readonly connectionVersion: number;
}

export type SceneRecoveryReason =
  | "snapshot_required"
  | "revision_unavailable"
  | "asset_manifest_changed"
  | "backpressure"
  | "runtime_restarted";
export type SceneDisconnectReason =
  | "malformed_control"
  | "unsupported_protocol"
  | "unauthorized"
  | "stale_authority_epoch"
  | "internal_error";

export interface SceneRecoveryControl {
  readonly protocolVersion: typeof SCENE_PROTOCOL_VERSION;
  readonly type: "recovery";
  readonly reason: SceneRecoveryReason;
}

export interface SceneDisconnectControl {
  readonly protocolVersion: typeof SCENE_PROTOCOL_VERSION;
  readonly type: "disconnect";
  readonly reason: SceneDisconnectReason;
}

export type SceneClientControl = SceneResumeControl | SceneAcknowledgementControl;
export type SceneServerControl = SceneRecoveryControl | SceneDisconnectControl;
export type SceneConnectionControl = SceneClientControl | SceneServerControl;

export function decodeSceneConnectionControl(
  value: unknown,
  path = "control",
): SceneConnectionControl {
  const v = record(value, path);
  if (v.protocolVersion !== SCENE_PROTOCOL_VERSION) {
    throw new SceneCompatibilityError(
      "unsupported_protocol_version",
      v.protocolVersion,
      SCENE_PROTOCOL_VERSION,
      `${path}.protocolVersion`,
    );
  }
  const protocolVersion = SCENE_PROTOCOL_VERSION;
  switch (v.type) {
    case "resume":
      exactKeys(
        v,
        ["protocolVersion", "type", "lastAppliedRevision", "assetManifestVersion"],
        [],
        path,
      );
      if (v.assetManifestVersion !== SCENE_ASSET_MANIFEST_VERSION) {
        throw new SceneCompatibilityError(
          "unsupported_asset_manifest_version",
          v.assetManifestVersion,
          SCENE_ASSET_MANIFEST_VERSION,
          `${path}.assetManifestVersion`,
        );
      }
      return {
        protocolVersion,
        type: v.type,
        lastAppliedRevision:
          v.lastAppliedRevision === null
            ? null
            : unsignedDecimal(v.lastAppliedRevision, `${path}.lastAppliedRevision`),
        assetManifestVersion: SCENE_ASSET_MANIFEST_VERSION,
      };
    case "ack":
      exactKeys(v, ["protocolVersion", "type", "revision", "connectionVersion"], [], path);
      return {
        protocolVersion,
        type: v.type,
        revision: unsignedDecimal(v.revision, `${path}.revision`),
        connectionVersion: nonNegativeInteger(v.connectionVersion, `${path}.connectionVersion`),
      };
    case "recovery":
      exactKeys(v, ["protocolVersion", "type", "reason"], [], path);
      return {
        protocolVersion,
        type: v.type,
        reason: literal(
          v.reason,
          [
            "snapshot_required",
            "revision_unavailable",
            "asset_manifest_changed",
            "backpressure",
            "runtime_restarted",
          ],
          `${path}.reason`,
        ),
      };
    case "disconnect":
      exactKeys(v, ["protocolVersion", "type", "reason"], [], path);
      return {
        protocolVersion,
        type: v.type,
        reason: literal(
          v.reason,
          [
            "malformed_control",
            "unsupported_protocol",
            "unauthorized",
            "stale_authority_epoch",
            "internal_error",
          ],
          `${path}.reason`,
        ),
      };
    default:
      throw new ContractDecodeError(`${path}.type`, "unsupported connection control");
  }
}

export function decodeSceneClientControl(value: unknown): SceneClientControl {
  const control = decodeSceneConnectionControl(value);
  if (control.type === "resume" || control.type === "ack") return control;
  throw new ContractDecodeError("control.type", "expected a client control");
}

export function decodeSceneServerControl(value: unknown): SceneServerControl {
  const control = decodeSceneConnectionControl(value);
  if (control.type === "recovery" || control.type === "disconnect") return control;
  throw new ContractDecodeError("control.type", "expected a server control");
}

export function parseSceneClientControl(wire: string): SceneClientControl {
  let value: unknown;
  try {
    value = JSON.parse(wire);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ContractDecodeError("control", "invalid JSON");
  }
  return decodeSceneClientControl(value);
}

export function encodeSceneConnectionControl(value: SceneConnectionControl): string {
  return JSON.stringify(decodeSceneConnectionControl(value), (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

/**
 * The viewer's own view traced (issue 819, Wave 4 §11.1): client view → audience decision → projection
 * revision. The request is the scope and interest the client joined with; the server decides it now,
 * under the caller's current grants and ceiling, exactly as a scene read does.
 */
export interface ClientViewTraceRequest extends BrowserScope {
  readonly version: 1;
  readonly interest: SceneInterest;
}
export function decodeClientViewTraceRequest(value: unknown): ClientViewTraceRequest {
  const v = record(value, "viewTrace");
  exactKeys(
    v,
    ["version", "tenantId", "worldId", "timelineId", "spaceId", "interest"],
    [],
    "viewTrace",
  );
  const { interest, ...scope } = v;
  return { ...decodeObservationRequest(scope), interest: decodeSceneInterest(interest) };
}

/** The audience decision is decided per request and never recorded; the revision is journal truth. */
export const CLIENT_VIEW_EVIDENCE = Object.freeze({
  audience: "transient",
  projection: "canonical",
} as const satisfies Record<string, InspectorEvidenceClass>);

export const CLIENT_VIEW_VIEWERS = ["space", "selection", "conversation", "operator"] as const;
/** One viewer path of the kernel audience resolver: why that part of the view is in or out. */
export interface ClientViewAudienceReason {
  readonly viewer: (typeof CLIENT_VIEW_VIEWERS)[number];
  readonly outcome: "included" | "excluded";
  readonly code: string;
  readonly detailLevel: string;
}
export interface ClientViewTrace extends BrowserScope {
  readonly version: 1;
  readonly privacyClass: "public_scene";
  readonly evidence: typeof CLIENT_VIEW_EVIDENCE;
  readonly requested: SceneInterest;
  /** The decided audience; `hash` is the `audienceHash` of the frames this view receives. */
  readonly audience: {
    readonly privacyCategories: readonly PrivacyCategory[];
    readonly interest: SceneInterest;
    readonly hash: string;
    readonly reasons: readonly ClientViewAudienceReason[];
  };
  readonly projection: { readonly revision: string; readonly simulationTime: string };
}
export function decodeClientViewTrace(value: unknown): ClientViewTrace {
  const v = record(value, "viewTrace");
  exactKeys(
    v,
    [
      "version",
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "privacyClass",
      "evidence",
      "requested",
      "audience",
      "projection",
    ],
    [],
    "viewTrace",
  );
  const scope = decodeObservationRequest({
    version: v.version,
    tenantId: v.tenantId,
    worldId: v.worldId,
    timelineId: v.timelineId,
    spaceId: v.spaceId,
  });
  const a = record(v.audience, "viewTrace.audience");
  exactKeys(a, ["privacyCategories", "interest", "hash", "reasons"], [], "viewTrace.audience");
  const p = record(v.projection, "viewTrace.projection");
  exactKeys(p, ["revision", "simulationTime"], [], "viewTrace.projection");
  return {
    ...scope,
    privacyClass: literal(v.privacyClass, ["public_scene"], "viewTrace.privacyClass"),
    evidence: decodeEvidenceLabels(v.evidence, CLIENT_VIEW_EVIDENCE, "viewTrace.evidence"),
    requested: decodeSceneInterest(v.requested, "viewTrace.requested"),
    audience: {
      privacyCategories: array(
        a.privacyCategories,
        "viewTrace.audience.privacyCategories",
        (c, path) => literal(c, PRIVACY_CATEGORIES, path),
      ),
      interest: decodeSceneInterest(a.interest, "viewTrace.audience.interest"),
      hash: string(a.hash, "viewTrace.audience.hash"),
      reasons: array(a.reasons, "viewTrace.audience.reasons", (item, path) => {
        const r = record(item, path);
        exactKeys(r, ["viewer", "outcome", "code", "detailLevel"], [], path);
        return {
          viewer: literal(r.viewer, CLIENT_VIEW_VIEWERS, `${path}.viewer`),
          outcome: literal(r.outcome, ["included", "excluded"], `${path}.outcome`),
          code: string(r.code, `${path}.code`),
          detailLevel: string(r.detailLevel, `${path}.detailLevel`),
        };
      }),
    },
    projection: {
      revision: unsignedDecimal(p.revision, "viewTrace.projection.revision").toString(),
      simulationTime: unsignedDecimal(
        p.simulationTime,
        "viewTrace.projection.simulationTime",
      ).toString(),
    },
  };
}
