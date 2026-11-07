import type {
  BindingId,
  CapabilityId,
  OpaqueId,
  PrincipalId,
  SimTimeMs,
  SpaceId,
  TenantId,
  TimelineId,
  WorldId,
  WorldObjectId,
} from "@clockgrove/contracts";
import type {
  ComponentMap,
  ComponentSnapshot,
  DefinitionRef,
} from "../components/registry/index.js";

export type ArchetypeId = OpaqueId<"ArchetypeId">;
export type TraitId = OpaqueId<"TraitId">;
export interface VersionedArchetypeRef extends DefinitionRef {
  readonly id: ArchetypeId;
}
export interface VersionedTraitRef extends DefinitionRef {
  readonly id: TraitId;
}
/** A typed replacement of one complete, explicitly versioned component. */
export type TypedComponentPatch<T = unknown> = ComponentSnapshot<T>;
/** Durable declaration only; this checkpoint neither installs nor invokes capabilities. */
export interface CapabilityBinding {
  readonly id: BindingId;
  readonly capabilityId: CapabilityId;
  readonly version: number;
}
export type TraitConflictResolutions = Readonly<Record<string, VersionedTraitRef>>;
export interface ArchetypeDefinition {
  readonly id: ArchetypeId;
  readonly version: number;
  readonly traits: readonly VersionedTraitRef[];
  readonly components: ComponentMap;
  readonly conflictResolutions?: TraitConflictResolutions;
}
export interface TraitDefinition {
  readonly id: TraitId;
  readonly version: number;
  readonly traits: readonly VersionedTraitRef[];
  readonly components: ComponentMap;
}
export interface WorldObjectDefinition {
  readonly id: WorldObjectId;
  readonly worldId: WorldId;
  readonly archetype: VersionedArchetypeRef;
  readonly traits: readonly VersionedTraitRef[];
  readonly overrides: readonly TypedComponentPatch[];
  readonly owner?: PrincipalId;
  readonly capabilities: readonly CapabilityBinding[];
  readonly conflictResolutions?: TraitConflictResolutions;
}
export interface TimelineObjectState {
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly objectId: WorldObjectId;
  readonly spaceId: SpaceId;
  readonly containerId?: WorldObjectId;
  readonly components: ComponentMap;
  readonly lifecycleStatus: "active" | "dormant" | "retired" | "dead";
  readonly revision: bigint;
}
export interface EffectiveObject {
  readonly tenantId: TenantId;
  readonly simulationTime: SimTimeMs;
  readonly definition: WorldObjectDefinition;
  /** Includes recursively composed traits, once each, in UTF-16 identity order. */
  readonly traitPins: readonly VersionedTraitRef[];
  readonly state: TimelineObjectState;
}
