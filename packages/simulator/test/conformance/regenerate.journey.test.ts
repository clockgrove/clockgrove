import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./pack-source.js";

// Each regeneration runs the fixture pack's conformance (workerd included) once or twice.
const RUN_TIMEOUT = 240_000;

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path.slice(root.length + 1)] = (await readFile(path)).toString("base64");
  }
  return files;
}

it(
  "regenerates a wrong or missing golden in place and leaves worlds unchanged otherwise",
  async () => {
    const worlds = await mkdtemp(join(tmpdir(), "clockgrove-regenerate-"));
    try {
      for (const entry of ["manifest.json", "resources", "scenarios", "goldens"])
        await cp(join(REPO_ROOT, "worlds", "fixture", entry), join(worlds, "fixture", entry), {
          recursive: true,
        });
      const run = () =>
        promisify(execFile)(
          process.execPath,
          [join(REPO_ROOT, "scripts/regenerate-goldens.mjs"), `--worlds=${worlds}`],
          {
            cwd: REPO_ROOT,
            // The stage's environment never redirects the command: only --worlds does.
            env: {
              ...process.env,
              CLOCKGROVE_CONFORMANCE_WORLDS: join(worlds, "elsewhere"),
            },
            maxBuffer: 64 * 1024 * 1024,
            timeout: RUN_TIMEOUT,
          },
        );
      const committed = await snapshot(worlds);

      await run();
      expect(await snapshot(worlds)).toEqual(committed);

      const golden = join(worlds, "fixture", "goldens", "neutral-conformance.json");
      const bytes = await readFile(golden);
      bytes[100] = bytes[100]! ^ 1;
      await writeFile(golden, bytes);
      await run();
      expect(await snapshot(worlds)).toEqual(committed);

      await rm(golden);
      await run();
      expect(await snapshot(worlds)).toEqual(committed);

      await writeFile(golden, bytes);
      const scenario = join(worlds, "fixture", "scenarios", "neutral-conformance.json");
      await writeFile(
        scenario,
        (await readFile(scenario, "utf8")).replace('"value":"seek-water"', '"value":"seek-food"'),
      );
      const broken = await snapshot(worlds);
      await expect(run()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringMatching(
          /other than a golden mismatch:\n {2}- .*\(check scenario-assertions, golden-match\)\nNo file under /,
        ),
      });
      expect(await snapshot(worlds)).toEqual(broken);
    } finally {
      await rm(worlds, { recursive: true, force: true });
    }
  },
  RUN_TIMEOUT * 6,
);
