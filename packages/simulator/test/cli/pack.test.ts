import { access, cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalBytes, sha256Hex } from "@clockgrove/kernel";
import { WORLD_PACK_BUILD_TOOL_VERSION } from "@clockgrove/world-pack-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeCanonicalBytes } from "../../src/canonical-decode.js";
import {
  type ArtifactDocument,
  packBuild as build,
  type CheckRow,
  packTest,
  REPO_ROOT,
  readEnvelope,
  runExecutable,
  stableBytes,
  tamperArtifact,
  temporaryDirectory,
} from "./helpers.js";

let scratch: Awaited<ReturnType<typeof temporaryDirectory>>;
let fixtureArtifact: string;

beforeAll(async () => {
  scratch = await temporaryDirectory();
  fixtureArtifact = join(scratch.path, "fixture.artifact");
  expect((await build("worlds/fixture", fixtureArtifact)).run.exitCode).toBe(0);
});
afterAll(() => scratch.dispose());

/** A copy of the fixture pack with one resource byte appended, so its manifest sha256 no longer matches. */
async function mismatchedPack(name: string): Promise<string> {
  const directory = join(scratch.path, name);
  await cp(join(REPO_ROOT, "worlds/fixture"), directory, { recursive: true });
  const resource = join(directory, "resources/archetypes/keeper.json");
  await writeFile(resource, Buffer.concat([await readFile(resource), Buffer.from(" ")]));
  return directory;
}

describe("pack validate", () => {
  it("accepts a committed pack with one versioned result document", async () => {
    const run = await runExecutable(["pack", "validate", "--pack", "worlds/fixture"]);
    const envelope = readEnvelope(run.stdout);
    expect(run.exitCode).toBe(0);
    expect(envelope).toMatchObject({
      kind: "clockgrove.cli-result",
      version: 1,
      command: "pack validate",
      status: "ok",
      exitCode: 0,
      refusal: null,
      result: {
        packId: "clockgrove.test-world",
        version: "1.1.0",
        findings: [{ code: "SUPERSEDED_EVENT_VERSION" }],
      },
    });
  });
});

describe("pack build", () => {
  it("writes a pack artifact file and reports the artifact reference and the file bundleHash", async () => {
    const out = join(scratch.path, "fixture-report.artifact");
    const { run, envelope } = await build("worlds/fixture", out);
    expect(run.exitCode).toBe(0);
    const result = envelope.result as { artifact: Record<string, string>; bundleHash: string };
    expect(result.artifact).toMatchObject({
      packId: "clockgrove.test-world",
      version: "1.1.0",
      buildToolVersion: WORLD_PACK_BUILD_TOOL_VERSION,
    });
    const decoded = decodeCanonicalBytes(new Uint8Array(await readFile(out)));
    if (!decoded.ok) throw new Error("artifact file is not canonical bytes");
    const { bundleHash, ...withoutHash } = decoded.value as Record<string, unknown>;
    expect(withoutHash.kind).toBe("clockgrove.pack-artifact");
    expect(withoutHash.artifact).toEqual(result.artifact);
    expect(bundleHash).toBe(result.bundleHash);
    expect(sha256Hex(canonicalBytes(withoutHash))).toBe(result.bundleHash);
  });

  it("is reproducible: the same pack from a copy at another path gives an identical file and result", async () => {
    const copy = join(scratch.path, "copies/fixture-copy");
    await cp(join(REPO_ROOT, "worlds/fixture"), copy, { recursive: true });
    const again = await build(copy, join(scratch.path, "again.artifact"));
    expect(again.run.exitCode).toBe(0);
    expect(
      Buffer.compare(
        await readFile(join(scratch.path, "again.artifact")),
        await readFile(fixtureArtifact),
      ),
    ).toBe(0);
    const original = await build("worlds/fixture", join(scratch.path, "original.artifact"));
    expect(Buffer.compare(stableBytes(again.envelope), stableBytes(original.envelope))).toBe(0);
  });

  it("exits 2 and leaves an existing --out file unchanged", async () => {
    const out = join(scratch.path, "existing.artifact");
    await writeFile(out, "keep me");
    const { run, envelope } = await build("worlds/fixture", out);
    expect(run.exitCode).toBe(2);
    expect(envelope.status).toBe("usage");
    expect(envelope.refusal).toMatchObject({ code: "OUT_EXISTS", path: "--out" });
    expect(await readFile(out, "utf8")).toBe("keep me");
  });

  it("exits 1 with the SDK refusal unchanged and writes no file when the SDK refuses the build", async () => {
    const out = join(scratch.path, "refused.artifact");
    const { run, envelope } = await build(await mismatchedPack("build-mismatch"), out);
    expect(run.exitCode).toBe(1);
    expect(envelope.status).toBe("failed");
    expect(envelope.refusal).toMatchObject({
      code: "HASH_MISMATCH",
      path: "manifest.archetypes[0].sha256",
    });
    await expect(access(out)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("pack test", () => {
  // The committed reference fixture pack runs through pack test in pack.long-run.test.ts.
  it("passes every check for the committed fixture pack", async () => {
    const { run, checks } = await packTest(fixtureArtifact);
    expect(run.exitCode).toBe(0);
    expect(checks).toEqual([
      { name: "artifact-integrity", scenario: null, status: "passed" },
      { name: "seed-genesis", scenario: null, status: "passed" },
      { name: "scenario-assertions", scenario: "neutral-conformance", status: "passed" },
      { name: "golden-match", scenario: "neutral-conformance", status: "passed" },
    ]);
  });

  const DEFECTS: readonly {
    readonly name: string;
    readonly edit: (document: ArtifactDocument) => void;
    readonly failing: CheckRow["name"];
    readonly scenario: string | null;
    readonly refusal: { readonly code: string; readonly path: string };
    readonly skipped: readonly string[];
  }[] = [
    {
      name: "an altered golden",
      edit: (document) => {
        document.goldens[0]!.bytes = Buffer.from("not the golden").toString("base64");
      },
      failing: "golden-match",
      scenario: "neutral-conformance",
      refusal: { code: "GOLDEN_MISMATCH", path: "goldens/neutral-conformance.json" },
      skipped: [],
    },
    {
      name: "an altered resource byte",
      edit: (document) => {
        const bytes = Buffer.from(
          document.source.resources["archetypes/keeper.json"] ?? "",
          "base64",
        );
        document.source.resources["archetypes/keeper.json"] = Buffer.concat([
          bytes,
          Buffer.from(" "),
        ]).toString("base64");
      },
      failing: "artifact-integrity",
      scenario: null,
      refusal: { code: "HASH_MISMATCH", path: "manifest.archetypes[0].sha256" },
      skipped: ["seed-genesis", "scenario-assertions", "golden-match"],
    },
    {
      name: "an artifact reference field that differs from the rebuilt source",
      edit: (document) => {
        document.artifact.contentHash = "0".repeat(64);
      },
      failing: "artifact-integrity",
      scenario: null,
      refusal: { code: "ARTIFACT_MISMATCH", path: "artifact.contentHash" },
      skipped: [],
    },
  ];

  for (const [index, defect] of DEFECTS.entries()) {
    it(`exits 1 naming the failing check for ${defect.name}`, async () => {
      const planted = join(scratch.path, `planted-${index}.artifact`);
      await writeFile(
        planted,
        tamperArtifact(new Uint8Array(await readFile(fixtureArtifact)), defect.edit),
      );
      const { run, envelope, checks } = await packTest(planted);
      expect(run.exitCode).toBe(1);
      expect(envelope.status).toBe("failed");
      expect(checks.filter((check) => check.status === "failed")).toEqual([
        { name: defect.failing, scenario: defect.scenario, status: "failed" },
      ]);
      expect(
        checks.filter((check) => check.status === "skipped").map((check) => check.name),
      ).toEqual(defect.skipped);
      const result = envelope.result as { checks: { status: string; refusal: unknown }[] };
      expect(result.checks.find((check) => check.status === "failed")?.refusal).toMatchObject(
        defect.refusal,
      );
    });
  }
});

describe("unreadable inputs", () => {
  it("exits 3 naming --pack for a missing pack directory and for a manifest that is not SDK resource JSON", async () => {
    const missing = await runExecutable([
      "pack",
      "validate",
      "--pack",
      join(scratch.path, "no-such-pack"),
    ]);
    expect(missing.exitCode).toBe(3);
    expect(readEnvelope(missing.stdout)).toMatchObject({
      status: "unreadable",
      result: null,
      refusal: { code: "INPUT_UNREADABLE", path: "--pack" },
    });
    const directory = await mismatchedPack("bad-manifest");
    await writeFile(join(directory, "manifest.json"), "{ not json");
    const out = join(scratch.path, "bad-manifest.artifact");
    const { run, envelope } = await build(directory, out);
    expect(run.exitCode).toBe(3);
    expect(envelope.refusal).toMatchObject({ code: "NOT_PACK_SOURCE", path: "--pack" });
    await expect(access(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exits 3 naming --artifact for a file that is not canonical bytes or is another document kind", async () => {
    for (const [bytes, code] of [
      [new TextEncoder().encode("plain text"), "NOT_CANONICAL_BYTES"],
      [canonicalBytes({ kind: "clockgrove.simulation-state", version: 1 }), "NOT_PACK_ARTIFACT"],
    ] as const) {
      const path = join(scratch.path, `unreadable-${code}.artifact`);
      await writeFile(path, bytes);
      const run = await runExecutable(["pack", "test", "--artifact", path]);
      expect(run.exitCode).toBe(3);
      expect(readEnvelope(run.stdout)).toMatchObject({
        status: "unreadable",
        exitCode: 3,
        result: null,
        refusal: { code, path: "--artifact" },
      });
    }
  });
});

describe("envelope", () => {
  it("differs between identical invocations only in observations", async () => {
    const first = readEnvelope(
      (await runExecutable(["pack", "validate", "--pack", "worlds/fixture"])).stdout,
    );
    const absolute = ["pack", "validate", "--pack", join(REPO_ROOT, "worlds/fixture")];
    const second = readEnvelope((await runExecutable(absolute, scratch.path)).stdout);
    expect(Buffer.compare(stableBytes(first), stableBytes(second))).toBe(0);
    expect(Object.keys(first).sort()).toEqual([
      "command",
      "exitCode",
      "kind",
      "observations",
      "refusal",
      "result",
      "status",
      "version",
    ]);
    expect(Object.keys(first.observations).sort()).toEqual([
      "durationMs",
      "peakMemoryBytes",
      "peakMemoryNullReason",
      "runtime",
    ]);
  });
});
