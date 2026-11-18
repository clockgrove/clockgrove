/**
 * The unit, range and meaning of every feature `clockgrove.routine-utility@1` records on a candidate
 * (`scoreUtility`). Feature values are fixed-point bigints; a reader outside the kernel (the
 * decision-shadow prompt) states each value with this scale so its magnitude is never guessed.
 */
export type UtilityFeatureLevel = "actor" | "candidate";

/** `level` says whether the feature describes the actor (recorded on every candidate) or one candidate. */
export type UtilityFeatureScale =
  | Readonly<{
      unit: "basis-points";
      level: UtilityFeatureLevel;
      min: bigint;
      max: bigint;
      meaning: string;
    }>
  | Readonly<{ unit: "flag"; level: UtilityFeatureLevel; meaning: string }>
  | Readonly<{ unit: "milliseconds"; level: UtilityFeatureLevel; meaning: string }>;

const share = (level: UtilityFeatureLevel, meaning: string): UtilityFeatureScale =>
  Object.freeze({ unit: "basis-points", level, min: 0n, max: 10000n, meaning });

export const UTILITY_FEATURE_SCALES: Readonly<Record<string, UtilityFeatureScale>> = Object.freeze({
  hunger: share("actor", "the actor's hunger; 0 is not hungry"),
  thirst: share("actor", "the actor's thirst; 0 is not thirsty"),
  wetness: share("actor", "how wet the actor is; 0 is dry"),
  rain: share("actor", "rain intensity where the actor is; 0 is no rain"),
  health: share("actor", "the actor's health; 10000 is full health"),
  uncomfortable: Object.freeze({
    unit: "flag",
    level: "actor",
    meaning: "the actor's needs make it uncomfortable",
  }),
  U: Object.freeze({
    unit: "basis-points",
    level: "actor",
    min: 10000n,
    max: 20000n,
    meaning: "urgency; 10000 while comfortable, rising as health falls while uncomfortable",
  }),
  travelMs: Object.freeze({
    unit: "milliseconds",
    level: "candidate",
    meaning: "travel time to the target; 0 is already there",
  }),
  perceived: Object.freeze({
    unit: "flag",
    level: "candidate",
    meaning:
      "the actor currently perceives the target; otherwise it is only believed or remembered",
  }),
  remembered: Object.freeze({
    unit: "flag",
    meaning: "the actor holds a memory of the target, so it is familiar even out of view",
  }),
  expectation: share(
    "candidate",
    "the strength of the actor's belief or memory that the target serves the need",
  ),
  freshness: share("candidate", "freshness of the food; 10000 is fresh"),
  protection: share("candidate", "rain protection the shelter gives; 10000 is full protection"),
});

/** Names of the features that describe the actor, in declaration order. */
export const UTILITY_ACTOR_FEATURES: readonly string[] = Object.freeze(
  Object.entries(UTILITY_FEATURE_SCALES)
    .filter(([, scale]) => scale.level === "actor")
    .map(([name]) => name),
);

/**
 * The coarse band of a feature value, for grouping situations: a flag is `yes` or `no`, a
 * basis-points value the quarter (`0` to `3`) of its declared range it falls in. Milliseconds are
 * not banded.
 */
export function utilityFeatureBand(name: string, value: bigint): string {
  const scale = Object.hasOwn(UTILITY_FEATURE_SCALES, name)
    ? UTILITY_FEATURE_SCALES[name]
    : undefined;
  if (scale === undefined) throw new RangeError(`no declared scale for feature ${name}`);
  if (scale.unit === "flag") return value === 10000n ? "yes" : "no";
  if (scale.unit === "milliseconds") throw new RangeError(`feature ${name} is not banded`);
  const clamped = value < scale.min ? scale.min : value > scale.max ? scale.max : value;
  const quarter = ((clamped - scale.min) * 4n) / (scale.max - scale.min);
  return (quarter > 3n ? 3n : quarter).toString();
}
