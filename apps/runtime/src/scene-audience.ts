import {
  type BrowserScope,
  PRIVACY_CATEGORIES,
  type PrivacyCategory,
  type PrivacyCeiling,
  type SceneConnectionAudience,
  type SceneInterest,
  type ScenePrivateCognition,
} from "@clockgrove/contracts";
import type { WorldState } from "@clockgrove/domain";
import {
  type AudienceReason,
  canonicalBytes,
  resolveAudience,
  sha256Hex,
} from "@clockgrove/kernel";
import { INSPECT_GRANT } from "./inspector.js";
import type { InteractionAuthority } from "./interactions.js";

/** The principal's current authority relevant to a scene audience; the principal itself is not. */
export interface SceneAuthorityFacts {
  /** The stored ceiling's categories a scene audience can use, in `PRIVACY_CATEGORIES` order. */
  readonly categories: readonly PrivacyCategory[];
  /** `runtime:world-inspect`, which alone authorizes the operator lane. */
  readonly inspect: boolean;
  /** `runtime:world-command`, which enables the Influence actions of interaction cards. */
  readonly command: boolean;
}

/** Categories a scene audience can carry; credentials and operator evidence never enter one. */
const SCENE_AUDIENCE_CATEGORIES: ReadonlySet<PrivacyCategory> = new Set([
  "public_scene",
  "private_cognition",
  "conversation",
]);

/** The scene-relevant facts of a principal's current grants and stored ceiling. */
export function sceneAuthorityFacts(
  grants: readonly string[],
  ceiling: PrivacyCeiling,
): SceneAuthorityFacts {
  return {
    categories: PRIVACY_CATEGORIES.filter(
      (category) =>
        SCENE_AUDIENCE_CATEGORIES.has(category) && ceiling.allowedCategories.includes(category),
    ),
    inspect: grants.some((grant) => grant === INSPECT_GRANT),
    command: grants.some((grant) => grant === "runtime:world-command"),
  };
}

/** The decided audience: what this read may project, independent of which principal asked. */
export interface SceneAudienceDescriptor {
  readonly scope: BrowserScope;
  readonly privacyCategories: readonly PrivacyCategory[];
  readonly interest: SceneInterest;
  /**
   * The interaction actions the reader's authority enables: Talk under a `conversation`
   * ceiling, Influence under `runtime:world-command`. The projected cards differ with them, so
   * frames are never shared across them. Absent when neither is enabled, so a plain observer's
   * audience hash is unchanged.
   */
  readonly actions?: InteractionAuthority;
}

export interface SceneAudienceDecision {
  readonly descriptor: SceneAudienceDescriptor;
  readonly hash: string;
  /** The resolver's viewer reasons, the audience decision record; never on the wire. */
  readonly reasons: readonly AudienceReason[];
}

const VIEWERS = {
  space: "viewer:space",
  selection: "viewer:selection",
  conversation: "viewer:conversation",
  operator: "viewer:operator",
} as const;

function decided(
  scope: BrowserScope,
  privacyCategories: readonly PrivacyCategory[],
  interest: SceneInterest,
  reasons: readonly AudienceReason[],
  actions: InteractionAuthority = { talk: false, influence: false },
): SceneAudienceDecision {
  const descriptor = {
    scope,
    privacyCategories,
    interest,
    ...(actions.talk || actions.influence ? { actions } : {}),
  };
  return { descriptor, hash: sha256Hex(canonicalBytes(descriptor)), reasons };
}

/**
 * One kernel `resolveAudience` call decides every requested interest through its viewer path: each
 * interest is a viewer, subscribed when requested, whose access the grants and ceiling set (`space`
 * is reduced without `private_cognition`; `conversation` is denied without `conversation`;
 * `operator` is denied without the inspection grant). The decision event is synthetic, a `system`
 * observation of the selection (else the space's first entity, else the world's, since a viewer's
 * outcome depends only on its subscription and access) at the read revision; it is never
 * recorded. A refused decision, or a world with no entity to observe, fails closed to the public
 * scene without interest.
 */
export function decideSceneAudience(
  state: WorldState,
  audience: SceneConnectionAudience,
  facts: SceneAuthorityFacts,
): SceneAudienceDecision {
  const { tenantId, worldId, timelineId, spaceId } = audience;
  const scope = { tenantId, worldId, timelineId, spaceId };
  const closed = decided(
    scope,
    ["public_scene"],
    { selection: null, conversation: false, operator: false },
    [],
  );
  const byId = (left: { objectId: string }, right: { objectId: string }) =>
    left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0;
  // An empty space still decides its viewers: the event then observes the world's first entity.
  const anchor =
    state.entities.filter((entity) => entity.spaceId === spaceId).sort(byId)[0] ??
    [...state.entities].sort(byId)[0];
  const access = [
    ...(facts.categories.includes("private_cognition")
      ? []
      : [{ observerId: VIEWERS.space, effect: "reduce" as const }]),
    ...(facts.categories.includes("conversation")
      ? []
      : [{ observerId: VIEWERS.conversation, effect: "deny" as const }]),
    ...(facts.inspect ? [] : [{ observerId: VIEWERS.operator, effect: "deny" as const }]),
  ];
  const resolve = (selection: SceneInterest["selection"]) => {
    const targetId = selection ?? anchor?.objectId;
    if (targetId === undefined || anchor === undefined) return undefined;
    return resolveAudience(
      {
        version: 1,
        type: "object.created",
        eventId: `scene-audience:${spaceId}:${state.revision}`,
        modality: "system",
        sourceRevision: state.revision,
        spaceId: selection === null ? anchor.spaceId : spaceId,
        actorId: null,
        targetId,
        regionIds: [],
      },
      state,
      {
        version: 2,
        modalities: [],
        occlusions: [],
        access,
        subscribers: [],
        viewers: [
          { viewerId: VIEWERS.space, subscribed: true },
          { viewerId: VIEWERS.selection, subscribed: selection !== null },
          { viewerId: VIEWERS.conversation, subscribed: audience.interest.conversation },
          { viewerId: VIEWERS.operator, subscribed: audience.interest.operator },
        ],
      },
    );
  };
  let selection = audience.interest.selection;
  // A selection that is not in this space is not a decision target; it is dropped, not refused.
  if (
    selection !== null &&
    !state.entities.some((entity) => entity.objectId === selection && entity.spaceId === spaceId)
  )
    selection = null;
  const outcome = resolve(selection);
  if (outcome === undefined || !outcome.ok) return closed;
  const viewer = (id: string) =>
    outcome.value.reasons.find(
      (reason) => reason.observerKind === "viewer" && reason.observerId === id,
    );
  const included = (id: string) => viewer(id)?.outcome === "included";
  if (!included(VIEWERS.space)) return closed;
  const reasons = outcome.value.reasons.filter((reason) => reason.observerKind === "viewer");
  return decided(
    scope,
    [
      "public_scene",
      ...(viewer(VIEWERS.space)?.detailLevel === "full" ? (["private_cognition"] as const) : []),
      ...(included(VIEWERS.conversation) ? (["conversation"] as const) : []),
    ],
    {
      selection: included(VIEWERS.selection) ? selection : null,
      conversation: included(VIEWERS.conversation),
      operator: included(VIEWERS.operator),
    },
    reasons,
    {
      talk: facts.categories.includes("conversation"),
      influence: facts.command,
    },
  );
}

/** Relationship-private fields: projected actors' scripted beliefs and memories, by reference. */
export function privateCognitionOf(
  state: WorldState,
  decision: SceneAudienceDecision,
  projected: ReadonlySet<string>,
): readonly ScenePrivateCognition[] | undefined {
  if (!decision.descriptor.privacyCategories.includes("private_cognition")) return undefined;
  return (state.scriptedCognition?.entries ?? [])
    .filter((entry) => projected.has(entry.actorId))
    .map((entry) => ({
      ref: entry.ref,
      kind: entry.kind,
      actorId: entry.actorId,
      targetObjectId: entry.targetObjectId,
      value: entry.value,
    }))
    .sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
}
