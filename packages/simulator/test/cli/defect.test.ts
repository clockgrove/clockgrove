import { describe, expect, it } from "vitest";
import type { CommandTable } from "../../cli/args.js";
import { runCli } from "../../cli/main.js";

async function invoke(commands: CommandTable, argv: readonly string[]) {
  const stdout: Uint8Array[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, commands, {
    stdout: (bytes) => stdout.push(bytes),
    stderr: (text) => stderr.push(text),
  });
  return { exitCode, stdout, stderr };
}

describe("internal defects", () => {
  const commands: CommandTable = new Map([
    [
      "test defect",
      {
        options: [],
        run: () => Promise.reject(new TypeError("library defect")),
      },
    ],
  ]);

  it("exits 70 with a stderr diagnostic and no stdout document", async () => {
    const run = await invoke(commands, ["test", "defect"]);
    expect(run.exitCode).toBe(70);
    expect(run.stdout).toEqual([]);
    expect(run.stderr).toHaveLength(1);
    expect(run.stderr[0]).toContain("TypeError: library defect");
  });
});
