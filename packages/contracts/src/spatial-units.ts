/** The spatial units the engine knows, with metres per unit. */
export const SPATIAL_UNITS: Readonly<Record<string, number>> = Object.freeze({
  meter: 1,
  metre: 1,
  millimeter: 0.001,
  millimetre: 0.001,
});

/** Metres per unit for a known unit name; undefined for any other name. */
export function metresPerUnit(name: string): number | undefined {
  return Object.hasOwn(SPATIAL_UNITS, name) ? SPATIAL_UNITS[name] : undefined;
}

/** The known unit names, for refusal messages. */
export const SPATIAL_UNIT_NAMES = Object.freeze(Object.keys(SPATIAL_UNITS));
