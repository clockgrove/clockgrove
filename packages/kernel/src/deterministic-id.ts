import type { DeterministicIdSeed, DeterministicIdSource, OpaqueId } from "@clockgrove/contracts";
import { fnv1a64Hex } from "./fnv1a64.js";

export const DETERMINISTIC_ID_ALGORITHM = "clockgrove-fnv1a64-v1";

/**
 * Builds a stateless event-scoped ID source. The event index belongs in the seed, so callers make
 * one source per event/draft rather than depending on a hidden process-local counter.
 */
export function createDeterministicIdSource(seed: DeterministicIdSeed): DeterministicIdSource {
  if (!Number.isSafeInteger(seed.eventIndex) || seed.eventIndex < 0) {
    throw new RangeError("deterministic ID event index must be a non-negative safe integer");
  }
  if (seed.randomStream.length === 0) {
    throw new RangeError("deterministic ID random stream must not be empty");
  }
  const frozenSeed = Object.freeze({ ...seed });
  return Object.freeze({
    seed: frozenSeed,
    next<Name extends string>(name: Name): OpaqueId<Name> {
      if (name.length === 0) throw new RangeError("deterministic ID name must not be empty");
      const material = [
        DETERMINISTIC_ID_ALGORITHM,
        frozenSeed.commandId,
        String(frozenSeed.eventIndex),
        frozenSeed.randomStream,
        name,
      ].join("\u001f");
      return `${name.toLowerCase()}_${fnv1a64Hex(material)}` as OpaqueId<Name>;
    },
  });
}
