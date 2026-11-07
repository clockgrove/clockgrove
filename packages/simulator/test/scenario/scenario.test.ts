import { describe, expect, it } from "vitest";
import { runScenario, SCENARIO_LIMITS, seedGenesis } from "../../src/index.js";
import { advance, ports, run, SECTION_EPOCH, scenario, yard } from "./harness.js";

// The committed goldens run runScenario end to end (variants, equivalence, retry, restart, perception,
// assertions). This file keeps the published refusal codes and the defect/refusal split no golden reaches.

const refusalOf = async (input: { artifact: unknown; source: unknown; scenario: unknown }) => {
  const result = await run(input);
  if (result.ok) throw new Error("expected a refusal");
  return { code: result.error.code, path: result.error.path };
};

describe("runScenario refusals", () => {
  it("refuses malformed input with the published codes and paths", async () => {
    const { source, artifact } = await yard();
    const good = scenario() as Record<string, any>;
    const { name: _name, ...nameless } = good;
    const cases: [string, string, unknown][] = [
      ["MALFORMED_INPUT", "input", null],
      ["MISSING_FIELD", "scenario.name", nameless],
      ["UNKNOWN_FIELD", "scenario.extra", { ...good, extra: 1 }],
      ["UNSUPPORTED_SCENARIO_KIND", "scenario.kind", { ...good, kind: "other" }],
      ["UNSUPPORTED_SCENARIO_VERSION", "scenario.schemaVersion", { ...good, schemaVersion: 2 }],
      [
        "UNKNOWN_STEP_KIND",
        "scenario.steps[0].kind",
        { ...good, steps: [{ kind: "wait", key: "w" }] },
      ],
      [
        "UNCATALOGUED_COMMAND",
        "scenario.steps[0].type",
        {
          ...good,
          steps: [{ kind: "command", key: "c", type: "nope.nothing", version: 1, payload: {} }],
        },
      ],
      ["PACK_MISMATCH", "scenario.pack", { ...good, pack: { id: "other", version: "1.0.0" } }],
      [
        "SCENARIO_BOUND_EXCEEDED",
        "scenario.steps",
        {
          ...good,
          steps: Array.from({ length: SCENARIO_LIMITS.steps + 1 }, (_, index) =>
            advance(`s${index}`, SECTION_EPOCH + 1n, "fast-forward"),
          ),
        },
      ],
      ["MALFORMED_INPUT", "scenario.recording", { ...good, recording: "sampled" }],
    ];
    for (const [code, path, document] of cases) {
      const input = document === null ? null : { artifact, source, scenario: document };
      expect(await refusalOf(input as never)).toEqual({ code, path });
    }
  });

  it("refuses steps for a pack without a behaviour policy", async () => {
    const { source, artifact } = await yard({
      edit: ({ docs, manifest }) => {
        delete docs["policies/behavior.json"];
        for (const path of Object.keys(docs)) if (path.startsWith("cognition/")) delete docs[path];
        manifest.cognitiveSeeds = [];
        manifest.policies = (manifest.policies as { id: string }[]).filter(
          (entry) => entry.id !== "sec.behavior",
        );
      },
    });
    expect(await refusalOf({ artifact, source, scenario: scenario() })).toEqual({
      code: "MISSING_BEHAVIOR_POLICY",
      path: "scenario.steps",
    });
  });

  it("passes seedGenesis refusals through and rethrows defects, told apart by the defect flag", async () => {
    const { source, artifact } = await yard();
    const broken = { ...(artifact as object), contentHash: "0".repeat(64) };
    const refused = await seedGenesis({ artifact: broken, source }, ports);
    if (refused.ok) throw new Error("expected seedGenesis to refuse the broken artifact");
    expect(refused).not.toHaveProperty("defect");
    const passed = await run({ artifact: broken, source, scenario: scenario() });
    expect(passed.ok ? null : passed.error).toEqual(refused.error);

    const hostile = { ...(artifact as object) };
    Object.defineProperty(hostile, "engineCompatibility", {
      enumerable: true,
      get() {
        throw new Error("artifact getter exploded");
      },
    });
    const defect = await seedGenesis({ artifact: hostile, source }, ports);
    expect(defect.ok ? null : defect.defect).toBe(true);
    await expect(
      runScenario({ artifact: hostile, source, scenario: scenario() }, ports),
    ).rejects.toThrow("internal defect");
  });
});
