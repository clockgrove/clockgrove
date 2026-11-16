// Long-run suite (pnpm test:long-run): every lifecycle horizon (30 days and one year) and the whole
// evidence section, which embeds every long run.
import { describe, expect } from "vitest";
import { lifecycleEvidence } from "./lifecycle.scenario.js";
import { it, longRunTests } from "./lifecycle-long-run.js";

describe("long runs", () => {
  longRunTests(() => true);
});

describe("evidence", () => {
  it("builds a section the executable schema accepts", async () => {
    const { lifecycleEvidenceProblems } = await import("./lifecycle-evidence.js");
    const evidence = await lifecycleEvidence();
    expect(lifecycleEvidenceProblems(evidence)).toEqual([]);
    expect(
      JSON.stringify(evidence, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ).length,
    ).toBeLessThan(1048576);
  }, 240000);
});
