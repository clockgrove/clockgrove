import {
  canonicalBytes,
  DUE_WORK_ADVANCE_BUDGET,
  dueWorkAdvanceCommand,
  executeWorldCommand,
  JournalRevisionConflictError,
  worldStateHash,
} from "@clockgrove/application";
import {
  PostgreSqlDueWorkReader,
  PostgreSqlWorldCommandJournal,
  PostgreSqlWorldOwnerReader,
  readPendingSchedules,
  withClientTransaction,
} from "@clockgrove/persistence";
import { expect, it, vi } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { PostgreSqlCommandOwner } from "../src/world-commands.js";
import {
  advanceCommand,
  commandRequest,
  type DatabaseFixture,
  provisionTestWorld,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

it("uses durable schedule boundaries independently of caps, admission grouping and delivery lateness", async () => {
  const outcomes: {
    hash: string;
    revision: bigint;
    simulationTime: bigint;
    targets: bigint[];
    commands: string[];
  }[] = [];
  for (const limit of [1, 2, 3, 4]) {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      await applyMigrations(fixture.tools, fixture.environment);
      const world = await testWorld();
      const provisioned = await provisionTestWorld(fixture, world, "principal-clock-boundary");
      const scope = {
        ...provisioned.partition.target,
        spaceId: provisioned.partition.route.spaceId,
      };
      const sql = truthOf(fixture);
      await withClient(fixture.environment, async (client) => {
        const owner = new PostgreSqlCommandOwner(client);
        const ports = {
          journal: new PostgreSqlWorldCommandJournal(client),
          behavior: provisioned.behavior,
        };
        const initial = limit === 1 ? 1n : 1_000_000n;
        const configure = {
          ...advanceCommand(world, "boundary-initial-cap", 0n, null),
          type: "SetClockPolicy",
          payload: {
            schemaVersion: 1,
            simulationMillisecondsPerWallMillisecond: 1,
            catchUpCapMs: initial,
          },
        };
        await executeWorldCommand(
          { ...commandRequest(provisioned, configure), trustedWallTime: () => 0n },
          ports,
        );
        const resume = {
          ...advanceCommand(world, "boundary-resume", 0n, null),
          type: "ResumeWorld",
          payload: { schemaVersion: 1 },
        };
        await executeWorldCommand(
          { ...commandRequest(provisioned, resume), trustedWallTime: () => 0n },
          ports,
        );
        const targets: bigint[] = [];
        const commands: string[] = [];
        const seeded = await owner.reader.hydrate(provisioned.authorization, scope);
        const first = dueWorkAdvanceCommand(
          provisioned.partition,
          seeded.revision,
          100000n,
          DUE_WORK_ADVANCE_BUDGET,
        );
        if (limit === 1) {
          for (const kind of ["clock-policy", "owner-generation", "routing-epoch"] as const) {
            const conflict = new JournalRevisionConflictError(kind, 2n, 3n);
            const journal = vi
              .spyOn(PostgreSqlWorldCommandJournal.prototype, "executeWorldCommand")
              .mockRejectedValueOnce(conflict);
            try {
              await expect(
                owner.advanceClock(scope, 0n, {
                  activationId: `superseded-${kind}`,
                  policyVersion: 2n,
                  admit: true,
                }),
              ).rejects.toEqual(conflict);
              expect(journal.mock.calls.map(([request]) => request.command.commandId)).toEqual([
                first.commandId,
              ]);
            } finally {
              journal.mockRestore();
            }
            expect((await owner.reader.hydrate(provisioned.authorization, scope)).document).toEqual(
              seeded.document,
            );
          }
          const conflict = new JournalRevisionConflictError("partition", 0n, 1n);
          const journal = vi
            .spyOn(PostgreSqlWorldCommandJournal.prototype, "executeWorldCommand")
            .mockRejectedValueOnce(conflict);
          try {
            expect(
              await owner.advanceClock(scope, 0n, {
                activationId: "contended-partition",
                policyVersion: 2n,
                admit: true,
              }),
            ).toEqual({ status: "pending", commands: [] });
            expect(journal.mock.calls.map(([request]) => request.command.commandId)).toEqual([
              first.commandId,
            ]);
          } finally {
            journal.mockRestore();
          }
          expect((await owner.reader.hydrate(provisioned.authorization, scope)).document).toEqual(
            seeded.document,
          );
        }
        const bootstrap = await owner.advanceClock(scope, 0n, {
          activationId: "initial-due",
          policyVersion: 2n,
          admit: true,
        });
        expect(bootstrap.commands.map((command) => command.commandId)).toEqual([first.commandId]);
        expect(
          await sql(
            `SELECT encode(command_bytes, 'hex') FROM clockgrove.command_receipts WHERE command_id = '${first.commandId}'`,
          ),
        ).toBe(Buffer.from(canonicalBytes(first)).toString("hex"));
        expect(bootstrap.commands.map((command) => command.value)).toEqual([
          expect.objectContaining({
            status: "committed",
            simulationTime: "100000",
            complete: true,
          }),
        ]);
        targets.push(100000n);
        commands.push(first.commandId);
        const time = vi.spyOn(Date, "now").mockReturnValue(1000);
        try {
          expect(await owner.clockAlarmPlan(scope, 0n)).toEqual({
            policyVersion: 2n,
            nextAlarmAt: 61000,
          });
        } finally {
          time.mockRestore();
        }
        const before = await owner.reader.hydrate(provisioned.authorization, scope);
        for (let index = 0; index < 2; index++) {
          expect(
            await owner.advanceClock(scope, limit === 1 ? 120_000n : 2n, {
              activationId: `unused-${index}`,
              policyVersion: 2n,
              admit: true,
            }),
          ).toEqual({ status: "idle", commands: [] });
        }
        expect(
          await sql(
            "SELECT greatest(clock_admitted_horizon, simulation_time) FROM clockgrove.partition_states",
          ),
        ).toBe("100002");
        const mappingTime = vi.spyOn(Date, "now").mockReturnValue(1000);
        try {
          expect(await owner.clockAlarmPlan(scope, limit === 1 ? 120_000n : 2n)).toEqual({
            policyVersion: 2n,
            nextAlarmAt: limit === 1 ? 1000 : 60998,
          });
        } finally {
          mappingTime.mockRestore();
        }
        const unused = await owner.reader.hydrate(provisioned.authorization, scope);
        expect(unused.document).toEqual(before.document);
        expect(
          await sql(
            "SELECT string_agg(admitted::text, ',' ORDER BY activation_id) FROM clockgrove.clock_admissions WHERE activation_id LIKE 'unused-%'",
          ),
        ).toBe(limit === 1 ? "1,1" : "2,0");
        const expand = {
          ...configure,
          commandId: advanceCommand(world, "boundary-expand-cap", 0n, null).commandId,
          payload: { ...configure.payload, catchUpCapMs: 1_000_000n },
        };
        await executeWorldCommand(
          { ...commandRequest(provisioned, expand), trustedWallTime: () => 0n },
          ports,
        );
        const deliveries = limit === 1 ? [120_000n] : [30_000n, 60_000n, 120_000n];
        for (const wallTime of deliveries) {
          let drained = false;
          for (let batch = 0; batch < 128 && !drained; batch++) {
            const activation = {
              activationId: `delivery-${wallTime}-${batch}`,
              policyVersion: 3n,
              admit: true,
            };
            for (let attempt = 0; attempt < limit; attempt++) {
              const state = await owner.reader.hydrate(provisioned.authorization, scope);
              const pending = await new PostgreSqlDueWorkReader(client).pendingWork(
                provisioned.authorization,
                { ...scope, partitionId: state.partitionId },
              );
              if (pending === undefined)
                throw new Error("provisioned owner must have pending-work state");
              expect(pending.continuation).toBeUndefined();
              const result = await owner.advanceClock(scope, wallTime, {
                ...activation,
                admit: attempt === 0,
              });
              if (result.commands.length === 0) {
                expect(result).toEqual({ status: "idle", commands: [] });
                drained = true;
                break;
              }
              if (pending.nextDueAt === null)
                throw new Error("a physical command requires a durable deadline");
              const expected = dueWorkAdvanceCommand(
                provisioned.partition,
                state.revision,
                pending.nextDueAt,
                DUE_WORK_ADVANCE_BUDGET,
              );
              expect(result.commands.map((command) => command.commandId)).toEqual([
                expected.commandId,
              ]);
              expect(result.commands.map((command) => command.outcome)).toEqual(["committed"]);
              expect(result.commands.map((command) => command.value)).toEqual([
                expect.objectContaining({
                  status: "committed",
                  simulationTime: pending.nextDueAt.toString(),
                  complete: true,
                }),
              ]);
              targets.push(pending.nextDueAt);
              commands.push(expected.commandId);
            }
          }
          expect(drained).toBe(true);
        }
        const completed = await owner.reader.hydrate(provisioned.authorization, scope);
        expect(completed.continuation).toBeUndefined();
        const hash = await sql("SELECT state_hash FROM clockgrove.partition_states");
        expect(hash).toBe(worldStateHash(completed.document.state));
        const clockOwner = PostgreSqlWorldOwnerReader.prototype.clockOwner;
        const pendingRead = vi
          .spyOn(PostgreSqlWorldOwnerReader.prototype, "clockOwner")
          .mockImplementationOnce(async function (this: PostgreSqlWorldOwnerReader, ...args) {
            const read = await clockOwner.apply(this, args);
            return read && { ...read, nextDueAt: null };
          });
        try {
          expect(await owner.clockAlarmPlan(scope, 120_000n)).toEqual({
            policyVersion: 3n,
            nextAlarmAt: null,
          });
        } finally {
          pendingRead.mockRestore();
        }
        outcomes.push({
          hash,
          revision: completed.revision,
          simulationTime: completed.document.state.simulationTime,
          targets,
          commands,
        });
      });
    });
  }
  expect(outcomes.slice(1)).toEqual([outcomes[0], outcomes[0], outcomes[0]]);
  expect(outcomes[0]).toEqual({
    hash: "0a5de7be844bfeae6b0b59f1d7a781d3732db5dc0208688d7de14ac50930bc80",
    revision: 25n,
    simulationTime: 220000n,
    targets: [100000n, 160000n, 220000n],
    commands: [
      "trusted:advance:timelineid_21da1c246db4adf3:partitionid_e385ad233fad07f4:beacon.hall:0:100000",
      "trusted:advance:timelineid_21da1c246db4adf3:partitionid_e385ad233fad07f4:beacon.hall:4:160000",
      "trusted:advance:timelineid_21da1c246db4adf3:partitionid_e385ad233fad07f4:beacon.hall:14:220000",
    ],
  });
}, 120_000);

it("orders indexed deadlines and priorities numerically across decimal digit boundaries", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-clock-order");
    const scope = {
      ...provisioned.partition.target,
      partitionId: provisioned.partition.route.partitionId,
    };
    // These reader-only rows deliberately exercise indexed columns before document hydration.
    await truthOf(fixture)(`UPDATE clockgrove.partition_schedules SET
      due_at = CASE tie_break_key WHEN 'fixture.companion' THEN 10022400000 ELSE 9976186047 END,
      priority = CASE tie_break_key WHEN 'fixture.dependent' THEN 10 ELSE 2 END
      WHERE status = 'pending'`);
    await withClient(fixture.environment, async (client) => {
      const reader = new PostgreSqlDueWorkReader(client);
      expect(await reader.pendingWork(provisioned.authorization, scope)).toEqual({
        revision: 0n,
        simulationTime: 8640000000n,
        nextDueAt: 9976186047n,
      });
      expect(await reader.dueSchedules(provisioned.authorization, scope, 10022400000n)).toEqual([
        {
          scheduleId: "scheduleid_29ec1f6fba1bbd68",
          idempotencyKey: "scheduleid_29ec1f6fba1bbd68:8640000000",
          dueAt: 9976186047n,
        },
        {
          scheduleId: "scheduleid_b6b122fb75b2abff",
          idempotencyKey: "scheduleid_b6b122fb75b2abff:8640000000",
          dueAt: 9976186047n,
        },
        {
          scheduleId: "scheduleid_4945ef855203a0fe",
          idempotencyKey: "scheduleid_4945ef855203a0fe:8640000000",
          dueAt: 10022400000n,
        },
      ]);
      const pending = await withClientTransaction(
        client,
        { authorization: provisioned.authorization },
        () =>
          readPendingSchedules(client, {
            tenantId: scope.tenantId,
            timelineId: scope.timelineId,
            partitionId: scope.partitionId,
          }),
      );
      expect(
        pending.map((item) => ({
          id: item.scheduleId,
          dueAt: item.dueAt,
          priority: item.priority,
        })),
      ).toEqual([
        { id: "scheduleid_29ec1f6fba1bbd68", dueAt: 9976186047n, priority: 2 },
        { id: "scheduleid_b6b122fb75b2abff", dueAt: 9976186047n, priority: 10 },
        { id: "scheduleid_4945ef855203a0fe", dueAt: 10022400000n, priority: 2 },
      ]);
    });
  });
}, 60_000);
