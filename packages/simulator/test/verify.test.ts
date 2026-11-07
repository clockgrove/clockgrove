import { canonicalBytes } from "@clockgrove/kernel";
import { buildWorldPack } from "@clockgrove/world-pack-sdk";
import { describe, expect, it } from "vitest";
import { decodeCanonicalBytes } from "../src/canonical-decode.js";
import { createSimulatorPackPorts, seedGenesis, verifyGenesisBundle } from "../src/index.js";
import { buildLampYardSource, sha256Hex } from "./fixtures/lamp-yard.js";

// Conformance verifies the untampered bundle of every committed pack. This file keeps the tamper
// property: every bundle field is bound by bundleHash and by a fresh re-seeding, and bundle bytes must
// be strictly canonical.

const ports = { sha256: sha256Hex };
type Rec = Record<string, unknown>;

async function fixture() {
  const source = await buildLampYardSource();
  const built = await buildWorldPack(source, createSimulatorPackPorts(ports));
  if (!built.ok) throw new Error(`fixture build failed: ${JSON.stringify(built.error)}`);
  const seeded = await seedGenesis({ artifact: built.value.artifact, source }, ports);
  if (!seeded.ok) throw new Error(`seeding refused: ${JSON.stringify(seeded.error)}`);
  const decoded = decodeCanonicalBytes(seeded.value.bytes);
  if (!decoded.ok) throw new Error("fixture bundle did not decode");
  return {
    source,
    artifact: built.value.artifact,
    bytes: seeded.value.bytes,
    bundle: decoded.value as Rec,
  };
}

async function rehash(bundle: Rec): Promise<Rec> {
  const { bundleHash: _drop, ...rest } = bundle;
  return { ...rest, bundleHash: await sha256Hex(canonicalBytes(rest)) };
}

/** A same-typed change of the first leaf under a field, so the bytes stay a valid bundle. */
function tamper(value: unknown): unknown {
  if (Array.isArray(value))
    return value.length === 0 ? ["x"] : [tamper(value[0]), ...value.slice(1)];
  if (value instanceof Map || value instanceof Set) return tamper([...value]);
  if (typeof value === "object" && value !== null) {
    const [key] = Object.keys(value);
    return key === undefined ? { tampered: "x" } : { ...value, [key]: tamper((value as Rec)[key]) };
  }
  if (typeof value === "string") return `${value}x`;
  if (typeof value === "bigint") return value + 1n;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  return "x";
}

describe("verifyGenesisBundle", () => {
  it("binds every bundle field by bundleHash and by a fresh re-seeding", async () => {
    const { artifact, source, bundle } = await fixture();
    const fields = Object.keys(bundle).filter(
      (key) => !["kind", "version", "bundleHash"].includes(key),
    );
    expect(fields.length).toBeGreaterThan(10);
    const failures: string[] = [];
    for (const field of fields) {
      const mutated = { ...bundle, [field]: tamper(bundle[field]) };
      const stale = await verifyGenesisBundle(
        { bundle: canonicalBytes(mutated), artifact, source },
        ports,
      );
      if (stale.ok || stale.error.code !== "BUNDLE_HASH_MISMATCH") failures.push(`${field} stale`);
      const fresh = await verifyGenesisBundle(
        { bundle: canonicalBytes(await rehash(mutated)), artifact, source },
        ports,
      );
      if (
        fresh.ok ||
        fresh.error.code !== "BUNDLE_FIELD_MISMATCH" ||
        fresh.error.path !== `bundle.${field}`
      )
        failures.push(`${field} rehashed`);
    }
    expect(failures).toEqual([]);
  });

  it("refuses bundle bytes that are not strictly canonical", async () => {
    const { artifact, source, bytes } = await fixture();
    const malformed = { code: "MALFORMED_BUNDLE", path: "bundle", message: expect.any(String) };
    for (const bundle of [
      new TextEncoder().encode(` ${new TextDecoder().decode(bytes)}`),
      Uint8Array.from([...bytes, 0xff]),
      Uint8Array.from([0xc3, 0x28]),
    ])
      expect(await verifyGenesisBundle({ bundle, artifact, source }, ports)).toEqual({
        ok: false,
        error: malformed,
      });
  });
});
