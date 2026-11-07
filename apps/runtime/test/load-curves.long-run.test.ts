import { setTimeout as delay } from "node:timers/promises";
import {
  DUE_WORK_ADVANCE_BUDGET,
  encodeCanonicalNode,
  type RuntimeMetricPoint,
} from "@clockgrove/application";
import { sha256Hex } from "@clockgrove/kernel";
import { previewSeedProjection } from "@clockgrove/simulator";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- repository-local JavaScript helper has no declarations.
import { writeLoadCurves } from "../../../scripts/ci/qualify-wave3-load-curves.mjs";
// @ts-expect-error -- repository-local JavaScript helper has no declarations.
import { workerdPeakMemory } from "../../../scripts/lib/process-memory.mjs";
import { SPACE_MAILBOX_BOUNDS } from "../src/mailbox.js";
import { OWNER_ACTIVATION_BUDGET } from "../src/owner-activation.js";
import { OVERDUE_DEADLINE_LIMIT } from "../src/world-commands.js";
import {
  advanceCommand,
  type DatabaseFixture,
  type PackSource,
  packWorld,
  provisionTestWorld,
  type TestWorld,
  testWorld,
  truthOf,
} from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  type NativeWorldOwner,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

// pnpm run qualify:wave3:load-curves only (scripts/ci/qualify-wave3-load-curves.mjs), alone on the
// host: the Wave 3 §19 hot-space and catch-up-storm curves through the native workerd/PostgreSQL
// owner path. Every value is read from the §20 metrics the owners record and the `*_answered`
// records the Worker writes; the curves and budget trips are assembled by that script.

const FILE = "apps/runtime/test/load-curves.long-run.test.ts";
/** Concurrent clients on one SpaceDO, and at least this many commands at each level. */
const HOT_SPACE_CLIENTS = [1, 2, 4, 8, 16, 32, 48, 64, 96];
const HOT_SPACE_COMMANDS = 32;
/** Decision: mailbox state sampled every 10 ms in a burst, a fifth of a ~50 ms command, lightly. */
const SAMPLE_MS = 10;
/**
 * Loopback connections to PostgreSQL, four per client at the largest level: each request's readers
 * open their own, and the harness's default 16 refused authentication before the mailbox filled.
 */
const CONNECTIONS = 384;
const MINUTE = 60_000n;
/** Sleep before one client command on a running clock: the overdue due work it runs inline. */
const OVERDUE_SLEEPS = [2n, 4n, 6n, 8n, 16n].map((minutes) => minutes * MINUTE);
/** Sleep of one world, then worlds waking together after one hour. */
const STORM_SLEEPS = [2n, 4n, 15n, 60n, 240n, 960n].map((minutes) => minutes * MINUTE);
const STORM_WORLDS = [1, 2, 4, 8];
const STORM_SLEEP = 60n * MINUTE;
/**
 * Keepers of one world, asleep 2 minutes: their decisions fall due together, so each of its three
 * deadlines' advances dispatches one input per keeper, against `DUE_WORK_ADVANCE_BUDGET.maxInputs`.
 */
const STORM_KEEPERS = [16, 64, 96];

type Scope = NativeWorldOwner["scope"];
interface LoadWorld {
  readonly world: TestWorld;
  readonly scope: Scope;
}

/** The fixture pack with `manifest`: a world of its own, since identities derive from id and version. */
async function packCopy(base: TestWorld, manifest: object, resources = {}): Promise<LoadWorld> {
  const source: PackSource = {
    ...base.source,
    manifest,
    resources: { ...base.source.resources, ...resources },
  };
  const preview = await previewSeedProjection(source, { sha256: async (b) => sha256Hex(b) });
  if (!preview.ok) throw new Error(`seed preview refused: ${preview.error.code}`);
  const copy = await packWorld({
    ...source,
    manifest: { ...manifest, expectedSeedProjectionHash: preview.value.actual },
  });
  const world = { ...copy, behavior: copy.behavior ?? base.behavior };
  const { tenantId, worldId, timelineId } = world.birth.world;
  return {
    world,
    scope: { tenantId, worldId, timelineId, spaceId: world.birth.spaces[0]!.spaceId },
  };
}

/** The fixture pack at version 1.0.k. */
async function stormWorlds(): Promise<LoadWorld[]> {
  const base = await testWorld("fixture");
  const worlds = [await packCopy(base, base.source.manifest as object)];
  for (let k = 1; k < Math.max(...STORM_WORLDS); k++)
    worlds.push(await packCopy(base, { ...(base.source.manifest as object), version: `1.0.${k}` }));
  return worlds;
}

/** The fixture pack at version 2.0.n with n keepers: its own and n - 1 copies of it. */
async function keeperWorlds(): Promise<LoadWorld[]> {
  const base = await testWorld("fixture");
  const manifest = base.source.manifest as { readonly actors: readonly object[] };
  const keeper = new TextDecoder().decode(base.source.resources["actors/master.json"]);
  const worlds = [];
  for (const keepers of STORM_KEEPERS) {
    const resources: Record<string, Uint8Array> = {};
    const actors = [...manifest.actors];
    for (let k = 1; k < keepers; k++) {
      const path = `actors/keeper-${k}.json`;
      const id = `beacon.keeper-${k}`;
      const bytes = new TextEncoder().encode(keeper.replace('"beacon.master"', `"${id}"`));
      resources[path] = bytes;
      actors.push({ id, path, sha256: sha256Hex(bytes), version: 1 });
    }
    worlds.push(
      await packCopy(base, { ...manifest, version: `2.0.${keepers}`, actors }, resources),
    );
  }
  return worlds;
}

/** The load worlds besides the harness's own, each with the principal's clock and command grants. */
async function provisionStormWorlds(fixture: DatabaseFixture): Promise<void> {
  for (const { world, scope } of [...(await stormWorlds()).slice(1), ...(await keeperWorlds())]) {
    await provisionTestWorld(fixture, world, "principal-runtime");
    await truthOf(fixture)(
      `INSERT INTO clockgrove.world_memberships (tenant_id, world_id, timeline_id, space_id,
         principal_id, membership_id, persona_id, roles, grants, privacy_ceiling, committed_at)
       VALUES ('${scope.tenantId}', '${scope.worldId}', '${scope.timelineId}', '${scope.spaceId}',
         'principal-runtime', 'membership-${scope.worldId}', 'persona-runtime', ARRAY['world-member'],
         ARRAY['runtime:world-command','runtime:world-clock'],
         '{"version":1,"allowedCategories":["public_scene","operator_evidence"]}', now());
       UPDATE clockgrove.timeline_partitions SET routing_epoch=1`,
    );
  }
}

describe("Wave 3 load curves through the native owner (qualify:wave3:load-curves)", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns a native runtime, disposable PostgreSQL and eleven worlds",
    async () => {
      await runNativeWorldOwnerProcess(FILE, "fixture", {
        vitestConfig: "apps/runtime/vitest.load-curves.config.ts",
        timeoutMs: 600_000,
        inheritOutput: true,
        prepare: provisionStormWorlds,
        connections: CONNECTIONS,
      });
    },
    720_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "measures the hot-space, inline catch-up and catch-up-storm curves",
    async () => {
      const startedAt = new Date().toISOString();
      const worlds = await stormWorlds();
      await withNativeWorldOwner(async (owner) => {
        let workerdBytes = 0;
        const reset = async () => {
          workerdBytes = Math.max(workerdBytes, ...workerdPeakMemory());
          await owner.reset();
        };
        const command = ({ world, scope }: LoadWorld, id: string, type: string, payload: unknown) =>
          owner.request("/v1/runtime/commands", {
            schemaVersion: 1,
            ...scope,
            routingEpoch: "1",
            authorityEpoch: "1",
            command: encodeCanonicalNode({ ...advanceCommand(world, id, 0n, null), type, payload }),
          });
        const weather = (load: LoadWorld, id: string) =>
          command(load, id, "world.weather.set", { schemaVersion: 2, rainIntensity: 5000 });
        // Trusted wall time: fixed at `wallTime`, or the real clock without it.
        const configure = async (scope: Scope, wallTime: bigint | undefined, schedule: boolean) =>
          expect(
            await owner.request("/autonomous/configure", {
              scope,
              wallTime: wallTime?.toString() ?? "",
              commandLimit: OWNER_ACTIVATION_BUDGET.maxCommands,
              schedule,
              workflowCatchUp: true,
            }),
          ).toMatchObject({ status: 200 });
        const drain = async (scope: Scope) =>
          (await owner.request("/owner-metrics", { scope })).body as RuntimeMetricPoint[];
        /** Resumes the world's clock at speed 1 at wall time `anchor`, its alarm held. */
        const resumeAt = async (load: LoadWorld, anchor: bigint) => {
          await configure(load.scope, anchor, false);
          const policy = {
            schemaVersion: 1,
            simulationMillisecondsPerWallMillisecond: 1,
            catchUpCapMs: 31_536_000_000n,
          };
          for (const [type, payload] of [
            ["SetClockPolicy", policy],
            ["ResumeWorld", { schemaVersion: 1 }],
          ] as const)
            expect((await command(load, `load-${type}`, type, payload)).status).toBe(200);
        };
        const primary = worlds[0] as LoadWorld;

        // Hot space: rising concurrent clients on one SpaceDO with a paused clock.
        const hotSpace = [];
        await reset();
        for (const clients of HOT_SPACE_CLIENTS) {
          const logged = owner.logs().length;
          await drain(primary.scope);
          const statuses: Record<string, number> = {};
          let [mailboxDepthMax, oldestAgeMaxMs] = [0, 0];
          const started = performance.now();
          for (let round = 0; round < Math.ceil(HOT_SPACE_COMMANDS / clients); round++) {
            let settled = false;
            const burst = Promise.all(
              Array.from({ length: clients }, (_, client) =>
                weather(primary, `load-hot-${clients}-${round}-${client}`),
              ),
            ).finally(() => {
              settled = true;
            });
            while (!settled) {
              const state = (await owner.request("/mailbox", { scope: primary.scope })).body as {
                readonly depth: number;
                readonly oldestEntryAgeMs: number;
              };
              mailboxDepthMax = Math.max(mailboxDepthMax, state.depth);
              oldestAgeMaxMs = Math.max(oldestAgeMaxMs, state.oldestEntryAgeMs);
              await delay(SAMPLE_MS);
            }
            for (const { status, body } of await burst) {
              const key = `${status} ${(body as { error?: string }).error ?? "committed"}`;
              statuses[key] = (statuses[key] ?? 0) + 1;
            }
          }
          const burstMs = Math.round(performance.now() - started);
          // Refusals are evidenced by the Worker's `world_command_answered` records: their
          // code, and failure class.
          const answered: Record<string, number> = {};
          const failureClasses: Record<string, number> = {};
          for (const record of owner.logs().slice(logged))
            if (record.includes("world_command_answered")) {
              const code = /code: '([a-z_]+)'/u.exec(record)?.[1] ?? "committed";
              answered[code] = (answered[code] ?? 0) + 1;
              const failure = /failureClass: '([a-z_]+)'/u.exec(record)?.[1];
              if (failure) failureClasses[failure] = (failureClasses[failure] ?? 0) + 1;
            }
          const commands = Object.values(statuses).reduce((sum, count) => sum + count, 0);
          // One answered record per request, with the code its response carried.
          expect(answered).toEqual(
            Object.fromEntries(
              Object.entries(statuses).map(([key, count]) => [key.split(" ")[1], count]),
            ),
          );
          hotSpace.push({
            clients,
            commands,
            committed: statuses["200 committed"] ?? 0,
            burstMs,
            mailboxDepthMax,
            oldestAgeMaxMs,
            answered,
            failureClasses,
            points: await drain(primary.scope),
          });
        }

        // A client command after a sleep runs the overdue due work inline, up to the limit.
        const overdueInline = [];
        for (const sleepMs of OVERDUE_SLEEPS) {
          await reset();
          await resumeAt(primary, BigInt(Date.now()) - sleepMs);
          await configure(primary.scope, undefined, false);
          await drain(primary.scope);
          const { status, body } = await weather(primary, `load-overdue-${sleepMs}`);
          const steps = Number(
            await owner.sql(
              "SELECT count(*) FROM clockgrove.command_receipts WHERE command_id LIKE 'trusted:advance:%'",
            ),
          );
          const code = (body as { error?: string }).error ?? null;
          // A refused command ran exactly the limit's steps first; an admitted one at most that many.
          if (status === 200) expect(steps).toBeLessThanOrEqual(OVERDUE_DEADLINE_LIMIT);
          else expect([code, steps]).toEqual(["world_catching_up", OVERDUE_DEADLINE_LIMIT]);
          const points = await drain(primary.scope);
          overdueInline.push({ sleepMs: Number(sleepMs), status, code, steps, points });
        }

        // Catch-up storms: worlds asleep for `sleepMs` whose alarms come due together.
        const storm = async (sweep: string, loads: LoadWorld[], sleepMs: bigint) => {
          await reset();
          const anchor = BigInt(Date.now()) - sleepMs;
          for (const load of loads) await resumeAt(load, anchor);
          // The points cover only the wake and its catch-up, not resumeAt's two clock commands.
          for (const { scope } of loads) await drain(scope);
          const wake = Date.now();
          const earned = primary.world.birth.state.simulationTime + BigInt(wake) - anchor;
          await Promise.all(loads.map((load) => configure(load.scope, undefined, true)));
          const tenants = loads.map(({ scope }) => `'${scope.tenantId}'`).join(",");
          const caughtUp = new Map<string, number>();
          while (caughtUp.size < loads.length) {
            if (Date.now() - wake > 300_000) throw new Error(`storm ${sweep} did not catch up`);
            const done = await owner.sql(
              `SELECT string_agg(s.tenant_id, ',') FROM clockgrove.partition_states s
                WHERE s.tenant_id IN (${tenants}) AND s.catch_up_run_id IS NULL
                  AND s.continuation_command_id IS NULL AND NOT EXISTS (
                    SELECT 1 FROM clockgrove.partition_schedules q WHERE q.tenant_id = s.tenant_id
                      AND q.partition_id = s.partition_id AND q.status = 'pending'
                      AND q.due_at <= ${earned})`,
            );
            const at = Date.now() - wake;
            for (const tenant of done.split(",").filter(Boolean))
              if (!caughtUp.has(tenant)) caughtUp.set(tenant, at);
            await delay(20);
          }
          const points = [];
          for (const { scope } of loads) points.push(...(await drain(scope)));
          return {
            sweep,
            sleepMs: Number(sleepMs),
            worlds: loads.length,
            caughtUpMs: [...caughtUp.values()],
            points,
          };
        };
        const catchUpStorm = [];
        for (const sleepMs of STORM_SLEEPS)
          catchUpStorm.push(await storm("sleep", [primary], sleepMs));
        for (const count of STORM_WORLDS)
          catchUpStorm.push(await storm("worlds", worlds.slice(0, count), STORM_SLEEP));
        for (const [index, load] of (await keeperWorlds()).entries())
          catchUpStorm.push({
            ...(await storm("keepers", [load], STORM_SLEEPS[0]!)),
            keepers: STORM_KEEPERS[index],
          });
        workerdBytes = Math.max(workerdBytes, ...workerdPeakMemory());

        const file = await writeLoadCurves({
          startedAt,
          completedAt: new Date().toISOString(),
          harness: { bridgeConnections: CONNECTIONS, postgresMaxConnections: CONNECTIONS + 16 },
          budgets: {
            activation: OWNER_ACTIVATION_BUDGET,
            dueWorkAdvance: DUE_WORK_ADVANCE_BUDGET,
            overdueDeadlineLimit: OVERDUE_DEADLINE_LIMIT,
            spaceMailbox: SPACE_MAILBOX_BOUNDS,
          },
          hotSpace,
          overdueInline,
          catchUpStorm,
          peakMemory: {
            workerdBytes: workerdBytes || null,
            workerdSource:
              "workerd resident-set high-water mark (/proc VmHWM), highest runtime; includes the hot-space mailbox sampling (one request per 10 ms during a burst)",
            nodeBytes: process.resourceUsage().maxRSS * 1024,
            nodeSource: "fixture process resident-set high-water mark (getrusage maxrss)",
          },
        });
        process.stdout.write(`load curves written to ${file}\n`);
      });
    },
    600_000,
  );
});
