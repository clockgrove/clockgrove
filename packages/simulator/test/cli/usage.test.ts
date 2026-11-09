import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEnvelope, runExecutable, temporaryDirectory } from "./helpers.js";

let scratch: Awaited<ReturnType<typeof temporaryDirectory>>;
beforeAll(async () => {
  scratch = await temporaryDirectory();
});
afterAll(() => scratch.dispose());

// One invocation per published usage refusal code.
const CASES: readonly {
  readonly args: readonly string[];
  readonly command: string;
  readonly code: string;
  readonly path: string;
}[] = [
  { args: ["pack"], command: "pack", code: "MISSING_COMMAND", path: "command" },
  { args: ["pack", "bogus"], command: "pack bogus", code: "UNKNOWN_COMMAND", path: "command" },
  {
    args: ["pack", "build", "--pack", "worlds/fixture"],
    command: "pack build",
    code: "MISSING_OPTION",
    path: "--out",
  },
  {
    args: ["pack", "validate", "worlds/fixture"],
    command: "pack validate",
    code: "UNKNOWN_OPTION",
    path: "worlds/fixture",
  },
  {
    args: ["pack", "validate", "--pack", "worlds/fixture", "--pack", "worlds/fixture/reference"],
    command: "pack validate",
    code: "DUPLICATE_OPTION",
    path: "--pack",
  },
  {
    args: ["pack", "test", "--artifact", "--artifact"],
    command: "pack test",
    code: "MISSING_VALUE",
    path: "--artifact",
  },
  {
    args: ["pack", "test", "--artifact", ""],
    command: "pack test",
    code: "MALFORMED_VALUE",
    path: "--artifact",
  },
];

describe("usage errors", () => {
  for (const item of CASES) {
    it(`${item.code} exits 2 with status usage`, async () => {
      const run = await runExecutable(item.args);
      const envelope = readEnvelope(run.stdout);
      expect(run.exitCode).toBe(2);
      expect(envelope.exitCode).toBe(2);
      expect(envelope.status).toBe("usage");
      expect(envelope.command).toBe(item.command);
      expect(envelope.result).toBeNull();
      expect(envelope.refusal?.code).toBe(item.code);
      expect(envelope.refusal?.path).toBe(item.path);
    });
  }

  it("writes no file when the arguments are refused", async () => {
    const out = join(scratch.path, "refused.artifact");
    const run = await runExecutable([
      "pack",
      "build",
      "--pack",
      "worlds/fixture",
      "--out",
      out,
      "--extra",
      "1",
    ]);
    expect(run.exitCode).toBe(2);
    await expect(access(out)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
