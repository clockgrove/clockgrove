import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packBuild, packTest, REPO_ROOT, temporaryDirectory } from "./helpers.js";

// Long-run suite (pnpm test:long-run): `pack test` over the committed reference fixture pack, which runs its
// full scenario set. pack.test.ts covers the same CLI path with the small fixture pack.
let scratch: Awaited<ReturnType<typeof temporaryDirectory>>;
let referenceArtifact: string;

beforeAll(async () => {
  scratch = await temporaryDirectory();
  referenceArtifact = join(scratch.path, "reference.artifact");
  expect((await packBuild("worlds/fixture/reference", referenceArtifact)).run.exitCode).toBe(0);
});
afterAll(() => scratch.dispose());

describe("pack test", () => {
  it("passes every check for the committed reference fixture pack", async () => {
    const { run, envelope, checks } = await packTest(referenceArtifact);
    const scenarios = (await readdir(join(REPO_ROOT, "worlds/fixture/reference/scenarios")))
      .map((file) => file.slice(0, -".json".length))
      .sort();
    expect(scenarios).toHaveLength(11);
    expect(run.exitCode).toBe(0);
    expect(envelope.status).toBe("ok");
    expect(envelope.refusal).toBeNull();
    expect(checks).toEqual([
      { name: "artifact-integrity", scenario: null, status: "passed" },
      { name: "seed-genesis", scenario: null, status: "passed" },
      ...scenarios.flatMap((scenario) => [
        { name: "scenario-assertions", scenario, status: "passed" },
        { name: "golden-match", scenario, status: "passed" },
      ]),
    ]);
  });
});
