import { integerSqrt } from "./parse.js";
import { type RegionShape, shapeContainsScaled } from "./region.js";

/** Exact rational with a positive denominator; the parameter of a segment, in [0, 1]. */
export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

export type Interval = readonly [Rational, Rational];

const ZERO: Rational = Object.freeze({ n: 0n, d: 1n });
const ONE: Rational = Object.freeze({ n: 1n, d: 1n });
/** Circle roots are computed with this many fractional bits of the square root. */
export const ROOT_FRACTION_BITS = 32n;

export function rational(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new RangeError("zero denominator");
  return d < 0n ? { n: -n, d: -d } : { n, d };
}

export function compareRational(left: Rational, right: Rational): number {
  const difference = left.n * right.d - right.n * left.d;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function maxRational(left: Rational, right: Rational): Rational {
  return compareRational(left, right) >= 0 ? left : right;
}
function minRational(left: Rational, right: Rational): Rational {
  return compareRational(left, right) <= 0 ? left : right;
}

export function isZero(value: Rational): boolean {
  return value.n === 0n;
}
export function isOne(value: Rational): boolean {
  return value.n === value.d;
}

/** The point p + s * (q - p) scaled by the returned denominator. */
function scaledPoint(
  from: readonly bigint[],
  to: readonly bigint[],
  s: Rational,
): { readonly coordinates: readonly bigint[]; readonly scale: bigint } {
  return {
    coordinates: from.map((value, axis) => value * s.d + (to[axis]! - value) * s.n),
    scale: s.d,
  };
}

function pointInside(
  shape: RegionShape,
  from: readonly bigint[],
  to: readonly bigint[],
  s: Rational,
) {
  const { coordinates, scale } = scaledPoint(from, to, s);
  return shapeContainsScaled(shape, coordinates, scale);
}

/**
 * The closed parameter intervals of the segment `from`->`to` (non-degenerate) that lie inside the
 * shape, boundary included. Intervals are exact rationals except circle roots, which are rounded
 * inward at {@link ROOT_FRACTION_BITS} fractional bits. A single-point interval is a boundary touch.
 */
export function segmentIntervals(
  shape: RegionShape,
  from: readonly bigint[],
  to: readonly bigint[],
): readonly Interval[] {
  switch (shape.kind) {
    case "rectangle":
    case "box": {
      let low = ZERO;
      let high = ONE;
      for (let axis = 0; axis < shape.min.length; axis += 1) {
        const start = from[axis]!;
        const delta = to[axis]! - start;
        const lo = shape.min[axis]!;
        const hi = shape.max[axis]!;
        if (delta === 0n) {
          if (start < lo || start > hi) return [];
          continue;
        }
        const first = rational(lo - start, delta);
        const second = rational(hi - start, delta);
        low = maxRational(low, minRational(first, second));
        high = minRational(high, maxRational(first, second));
      }
      return compareRational(low, high) > 0 ? [] : [[low, high]];
    }
    case "circle": {
      const dx = to[0]! - from[0]!;
      const dy = to[1]! - from[1]!;
      const ex = from[0]! - shape.center[0];
      const ey = from[1]! - shape.center[1];
      const a = dx * dx + dy * dy;
      if (a === 0n) return shapeContainsScaled(shape, from, 1n) ? [[ZERO, ONE]] : [];
      const halfB = dx * ex + dy * ey;
      const c = ex * ex + ey * ey - shape.radius * shape.radius;
      const discriminant = halfB * halfB - a * c;
      if (discriminant < 0n) return [];
      const scale = 1n << ROOT_FRACTION_BITS;
      const root = integerSqrt(discriminant << (2n * ROOT_FRACTION_BITS));
      let low = rational(-halfB * scale - root, a * scale);
      let high = rational(-halfB * scale + root, a * scale);
      if (pointInside(shape, from, to, ZERO)) low = ZERO;
      if (pointInside(shape, from, to, ONE)) high = ONE;
      low = maxRational(low, ZERO);
      high = minRational(high, ONE);
      return compareRational(low, high) > 0 ? [] : [[low, high]];
    }
    case "polygon": {
      const breakpoints: Rational[] = [ZERO, ONE];
      const dx = to[0]! - from[0]!;
      const dy = to[1]! - from[1]!;
      const count = shape.vertices.length;
      const within = (value: Rational) =>
        compareRational(value, ZERO) >= 0 && compareRational(value, ONE) <= 0;
      for (let index = 0; index < count; index += 1) {
        const a = shape.vertices[index]!;
        const b = shape.vertices[(index + 1) % count]!;
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const denominator = dx * ey - dy * ex;
        const ax = a[0] - from[0]!;
        const ay = a[1] - from[1]!;
        if (denominator === 0n) {
          if (ax * dy - ay * dx !== 0n) continue;
          // Collinear with the edge: its endpoints, projected onto the segment, are breakpoints.
          const length2 = dx * dx + dy * dy;
          for (const [px, py] of [
            [ax, ay],
            [b[0] - from[0]!, b[1] - from[1]!],
          ] as const) {
            const s = rational(px * dx + py * dy, length2);
            if (within(s)) breakpoints.push(s);
          }
          continue;
        }
        const s = rational(ax * ey - ay * ex, denominator);
        const u = rational(ax * dy - ay * dx, denominator);
        if (within(s) && compareRational(u, ZERO) >= 0 && compareRational(u, ONE) <= 0)
          breakpoints.push(s);
      }
      breakpoints.sort(compareRational);
      const unique = breakpoints.filter(
        (value, index) => index === 0 || compareRational(breakpoints[index - 1]!, value) !== 0,
      );
      const intervals: Interval[] = [];
      let runStart: Rational | undefined;
      for (let index = 0; index < unique.length; index += 1) {
        const here = unique[index]!;
        if (pointInside(shape, from, to, here)) {
          runStart ??= here;
        } else if (runStart !== undefined) {
          intervals.push([runStart, unique[index - 1]!]);
          runStart = undefined;
        }
        const next = unique[index + 1];
        if (next !== undefined) {
          const middle = rational(here.n * next.d + next.n * here.d, 2n * here.d * next.d);
          if (!pointInside(shape, from, to, middle) && runStart !== undefined) {
            intervals.push([runStart, here]);
            runStart = undefined;
          }
        }
      }
      if (runStart !== undefined) intervals.push([runStart, unique[unique.length - 1]!]);
      return intervals;
    }
  }
}
