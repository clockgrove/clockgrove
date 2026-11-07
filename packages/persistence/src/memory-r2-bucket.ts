import { type R2BucketLike, sha256Hex } from "./r2-bucket.js";

/**
 * In-memory R2 bucket for tests and local composition. Like R2, it refuses a `put` whose bytes do not
 * match the `sha256` option. `objects` is public so a test can alter, truncate or delete stored
 * bytes, and `gets` counts every read, including misses.
 */
export class MemoryR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, Uint8Array>();
  gets = 0;

  async put(key: string, value: Uint8Array, options: { readonly sha256: string }): Promise<void> {
    if ((await sha256Hex(value)) !== options.sha256) {
      throw new Error("the object does not match its sha256");
    }
    this.objects.set(key, value.slice());
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    this.gets += 1;
    const value = this.objects.get(key);
    return value === undefined ? null : { arrayBuffer: async () => value.slice().buffer };
  }
}
