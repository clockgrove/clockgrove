/**
 * Adapter-local structural boundary for blob storage: the `put`/`get` subset of the Workers R2
 * binding. R2 refuses a `put` whose bytes do not match the `sha256` option, so a corrupted upload is
 * never stored. Provider types do not leak inward.
 */
export interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array,
    options: { readonly sha256: string; readonly httpMetadata: { readonly contentType: string } },
  ): Promise<unknown>;
  /** `null` when no object exists at the key. */
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export function lowercaseHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Lowercase hex SHA-256 through WebCrypto, available in Node and Workers. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return lowercaseHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
