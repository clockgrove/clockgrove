/** Versioned candidate kinds and scorer of the RW-0108b utility registry. */
export const UTILITY_SCORER = "clockgrove.routine-utility";
export const UTILITY_SCORER_VERSION = 1;
export const UTILITY_CANDIDATE_KINDS = Object.freeze([
  "stay",
  "seek-food",
  "seek-water",
  "seek-shelter",
] as const);
export const UTILITY_CANDIDATE_VERSION = 1;

/** Trace policy version: `<policy.version>/clockgrove.routine-utility@1`. */
export function utilityPolicyVersion(policyVersion: string): string {
  return `${policyVersion}/${UTILITY_SCORER}@${UTILITY_SCORER_VERSION}`;
}

/** Sorted (name, version) identity of the registry: candidate kinds and the scorer. */
export function utilityRegistryIdentity(): readonly (readonly [string, number])[] {
  const entries: [string, number][] = [
    [UTILITY_SCORER, UTILITY_SCORER_VERSION],
    ...UTILITY_CANDIDATE_KINDS.map((kind): [string, number] => [kind, UTILITY_CANDIDATE_VERSION]),
  ];
  return Object.freeze(
    entries
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
      .map((entry) => Object.freeze(entry) as readonly [string, number]),
  );
}
