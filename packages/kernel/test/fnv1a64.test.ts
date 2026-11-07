import { decodeDeterministicIdSeed } from "@clockgrove/contracts";
import { describe, expect, it } from "vitest";
import {
  createDeterministicIdSource,
  DETERMINISTIC_ID_ALGORITHM,
} from "../src/deterministic-id.js";
import { fnv1a64Hex } from "../src/fnv1a64.js";

describe("fnv1a64Hex", () => {
  it("pins the empty string, ASCII and non-BMP outputs", () => {
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325");
    expect(fnv1a64Hex("clockgrove")).toBe("1628d059c71a8c70");
    expect(fnv1a64Hex("a\u{1F600}b")).toBe("b6269913c2a5c4b2");
  });

  it("derives deterministic IDs from the prefix and the hash of their material", () => {
    const seed = decodeDeterministicIdSeed({
      commandId: "cmd-1",
      eventIndex: 3,
      randomStream: "stream",
    });
    const material = [DETERMINISTIC_ID_ALGORITHM, "cmd-1", "3", "stream", "Thing"].join("\u001f");
    expect(fnv1a64Hex(material)).toBe("b9cf5e72d4d279de");
    expect(createDeterministicIdSource(seed).next("Thing")).toBe("thing_b9cf5e72d4d279de");
  });
});
