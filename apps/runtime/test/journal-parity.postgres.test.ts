import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  decodeReplayBundle,
  encodeReplayBundle,
  type ReplayBundle,
  type ReplayBundleManifest,
  replayBundleSections,
} from "@clockgrove/application";
import { decodePrivacyCeiling } from "@clockgrove/contracts";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../packages/simulator/cli/repo.js";
import {
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { SCENARIO_EXCLUSIONS, SCENARIOS } from "./journal-long-runs.js";
import {
  admin,
  bundleCheck,
  failedChecks,
  ParityCluster,
  type RunParity,
} from "./journal-parity.js";
import type { DatabaseFixture } from "./world-fixture.js";

/** The per-PR subset; all committed scenarios and the long runs run in `pnpm test:long-run`. */
const PER_PR = [
  ["fixture", "neutral-conformance"],
  ["fixture/reference", "food-decay-and-conservation"],
  ["fixture/reference", "birth-and-parentage"],
  ["fixture/reference", "rain-shelter-comfort"],
] as const;

type Mutable = Pick<ReplayBundle, "birth"> & {
  events: string[];
  manifest: { -readonly [K in keyof ReplayBundleManifest]: ReplayBundleManifest[K] };
};

/** Bundle edits; `resealed` recomputes the section hashes, so only replay can catch the edit. */
const BUNDLE_TAMPERS: readonly (readonly [string, boolean, (bundle: Mutable) => void])[] = [
  [
    "altered event",
    false,
    (b) => (b.events[1] = b.events[1]!.replace(/(?<="recordedAt": "\d)\d/u, "9")),
  ],
  [
    "altered event, resealed",
    true,
    (b) => {
      const event = JSON.parse(b.events[1]!);
      b.events[1] = JSON.stringify({ ...event, payload: { ...event.payload, tampered: 1 } });
    },
  ],
  ["reordered events, resealed", true, (b) => b.events.splice(1, 2, b.events[2]!, b.events[1]!)],
  ["altered final hash", false, (b) => (b.manifest.expected = { finalStateHash: "0".repeat(64) })],
  [
    "altered manifest",
    false,
    (b) => {
      b.manifest.compatibility = {
        ...b.manifest.compatibility,
        kernelRegistryHash: "0".repeat(64),
      };
    },
  ],
];

/** One hex digit after the random state flipped, so the text stays well formed but its hash changes. */
function flipHex(text: string): string {
  const marker = text.indexOf("randomState");
  expect(marker).toBeGreaterThan(0);
  const at = text.slice(marker).search(/[0-9a-f](?=[0-9a-f])/u) + marker;
  return `${text.slice(0, at)}${text[at] === "0" ? "1" : "0"}${text.slice(at + 1)}`.trim();
}

describe("Wave 1 scenarios through the Journal match the pure simulator", () => {
  it("matches the golden for every run, and reports a corrupted projection byte, a dropped schedule row, a tampered birth, a corrupt or disagreeing snapshot, a truncated suffix or a tampered bundle", async () => {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      const cluster = await ParityCluster.create(fixture);
      const results: RunParity[] = [];
      let conformance: ReadonlyMap<string, string> | undefined;
      for (const [pack, scenario] of PER_PR) {
        const { runs, databases } = await cluster.scenario(pack, scenario);
        if (scenario === "neutral-conformance") conformance = databases;
        results.push(...runs);
      }
      expect(failedChecks(results)).toEqual([]);
      expect(results.map((run) => `${run.scenario}:${run.run}`)).toEqual([
        "neutral-conformance:main",
        "food-decay-and-conservation:main",
        "birth-and-parentage:main",
        "birth-and-parentage:uninterrupted",
        "rain-shelter-comfort:main",
        "rain-shelter-comfort:offline",
      ]);
      expect(results.every((run) => run.kernelCalls > 0 && run.events > 0)).toBe(true);

      // Negative controls, each on a scratch copy of a matching run's database.
      const world = await cluster.world("fixture");
      const reference = conformance?.get("main");
      if (reference === undefined) throw new Error("the conformance run kept no database");
      const parity = (database: string) =>
        cluster.scenarioChecks("fixture", "neutral-conformance", "main", database);

      // One byte of the stored projection document changes.
      const corrupted = await cluster.clone(reference);
      const document = await admin(
        fixture,
        `SELECT document::text FROM clockgrove.partition_states WHERE partition_id = '${world.partition.route.partitionId}'`,
        corrupted,
      );
      await cluster.tamper(
        corrupted,
        `UPDATE clockgrove.partition_states SET document = $parity$${flipHex(document)}$parity$::jsonb
          WHERE partition_id = '${world.partition.route.partitionId}';`,
      );
      expect(await parity(corrupted)).toContain("main:projection");

      // One pending schedule row is dropped (the guard trigger is bypassed in the scratch copy).
      const dropped = await cluster.clone(reference);
      await cluster.tamper(
        dropped,
        `SET session_replication_role = replica;
         DELETE FROM clockgrove.partition_schedules
          WHERE ctid = (SELECT ctid FROM clockgrove.partition_schedules WHERE status = 'pending'
                         ORDER BY due_at DESC LIMIT 1);`,
      );
      expect(await parity(dropped)).toContain("main:projection");

      // One stored birth section takes another's node: the birth no longer reproduces its seed hash.
      const born = await cluster.clone(reference);
      await cluster.tamper(
        born,
        `SET session_replication_role = replica;
         UPDATE clockgrove_birth.birth_state_sections
            SET node = (SELECT node FROM clockgrove_birth.birth_state_sections ORDER BY section DESC LIMIT 1)
          WHERE section = (SELECT min(section) FROM clockgrove_birth.birth_state_sections);`,
      );
      expect(
        await cluster.scenarioChecks("fixture", "neutral-conformance", "main", born, true),
      ).toEqual([
        "main:replay ReplayIntegrityError(birth)",
        "main:bundle ReplayIntegrityError(birth)",
      ]);

      // Bundle controls, verified offline: the conformance bundle, edited in memory.
      const bundle = await cluster.exportBundle("fixture", reference, world.authorization);
      const verdicts: Record<string, string | undefined> = {};
      for (const [name, resealed, edit] of BUNDLE_TAMPERS) {
        const edited = structuredClone(decodeReplayBundle(bundle)) as Mutable;
        edit(edited);
        if (resealed) edited.manifest.sections = replayBundleSections(edited.birth, edited.events);
        verdicts[name] = (await bundleCheck(encodeReplayBundle(edited), "")).detail;
      }
      verdicts["truncated bundle"] = (await bundleCheck(bundle.subarray(0, -1), "")).detail;
      // A ceiling without public_scene exports no events, so its bundle cannot verify.
      const lower = {
        ...world.authorization,
        privacyCeiling: decodePrivacyCeiling({ version: 1, allowedCategories: ["conversation"] }),
      };
      verdicts["ceiling without public_scene"] = (
        await bundleCheck(await cluster.exportBundle("fixture", reference, lower), "")
      ).detail;
      expect(verdicts).toEqual({
        "altered event": "ReplayBundleIntegrityError(section-hash)",
        "altered event, resealed": "JournalReadIntegrityError(payload-hash-mismatch)",
        "reordered events, resealed": "JournalReadIntegrityError(sequence-gap)",
        "altered final hash": "ReplayBundleIntegrityError(final-state)",
        "altered manifest": "ReplayBundleIncompatibleError(kernelRegistryHash)",
        "truncated bundle": "ReplayBundleIntegrityError(malformed)",
        "ceiling without public_scene": "JournalReadIntegrityError(sequence-gap)",
      });

      // Snapshot controls, each on a scratch copy with the guard triggers bypassed.
      const partition = world.partition.route.partitionId;
      const scratch = async (sql: string) => {
        const database = await cluster.clone(reference);
        await cluster.tamper(database, `SET session_replication_role = replica; ${sql}`);
        return cluster.scenarioChecks("fixture", "neutral-conformance", "main", database, true);
      };
      // The latest snapshot below the head has one document byte flipped, under a matching content hash.
      const latest = `(SELECT artifact_id FROM clockgrove.snapshots WHERE covered_partition_sequence <
        (SELECT covered_head_sequence FROM clockgrove.partition_states) ORDER BY covered_partition_sequence DESC LIMIT 1)`;
      const bytes = await admin(
        fixture,
        `SELECT convert_from(inline_content, 'UTF8') FROM clockgrove.artifact_references WHERE artifact_id = ${latest}`,
        reference,
      );
      const flippedBytes = `convert_to($s$${flipHex(bytes)}$s$, 'UTF8')`;
      expect(
        await scratch(`UPDATE clockgrove.artifact_references SET inline_content = ${flippedBytes},
          content_hash = 'sha256:' || encode(sha256(${flippedBytes}), 'hex') WHERE artifact_id = ${latest};`),
      ).toEqual(["main:snapshot-replay SnapshotIntegrityError(document-hash-mismatch)"]);
      // The earliest snapshot records the latest snapshot's state hash: its checkpoint disagrees with replay.
      expect(
        await scratch(`UPDATE clockgrove.snapshots SET state_hash = (SELECT state_hash FROM clockgrove.snapshots
            ORDER BY covered_partition_sequence DESC LIMIT 1)
          WHERE covered_partition_sequence = (SELECT min(covered_partition_sequence) FROM clockgrove.snapshots);`),
      ).toEqual([expect.stringMatching(/^main:checkpoints checkpoint:snapshot:\S+$/u)]);
      // The partition's last event is gone and its heads step back: the suffix ends before the live head.
      expect(
        await scratch(`WITH gone AS (DELETE FROM clockgrove.events WHERE partition_id = '${partition}' AND partition_sequence =
            (SELECT max(partition_sequence) FROM clockgrove.events WHERE partition_id = '${partition}') RETURNING stream_id),
          head AS (UPDATE clockgrove.timeline_partitions SET head_sequence = head_sequence - 1 WHERE partition_id = '${partition}')
          UPDATE clockgrove.streams SET current_sequence = current_sequence - 1 FROM gone WHERE streams.stream_id = gone.stream_id;`),
      ).toContain("main:replay ReplayIntegrityError(truncated)");

      // The untouched copy still matches.
      expect(await parity(await cluster.clone(reference))).toEqual([]);
    });
  }, 240_000);

  it("the long runs list every committed scenario, or exclude it in writing", async () => {
    const committed: string[] = [];
    const worlds = path.join(REPO_ROOT, "worlds");
    for (const entry of await readdir(worlds, { recursive: true, withFileTypes: true })) {
      if (
        entry.isFile() &&
        path.basename(entry.parentPath) === "scenarios" &&
        entry.name.endsWith(".json")
      )
        committed.push(
          `${path.relative(worlds, path.dirname(entry.parentPath))}/${entry.name.slice(0, -".json".length)}`,
        );
    }
    const listed = SCENARIOS.map(([pack, scenario]) => `${pack}/${scenario}`);
    expect([...listed, ...Object.keys(SCENARIO_EXCLUSIONS)].sort()).toEqual(committed.sort());
  });
});
