// Canonical golden decoding for the qualify-wave tests, once per distinct content.
// Every manifest build and validation decodes all committed goldens (about 19 MB) with the strict
// decoder, which parses, decodes and re-encodes each to compare the bytes: CPU-bound work of roughly
// 0.8 s a pass. The tests build and validate many times, and on CI's shared 4-CPU runner, with every
// package's Vitest running at once, the repeats took a Wave 3 test past its 30 s timeout. Decoding is
// a pure function of the bytes, so the value cached under their digest is the value a fresh decode
// gives. Callers only read it.
import { decodeCanonicalBytes } from "../../packages/simulator/src/canonical-decode.ts";
import { digest } from "../../scripts/ci/evidence.mjs";

const decoded = new Map();

/** The decoded value of canonical `bytes`, or undefined when they are not canonical. */
export function decode(bytes) {
  const key = digest(bytes);
  if (!decoded.has(key)) decoded.set(key, decodeCanonicalBytes(new Uint8Array(bytes)).value);
  return decoded.get(key);
}
