import { bytesEqual, decodeCanonicalBytes } from "../src/canonical-decode.js";

export { bytesEqual };

export interface BundleDifference {
  /** Differing top-level fields, sorted. */
  readonly fields: readonly string[];
  /** The first differing paths, at most `PATH_LIMIT`. */
  readonly paths: readonly string[];
}

export const PATH_LIMIT = 8;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array);

function collect(left: unknown, right: unknown, path: string, out: string[]): void {
  if (out.length >= PATH_LIMIT) return;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length)
      out.push(`${path}.length (${left.length} != ${right.length})`);
    for (let index = 0; index < Math.min(left.length, right.length); index += 1)
      collect(left[index], right[index], `${path}[${index}]`, out);
    return;
  }
  if (isPlain(left) && isPlain(right)) {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort())
      collect(left[key], right[key], `${path}.${key}`, out);
    return;
  }
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (!bytesEqual(left, right)) out.push(path);
    return;
  }
  if (left !== right) out.push(path);
}

/** Semantic difference between two decoded canonical documents; `root` names them in the paths. */
export function differenceOf(left: unknown, right: unknown, root: string): BundleDifference {
  const paths: string[] = [];
  collect(left, right, root, paths);
  if (!isPlain(left) || !isPlain(right)) return { fields: [], paths };
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort()
    .filter((key) => {
      const probe: string[] = [];
      collect(left[key], right[key], key, probe);
      return probe.length > 0;
    });
  return { fields, paths };
}

/** Semantic difference between a golden and an actual bundle, from their decoded canonical bytes. */
export function describeDifference(
  golden: Uint8Array,
  actual: Uint8Array,
): BundleDifference | "golden-not-canonical" {
  const left = decodeCanonicalBytes(golden);
  const right = decodeCanonicalBytes(actual);
  if (!left.ok) return "golden-not-canonical";
  if (!right.ok || !isPlain(left.value) || !isPlain(right.value))
    return { fields: ["<actual bundle is not canonical>"], paths: [] };
  return differenceOf(left.value, right.value, "bundle");
}
