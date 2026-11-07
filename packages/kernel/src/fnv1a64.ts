const OFFSET_BASIS = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;

/** FNV-1a 64 over the Unicode code points of the text, as 16 lowercase hex digits. */
export function fnv1a64Hex(value: string): string {
  let hash = OFFSET_BASIS;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * PRIME);
  }
  return hash.toString(16).padStart(16, "0");
}
