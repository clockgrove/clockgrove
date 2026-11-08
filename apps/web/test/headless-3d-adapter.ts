import type {
  LivingScene,
  LivingSpatialFrame,
  ObjectId,
  PlaceholderPresentation,
  ScenePatch,
  SceneProjection,
  SceneTransientCue,
} from "@clockgrove/contracts";
import {
  applyScenePatch,
  framePosition,
  type SceneEmphasis,
  type SceneIntent,
  type Unsubscribe,
  type WorldSceneAdapter,
} from "../src/world-scene-adapter.js";
import {
  emptyYard,
  livingSceneOf,
  reduceYard,
  type SceneMaterial,
  sameYardScope,
  scenePresentations,
  type YardProjection,
} from "../src/yard-projection.js";

/** One scene-graph group per spatial frame version, keyed `frameId@version`. */
export interface Headless3DGroup {
  readonly frame: LivingSpatialFrame;
  readonly children: readonly ObjectId[];
}
/** One scene-graph node per semantic object, keyed by its canonical object ID. */
export interface Headless3DNode {
  readonly objectId: ObjectId;
  readonly group: string;
  /** Frame-local x, y and z in frame units; a planar frame lies at z = 0. */
  readonly position: readonly [number, number, number];
  readonly presentation: PlaceholderPresentation;
  readonly material?: SceneMaterial;
}
/**
 * The headless 3D adapter fixture (Wave 4 plan §3.1): a second renderer consumer that builds a 3D
 * scene graph from the renderer-neutral scene, without canvas or a renderer SDK. Scenes pass through the
 * projection reducer, so an older revision never replaces a newer one, and picking a node emits the
 * same selection intent as the live WebGL2 path.
 */
export class Headless3DAdapter implements WorldSceneAdapter {
  revision: bigint | undefined;
  bindings: SceneProjection["presentationBindings"] = [];
  groups: ReadonlyMap<string, Headless3DGroup> = new Map();
  nodes: ReadonlyMap<ObjectId, Headless3DNode> = new Map();
  /** The emphasized nodes: the ring and label of the selected node and the focused node's affordance. */
  emphasized: SceneEmphasis = { selected: undefined, focused: undefined };
  /** Dedupe keys of the unexpired cues drawn so far, oldest first, at most 64. */
  cues: string[] = [];
  reducedMotion = false;
  private emphasis: SceneEmphasis = this.emphasized;
  private projection: YardProjection = emptyYard;
  private committed: SceneProjection | undefined;
  private handlers = new Set<(intent: SceneIntent) => void>();
  get scene(): LivingScene | undefined {
    return this.projection.scene;
  }
  loadSnapshot(snapshot: SceneProjection): void {
    const scene = livingSceneOf(snapshot);
    const { tenantId, worldId, timelineId, spaceId } = scene;
    let next = this.projection;
    if (!next.scope || !sameYardScope(next.scope, scene))
      next = reduceYard(next, {
        type: "replace",
        intent: next.intent + 1,
        scope: { tenantId, worldId, timelineId, spaceId },
      });
    next = reduceYard(next, { type: "snapshot", intent: next.intent, scene });
    if (next.scene === scene) {
      this.committed = snapshot;
      this.bindings = snapshot.presentationBindings;
      this.revision = snapshot.revision;
    }
    const presentations = scenePresentations({
      entities: next.scene?.entities ?? [],
      presentationBindings: this.bindings,
    });
    const groups = new Map<string, { frame: LivingSpatialFrame; children: ObjectId[] }>();
    const nodes = new Map<ObjectId, Headless3DNode>();
    for (const frame of next.scene?.frames ?? [])
      groups.set(`${frame.frameId}@${frame.version}`, { frame, children: [] });
    for (const entity of next.scene?.entities ?? []) {
      const group = `${entity.pose.frameId}@${entity.pose.frameVersion}`;
      const parent = groups.get(group);
      if (!parent || entity.pose.coordinates.length !== parent.frame.dimensions)
        throw new Error(`${entity.objectId}: pose does not fit frame ${group}`);
      const [x = 0, y = 0, z = 0] = framePosition(parent.frame, entity.pose.coordinates);
      parent.children.push(entity.objectId);
      const presentation = presentations.get(entity.objectId);
      nodes.set(entity.objectId, {
        objectId: entity.objectId,
        group,
        position: [x, y, z],
        presentation: presentation?.placeholder ?? entity.presentation,
        ...(presentation?.material ? { material: presentation.material } : {}),
      });
    }
    this.projection = next;
    this.groups = groups;
    this.nodes = nodes;
    this.setSelection(this.emphasis.selected);
    this.focus(this.emphasis.focused);
  }
  applyPatch(patch: ScenePatch): void {
    if (this.committed && this.committed.revision === patch.fromRevision)
      this.loadSnapshot(applyScenePatch(this.committed, patch));
  }
  emitCue(cue: SceneTransientCue): void {
    if (Date.parse(cue.expiresAt) <= Date.now() || this.cues.includes(cue.dedupeKey)) return;
    this.cues = [...this.cues, cue.dedupeKey].slice(-64);
  }
  setSelection(id?: ObjectId): void {
    this.emphasis = { ...this.emphasis, selected: id };
    this.emphasized = { ...this.emphasized, selected: this.existing(id) };
  }
  focus(id?: ObjectId): void {
    this.emphasis = { ...this.emphasis, focused: id };
    this.emphasized = { ...this.emphasized, focused: this.existing(id) };
  }
  setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
  }
  onIntent(handler: (intent: SceneIntent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  pick(objectId: ObjectId): void {
    if (this.nodes.has(objectId))
      for (const handler of this.handlers) handler({ type: "select", objectId });
  }
  destroy(): void {
    this.revision = undefined;
    this.bindings = [];
    this.projection = emptyYard;
    this.committed = undefined;
    this.groups = new Map();
    this.nodes = new Map();
    this.cues = [];
    this.handlers.clear();
    this.setSelection(undefined);
    this.focus(undefined);
  }
  private existing(id: ObjectId | undefined): ObjectId | undefined {
    return id !== undefined && this.nodes.has(id) ? id : undefined;
  }
}
