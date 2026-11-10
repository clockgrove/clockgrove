import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewSeedProjection } from "../packages/simulator/src/index.js";
import { buildLampHallSource, sha256Hex } from "../packages/simulator/test/fixtures/lamp-hall.js";
import { encodeResource } from "../packages/world-pack-sdk/src/index.js";

/** A neutral conversation world generated in code, shared by the operator probe and its proof. */
export async function withModerationFixture<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "moderation-shadow-world-"));
  try {
    const source = await buildLampHallSource({
      edit: ({ docs, manifest }) => {
        manifest.components.push({ type: "clockgrove.conversation-mode", version: 1 });
        const archetype = docs["archetypes/keeper.json"] as { components: Record<string, unknown> };
        archetype.components["clockgrove.conversation-mode"] = {
          type: "clockgrove.conversation-mode",
          version: 1,
          state: { mode: "cognitive" },
        };
      },
    });
    const preview = await previewSeedProjection(source, { sha256: sha256Hex });
    if (!preview.ok) throw new Error(`Moderation fixture refused: ${preview.error.code}`);
    source.manifest.expectedSeedProjectionHash = preview.value.actual;
    await writeFile(path.join(directory, "manifest.json"), encodeResource(source.manifest));
    for (const [name, bytes] of Object.entries(source.resources)) {
      const target = path.join(directory, "resources", name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
