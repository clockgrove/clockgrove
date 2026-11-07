/** Exact integer k-th root (floor) of a non-negative bigint, by binary search. */
function integerRoot(value: bigint, degree: bigint): bigint {
  let low = 0n;
  let high = 1n << (BigInt(value.toString(2).length) / degree + 1n);
  while (low < high) {
    const middle = (low + high + 1n) >> 1n;
    if (middle ** degree <= value) low = middle;
    else high = middle - 1n;
  }
  return low;
}

function firstPrimes(count: number): number[] {
  const primes: number[] = [];
  for (let candidate = 2; primes.length < count; candidate += 1) {
    if (primes.every((prime) => candidate % prime !== 0)) primes.push(candidate);
  }
  return primes;
}

const PRIMES = firstPrimes(64);
/** Fractional parts of the cube roots of the first 64 primes (FIPS 180-4), computed exactly. */
const ROUND_CONSTANTS = Uint32Array.from(PRIMES, (prime) =>
  Number(integerRoot(BigInt(prime) << 96n, 3n) & 0xffffffffn),
);
/** Fractional parts of the square roots of the first 8 primes (FIPS 180-4), computed exactly. */
const INITIAL_STATE = Uint32Array.from(PRIMES.slice(0, 8), (prime) =>
  Number(integerRoot(BigInt(prime) << 64n, 2n) & 0xffffffffn),
);

const rotateRight = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

/** Pure SHA-256 of the bytes as 64 lowercase hex characters; no ambient crypto is used. */
export function sha256Hex(bytes: Uint8Array): string {
  const length = bytes.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const state = Uint32Array.from(INITIAL_STATE);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + 4 * index);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]!;
      const b = words[index - 2]!;
      const small0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const small1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] = words[index - 16]! + small0 + words[index - 7]! + small1;
    }
    let [a, b, c, d, e, f, g, h] = [...state] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let index = 0; index < 64; index += 1) {
      const big1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (h + big1 + choose + ROUND_CONSTANTS[index]! + words[index]!) | 0;
      const big0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (big0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) | 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) | 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) state[index] = state[index]! + next[index]!;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}
