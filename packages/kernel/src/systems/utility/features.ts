/**
 * The unit, range and meaning of every feature `clockgrove.routine-utility@1` records on a candidate
 * (`scoreUtility`). Feature values are fixed-point bigints; a reader outside the kernel (the
 * decision-shadow prompt) states each value with this scale so its magnitude is never guessed.
 */
export type UtilityFeatureScale =
  | Readonly<{ unit: "basis-points"; min: bigint; max: bigint; meaning: string }>
  | Readonly<{ unit: "flag"; meaning: string }>
  | Readonly<{ unit: "milliseconds"; meaning: string }>;

const share = (meaning: string): UtilityFeatureScale =>
  Object.freeze({ unit: "basis-points", min: 0n, max: 10000n, meaning });

export const UTILITY_FEATURE_SCALES: Readonly<Record<string, UtilityFeatureScale>> = Object.freeze({
  hunger: share("the actor's hunger; 0 is not hungry"),
  thirst: share("the actor's thirst; 0 is not thirsty"),
  wetness: share("how wet the actor is; 0 is dry"),
  rain: share("rain intensity where the actor is; 0 is no rain"),
  health: share("the actor's health; 10000 is full health"),
  uncomfortable: Object.freeze({
    unit: "flag",
    meaning: "the actor's needs make it uncomfortable",
  }),
  U: Object.freeze({
    unit: "basis-points",
    min: 10000n,
    max: 20000n,
    meaning: "urgency; 10000 while comfortable, rising as health falls while uncomfortable",
  }),
  travelMs: Object.freeze({
    unit: "milliseconds",
    meaning: "travel time to the target; 0 is already there",
  }),
  perceived: Object.freeze({
    unit: "flag",
    meaning:
      "the actor currently perceives the target; otherwise it is only believed or remembered",
  }),
  expectation: share(
    "the strength of the actor's belief or memory that the target serves the need",
  ),
  freshness: share("freshness of the food; 10000 is fresh"),
  protection: share("rain protection the shelter gives; 10000 is full protection"),
});
