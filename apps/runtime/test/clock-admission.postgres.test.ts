import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClockCommand,
  executeWorldCommand,
  JournalRevisionConflictError,
  JournalRouteNotFoundError,
} from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import {
  PostgreSqlClockAdmissionReader,
  PostgreSqlWorldCommandJournal,
} from "@clockgrove/persistence";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import {
  advanceCommand,
  commandCounts,
  commandRequest,
  type DatabaseFixture,
  provisionTestWorld,
  testWorld,
  truthOf,
  withAdmissionInsertFailure,
  withClient,
} from "./world-fixture.js";

describe("durable clock admission", () => {
  for (const upgraded of [false, true]) {
    it(`isolates, fences and recovers admission on ${upgraded ? "upgraded" : "fresh"} PostgreSQL`, async () => {
      await withDisposableDatabase(async (fixture: DatabaseFixture) => {
        if (upgraded) {
          const directory = await mkdtemp(join(tmpdir(), "clock-admission-migrations-"));
          try {
            const migrations = new URL("../../../db/migrations/", import.meta.url);
            for (const name of await readdir(migrations)) {
              // Birth reads the 0025 Workflow link; no other column of 0016+ is needed.
              if (name.endsWith(".sql") && (name < "0016" || name.startsWith("0025_"))) {
                await copyFile(new URL(name, migrations), join(directory, name));
              }
            }
            await applyMigrations(fixture.tools, fixture.environment, {
              migrationDirectory: directory,
            });
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        } else {
          await applyMigrations(fixture.tools, fixture.environment);
        }
        const world = await testWorld();
        const provisioned = await provisionTestWorld(fixture, world, "principal-admission");
        const sql = truthOf(fixture);
        const original = await sql(
          "SELECT revision || '|' || state_hash FROM clockgrove.partition_states",
        );
        if (upgraded) await applyMigrations(fixture.tools, fixture.environment);
        expect(
          await sql("SELECT revision || '|' || state_hash FROM clockgrove.partition_states"),
        ).toBe(original);
        expect(await sql("SELECT clock_admitted_horizon FROM clockgrove.partition_states")).toBe(
          "0",
        );
        const { authorization, partition } = provisioned;
        const scope = {
          tenantId: authorization.tenantId,
          worldId: partition.target.worldId,
          timelineId: partition.target.timelineId,
          spaceId: partition.route.spaceId,
        };
        const control = async (id: string, clockCommand: ClockCommand, now = 0n) => {
          const command = {
            ...advanceCommand(world, id, 0n, null),
            type: clockCommand.type,
            payload: clockCommand,
          };
          const result = await withClient(fixture.environment, (client) =>
            executeWorldCommand(
              { ...commandRequest(provisioned, command), clockCommand, trustedWallTime: () => now },
              {
                journal: new PostgreSqlWorldCommandJournal(client),
                behavior: provisioned.behavior,
              },
            ),
          );
          expect(result.outcome).toBe("committed");
          if (result.value.status !== "committed" || result.value.clockPolicy === undefined)
            throw new Error("clock command must return the committed policy");
          return result.value.clockPolicy;
        };
        const read = async () =>
          BigInt(
            await sql(
              "SELECT greatest(clock_admitted_horizon, simulation_time) FROM clockgrove.partition_states",
            ),
          );
        const admit = (activationId: string, policyVersion = 2n, wallTime = 100n) =>
          withClient(fixture.environment, (client) =>
            new PostgreSqlClockAdmissionReader(client).admit(authorization, scope, {
              activationId,
              policyVersion,
              wallTime,
            }),
          );
        await control("admission-config", {
          type: "SetClockPolicy",
          schemaVersion: 1,
          simulationMillisecondsPerWallMillisecond: 1,
          catchUpCapMs: 10n,
        });
        await control("admission-resume", { type: "ResumeWorld", schemaVersion: 1 });
        const physical = await sql(
          "SELECT revision || '|' || simulation_time || '|' || state_hash || '|' || document::text FROM clockgrove.partition_states",
        );
        expect(await admit("first")).toEqual({
          activationId: "first",
          policyVersion: 2n,
          horizon: 100010n,
          admitted: 10n,
        });
        expect(await read()).toBe(100010n);
        expect(await admit("first", 2n, 1000n)).toEqual({
          activationId: "first",
          policyVersion: 2n,
          horizon: 100010n,
          admitted: 10n,
        });
        expect(await Promise.all([admit("concurrent"), admit("concurrent")])).toEqual([
          { activationId: "concurrent", policyVersion: 2n, horizon: 100020n, admitted: 10n },
          { activationId: "concurrent", policyVersion: 2n, horizon: 100020n, admitted: 10n },
        ]);
        // Reconstructing an adapter/client models loss of every runtime-local admission cache.
        expect(await read()).toBe(100020n);
        expect(await admit("first")).toEqual({
          activationId: "first",
          policyVersion: 2n,
          horizon: 100010n,
          admitted: 10n,
        });
        expect(await read()).toBe(100020n);
        expect(await sql("SELECT count(*) FROM clockgrove.clock_admissions")).toBe("2");
        expect(
          await sql(
            "SELECT revision || '|' || simulation_time || '|' || state_hash || '|' || document::text FROM clockgrove.partition_states",
          ),
        ).toBe(physical);
        const capReduced = await control("admission-reduce", {
          type: "SetClockPolicy",
          schemaVersion: 1,
          simulationMillisecondsPerWallMillisecond: 1,
          catchUpCapMs: 1n,
        });
        expect(capReduced.version).toBe(3n);
        expect(await read()).toBe(100020n);
        await expect(admit("obsolete", 2n)).rejects.toEqual(
          new JournalRevisionConflictError("clock-policy", 2n, 3n),
        );
        await expect(admit("first", 3n)).rejects.toEqual(
          new JournalRevisionConflictError("clock-policy", 2n, 3n),
        );
        expect(await admit("one-ms", 3n)).toEqual({
          activationId: "one-ms",
          policyVersion: 3n,
          horizon: 100021n,
          admitted: 1n,
        });
        expect(await admit("earned-bound", 3n, 21n)).toEqual({
          activationId: "earned-bound",
          policyVersion: 3n,
          horizon: 100021n,
          admitted: 0n,
        });
        const paused = await control(
          "admission-pause",
          { type: "PauseWorld", schemaVersion: 1 },
          100n,
        );
        expect(paused.version).toBe(4n);
        expect(await admit("paused", 4n, 10000n)).toEqual({
          activationId: "paused",
          policyVersion: 4n,
          horizon: 100021n,
          admitted: 0n,
        });
        await control("admission-resume-again", { type: "ResumeWorld", schemaVersion: 1 }, 10000n);
        expect(await admit("retained-backlog", 5n, 10000n)).toEqual({
          activationId: "retained-backlog",
          policyVersion: 5n,
          horizon: 100022n,
          admitted: 1n,
        });
        await expect(
          withClient(fixture.environment, (client) =>
            new PostgreSqlClockAdmissionReader(client).admit(
              authorization,
              { ...scope, tenantId: decodeOpaqueId("foreign-tenant", "TenantId") },
              { activationId: "foreign", policyVersion: 5n, wallTime: 10000n },
            ),
          ),
        ).rejects.toEqual(new JournalRouteNotFoundError(scope.spaceId));
        const foreignAuthorization = {
          ...authorization,
          tenantId: decodeOpaqueId("foreign-tenant", "TenantId"),
        };
        await withClient(fixture.environment, async (client) => {
          const admissions = new PostgreSqlClockAdmissionReader(client);
          await expect(admissions.ownerGeneration(foreignAuthorization, scope)).rejects.toEqual(
            new JournalRouteNotFoundError(scope.spaceId),
          );
          await expect(
            admissions.admit(foreignAuthorization, scope, {
              activationId: "foreign-existing-scope",
              policyVersion: 5n,
              wallTime: 10000n,
            }),
          ).rejects.toEqual(new JournalRouteNotFoundError(scope.spaceId));
          await expect(
            admissions.claimOwner(foreignAuthorization, scope, "foreign-owner", 0n),
          ).rejects.toEqual(new JournalRouteNotFoundError(scope.spaceId));
        });
        expect(await read()).toBe(100022n);
        expect(
          await sql(
            "SELECT count(*) FROM clockgrove.partition_states WHERE clock_owner_id IS NULL",
          ),
        ).toBe("1");
        expect(
          await sql(
            "SELECT count(*) FROM clockgrove.clock_admissions WHERE activation_id = 'foreign-existing-scope'",
          ),
        ).toBe("0");
        await withAdmissionInsertFailure(sql, async () => {
          await expect(admit("interrupted", 5n, 10000n)).rejects.toMatchObject({ code: "XX998" });
          expect(await read()).toBe(100022n);
          expect(
            await sql(
              "SELECT count(*) FROM clockgrove.clock_admissions WHERE activation_id = 'interrupted'",
            ),
          ).toBe("0");
        });
        expect(await admit("interrupted", 5n, 10000n)).toEqual({
          activationId: "interrupted",
          policyVersion: 5n,
          horizon: 100023n,
          admitted: 1n,
        });
        // Discard the committed response before its caller can observe it, then reconstruct the adapter.
        const responseLoss = new Error("test admission response lost");
        await expect(
          withClient(fixture.environment, async (client) => {
            await new PostgreSqlClockAdmissionReader(client).admit(authorization, scope, {
              activationId: "response-lost",
              policyVersion: 5n,
              wallTime: 10000n,
            });
            throw responseLoss;
          }),
        ).rejects.toBe(responseLoss);
        expect(await admit("response-lost", 5n, 20000n)).toEqual({
          activationId: "response-lost",
          policyVersion: 5n,
          horizon: 100024n,
          admitted: 1n,
        });
        expect(await read()).toBe(100024n);
        await withClient(fixture.environment, async (client) => {
          const admissions = new PostgreSqlClockAdmissionReader(client);
          const lostClaim = new Error("test owner claim response lost");
          await expect(
            admissions.claimOwner(authorization, scope, "owner-a", 0n).then(() => {
              throw lostClaim;
            }),
          ).rejects.toBe(lostClaim);
          // Every attempt of an incarnation carries the generation it observed before the first.
          expect(await admissions.claimOwner(authorization, scope, "owner-a", 0n)).toBe(1n);
          expect(await admissions.claimOwner(authorization, scope, "owner-a", 0n)).toBe(1n);
          expect(await read()).toBe(100024n);
          expect(await admissions.ownerGeneration(authorization, scope)).toBe(1n);
          expect(await admissions.claimOwner(authorization, scope, "owner-b", 1n)).toBe(2n);
          expect(await admissions.claimOwner(authorization, scope, "owner-b", 1n)).toBe(2n);
          // The replacement supersedes owner-a: its retry is refused, never reclaimed.
          await expect(admissions.claimOwner(authorization, scope, "owner-a", 0n)).rejects.toEqual(
            new JournalRevisionConflictError("owner-generation", 0n, 2n),
          );
          // An incarnation that observed a generation another claimed first is superseded too.
          await expect(
            admissions.claimOwner(authorization, scope, "owner-late", 1n),
          ).rejects.toEqual(new JournalRevisionConflictError("owner-generation", 1n, 2n));
          expect(await read()).toBe(100024n);
          expect(
            await sql(
              "SELECT clock_owner_generation || '|' || clock_owner_id FROM clockgrove.partition_states",
            ),
          ).toBe("2|owner-b");
          await expect(
            admissions.admit(authorization, scope, {
              activationId: "response-lost",
              policyVersion: 5n,
              wallTime: 20000n,
              ownerGeneration: 1n,
            }),
          ).rejects.toEqual(new JournalRevisionConflictError("owner-generation", 1n, 2n));
          await expect(
            admissions.admit(authorization, scope, {
              activationId: "obsolete-owner",
              policyVersion: 5n,
              wallTime: 20000n,
              ownerGeneration: 1n,
            }),
          ).rejects.toEqual(new JournalRevisionConflictError("owner-generation", 1n, 2n));
          const obsolete = advanceCommand(world, "obsolete-owner-physical", 160000n, null);
          await expect(
            executeWorldCommand(commandRequest(provisioned, obsolete), {
              journal: new PostgreSqlWorldCommandJournal(
                client,
                undefined,
                {},
                undefined,
                undefined,
                5n,
                1n,
              ),
              behavior: provisioned.behavior,
            }),
          ).rejects.toEqual(new JournalRevisionConflictError("owner-generation", 1n, 2n));
          expect(await commandCounts(sql, "obsolete-owner-physical")).toBe("0|0|0");
          expect(
            await admissions.admit(authorization, scope, {
              activationId: "current-owner",
              policyVersion: 5n,
              wallTime: 10000n,
              ownerGeneration: 2n,
            }),
          ).toEqual({
            activationId: "current-owner",
            policyVersion: 5n,
            horizon: 100025n,
            admitted: 1n,
          });
          expect(await read()).toBe(100025n);
          // issue 726: repeated wakes and activations keep claims and admissions bounded per partition.
          for (let wake = 3; wake <= 12; wake += 1) {
            const observed = await admissions.ownerGeneration(authorization, scope);
            const generation = await admissions.claimOwner(
              authorization,
              scope,
              `owner-${wake}`,
              observed,
            );
            for (const step of ["a", "b"])
              await admissions.admit(authorization, scope, {
                activationId: `wake-${wake}-${step}`,
                policyVersion: 5n,
                wallTime: 20000n,
                ownerGeneration: generation,
              });
          }
          expect(
            await sql(
              "SELECT clock_owner_generation || '|' || clock_owner_id || '|' || (SELECT string_agg(activation_id, ',' ORDER BY activation_id) FROM clockgrove.clock_admissions) FROM clockgrove.partition_states",
            ),
          ).toBe("12|owner-12|wake-12-b");
          // Retries recover or stay fenced at any delay, with no claim history kept.
          expect(await admissions.claimOwner(authorization, scope, "owner-12", 11n)).toBe(12n);
          await expect(admissions.claimOwner(authorization, scope, "owner-a", 0n)).rejects.toEqual(
            new JournalRevisionConflictError("owner-generation", 0n, 12n),
          );
        });
        expect(
          await sql(
            "SELECT count(*) FROM clockgrove.clock_admissions WHERE activation_id = 'obsolete-owner'",
          ),
        ).toBe("0");
        expect(
          await sql("SELECT revision || '|' || state_hash FROM clockgrove.partition_states"),
        ).toBe(original);
        expect(
          await sql(
            "SELECT count(*) FROM clockgrove.clock_admissions WHERE activation_id = 'obsolete'",
          ),
        ).toBe("0");
      });
    }, 120_000);
  }
});
