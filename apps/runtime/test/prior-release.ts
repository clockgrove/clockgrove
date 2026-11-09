import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  run,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
// @ts-expect-error -- repository-local JavaScript helper has no declaration file.
import { EVENT_BYTES_DIGEST } from "../../../scripts/database/prior-fixtures.mjs";
import { admin, failedChecks, ParityCluster } from "./journal-parity.js";
import type { DatabaseFixture } from "./world-fixture.js";

// A prior-release database fixture: one committed scenario run through the Journal of a
// tagged release, as that release's own code writes it. `scripts/database/capture-prior-release.mjs`
// runs `capturePriorRelease` inside a checkout of the tag; the fixture harness migrates the dump to
// head and checks it against the hashes recorded here. This module must run against the tag's code.

/** The captured scenario: small, with snapshots, every check passing against its golden. */
export const PRIOR_RELEASE_SCENARIO = { pack: "fixture", scenario: "non-raccoon-conformance" };

export interface PriorReleaseManifest {
  readonly release: string;
  readonly commit: string;
  readonly migrationHead: string;
  readonly pack: string;
  readonly scenario: string;
  readonly principalId: string;
  readonly scope: Readonly<Record<"tenantId" | "worldId" | "timelineId" | "partitionId", string>>;
  readonly events: number;
  readonly snapshots: number;
  readonly eventBytesDigest: string;
  readonly finalStateHash: string;
}

/**
 * Runs the scenario through the Journal of this checkout, requires every parity check against its
 * golden to pass, then writes the run's database (`database.sql`) and its manifest to `directory`.
 */
export async function capturePriorRelease(
  directory: string,
  release: string,
  commit: string,
): Promise<PriorReleaseManifest> {
  const { pack, scenario } = PRIOR_RELEASE_SCENARIO;
  return withDisposableDatabase(
    async (fixture: DatabaseFixture & { tools: { pg_dump: string } }) => {
      const cluster = await ParityCluster.create(fixture);
      const { runs, databases } = await cluster.scenario(pack, scenario);
      const failed = failedChecks(runs);
      if (failed.length > 0)
        throw new Error(`the ${release} run failed parity: ${failed.join(",")}`);
      const [main] = runs;
      const database = databases.get("main");
      if (main?.run !== "main" || database === undefined) throw new Error("no main run database");
      const world = await cluster.world(pack);
      const sql = (query: string) => admin(fixture, query, database);
      // The fixture is restored into other clusters: drop this cluster's transaction IDs first
      // (docs/runbooks/database.md, "Restoring into another cluster"). Older tags lack the function.
      await sql(`DO $$ BEGIN
        IF to_regprocedure('clockgrove.rebase_activation_order()') IS NOT NULL THEN
          PERFORM clockgrove.rebase_activation_order();
        END IF;
      END $$`);
      const manifest: PriorReleaseManifest = {
        release,
        commit,
        migrationHead: await sql("SELECT max(migration_name) FROM clockgrove.schema_migrations"),
        pack,
        scenario,
        principalId: world.authorization.principalId,
        scope: {
          ...world.partition.target,
          partitionId: world.partition.route.partitionId,
        },
        events: Number(await sql("SELECT count(*) FROM clockgrove.events")),
        snapshots: Number(await sql("SELECT count(*) FROM clockgrove.snapshots")),
        eventBytesDigest: await sql(EVENT_BYTES_DIGEST),
        finalStateHash: main.finalStateHash,
      };
      await mkdir(directory, { recursive: true });
      // A fixed restrict key keeps the dump free of a per-run random token.
      await run(
        fixture.tools.pg_dump,
        [
          "--format=plain",
          "--restrict-key=clockgrove",
          `--file=${join(directory, "database.sql")}`,
          `--dbname=${database}`,
        ],
        { environment: fixture.environment },
      );
      await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      return manifest;
    },
  );
}
