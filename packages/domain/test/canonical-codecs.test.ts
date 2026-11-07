import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createInitialComponentCatalog, type NeedsState } from "../src/components/catalog/index.js";
import {
  type ComponentRegistration,
  type ComponentValidationContext,
  CompositionError,
  createCanonicalCodec,
  createComponentRegistry,
  immutableCopy,
} from "../src/components/registry/index.js";

// Component state is stored and hashed as canonical text. This keeps the codec properties no golden
// reaches: fixed bytes, refusal of every alternative encoding, and hostile plain data.

const context = {
  tenantId: "tenant",
  worldId: "world",
  timelineId: "timeline",
  objectId: "object",
  simulationTime: 0n,
  spatialFrames: [],
  expectedArchetype: { id: "test", version: 1 },
  expectedTraits: [],
} as unknown as ComponentValidationContext;
const schema = z.strictObject({ count: z.bigint(), label: z.string() });
const registration: ComponentRegistration<z.infer<typeof schema>> = {
  type: "Test",
  version: 1,
  schema,
  canonicalCodec: createCanonicalCodec("Test", 1, schema),
  validateState: () => [],
  redact: (value) => value,
  upcasters: [],
};
const snapshot = { type: "Test", version: 1, state: { count: 2n, label: "old" } };

function failure(action: () => unknown, code: string, path: string) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CompositionError);
    expect(error).toMatchObject({ code, path });
    return;
  }
  throw new Error("expected failure");
}

describe("canonical component codecs", () => {
  it("fixes the canonical bytes of a production component", () => {
    const needs = createInitialComponentCatalog().find(
      (entry) => entry.type === "clockgrove.needs",
    )!;
    const value = {
      hunger: 10_000,
      wetness: 0,
      integratedAt: 99n,
      hungerRemainder: 1n,
      wetnessRemainder: 2n,
    } as NeedsState;
    const canonical = needs.canonicalCodec.encode(value as never);
    expect(canonical).toBe(
      '{"type":"clockgrove.needs","version":1,"state":{"hunger":10000,"wetness":0,"integratedAt":"99","hungerRemainder":"1","wetnessRemainder":"2"}}',
    );
    for (const replacement of ['"099"', '"+99"', '"9.9e1"', "99", '"-0"', '" 99"'])
      expect(() => needs.canonicalCodec.decode(canonical.replace('"99"', replacement))).toThrow();
  });

  it("refuses alternative encodings and codecs that discard state", () => {
    const registry = createComponentRegistry([registration]);
    const canonical = registry.encode(snapshot, context);
    failure(
      () => registry.decode("Test", 1, ` ${canonical}`, context),
      "INVALID_STATE",
      "component.state",
    );
    failure(
      () =>
        registry.decode("Test", 1, canonical.replace('["bigint","2"]', '["bigint","02"]'), context),
      "INVALID_STATE",
      "component.state",
    );
    const lossy = createComponentRegistry([
      {
        ...registration,
        canonicalCodec: { encode: () => "constant", decode: () => ({ count: 0n, label: "x" }) },
      },
    ]);
    failure(() => lossy.encode(snapshot, context), "INVALID_STATE", "component.state");
  });

  it("refuses accessors without invoking them, cycles and non-canonical numbers", () => {
    let invoked = false;
    const accessor = {
      get value() {
        invoked = true;
        return 1;
      },
    };
    failure(() => immutableCopy(accessor), "INVALID_STATE", "value.value");
    expect(invoked).toBe(false);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    failure(() => immutableCopy(cycle), "INVALID_STATE", "value.self");
    for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, -0, new Date()])
      failure(() => immutableCopy(value), "INVALID_STATE", "value");
  });
});
