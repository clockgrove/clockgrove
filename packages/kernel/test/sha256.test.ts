import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/index.js";

describe("sha256Hex", () => {
  it("matches WebCrypto SHA-256 for every padding boundary", async () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 255);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const expected = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      expect(sha256Hex(bytes)).toBe(expected);
    }
  });
});
