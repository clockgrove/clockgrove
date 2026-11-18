// Lineages that already passed `validateLifecycleState` and are deep-frozen (#358). A full lineage
// holds 1,024 dead; validating and copying it on every reduced event would cost a long-lived world
// for the rest of its life. `createWorldState` seals the lineage of each state it returns, and the
// next state that shares that frozen array skips both. Not exported from the package: only a frozen
// copy made by `createWorldState` is ever sealed.
const sealed = new WeakSet<object>();

/** True when `lineage` is a deep-frozen lineage that `createWorldState` already validated. */
export function isSealedLifecycleLineage(lineage: unknown): boolean {
  return typeof lineage === "object" && lineage !== null && sealed.has(lineage);
}

/** Seals the deep-frozen, validated lineage of a state `createWorldState` returns. */
export function sealLifecycleLineage(lineage: readonly unknown[] | undefined): void {
  if (lineage !== undefined && Object.isFrozen(lineage)) sealed.add(lineage);
}
