import {
  continuationCommand,
  executeWorldCommand,
  InMemoryRuntimeMetrics,
  JournalRevisionConflictError,
} from "@clockgrove/application";
import { PostgreSqlWorldCommandJournal } from "@clockgrove/persistence";
import { expect, it } from "vitest";
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
  kernelModel,
  provisionTestWorld,
  pureStep,
  stateHash,
  testWorld,
  truthOf,
  withAdmissionInsertFailure,
  withClient,
} from "./world-fixture.js";

it("finishes an immutable accepted continuation after cap reduction without admitting its target again", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld();
    const provisioned = await provisionTestWorld(fixture, world, "principal-continuation-clock");
    const scope = { ...provisioned.partition.target, spaceId: provisioned.partition.route.spaceId };
    const truth = truthOf(fixture);
    await withClient(fixture.environment, async (client) => {
      const journal = new PostgreSqlWorldCommandJournal(client);
      const ports = { journal, behavior: provisioned.behavior };
      const metrics = new InMemoryRuntimeMetrics();
      const owner = new PostgreSqlCommandOwner(client, metrics);
      const origin = advanceCommand(world, "accepted-before-cap-reduction", 1_200_000n, null, {
        maxInputs: 1,
        maxEvents: 256,
      });
      const model = kernelModel(world);
      let expected = pureStep(world, model, origin);
      const accepted = await executeWorldCommand(commandRequest(provisioned, origin), ports);
      expect(accepted.value).toMatchObject({ status: "committed", complete: false });
      const before = await owner.reader.hydrate(provisioned.authorization, scope);
      if (before.continuation === undefined) throw new Error("expected accepted continuation");
      expect(before.document.state).toEqual(expected.state);
      expect(before.document.randomState).toEqual(model.random);
      expect(before.continuation.record.continuation).toEqual(expected.continuation);
      expect(before.continuation.record.originCommand).toEqual(origin);
      expect(before.continuation.record.continuation.targetTime).toBe(1_200_000n);
      const configure = {
        ...advanceCommand(world, "reduce-admission-cap", 0n, null),
        type: "SetClockPolicy",
        payload: {
          schemaVersion: 1,
          simulationMillisecondsPerWallMillisecond: 1,
          catchUpCapMs: 1n,
        },
      };
      await executeWorldCommand(
        { ...commandRequest(provisioned, configure), trustedWallTime: () => 1000n },
        ports,
      );
      const reduced = await owner.reader.hydrate(provisioned.authorization, scope);
      expect(reduced.continuation).toEqual(before.continuation);
      expect(reduced.document).toEqual(before.document);
      const resume = {
        ...configure,
        commandId: advanceCommand(world, "resume-admitted", 0n, null).commandId,
        type: "ResumeWorld",
        payload: { schemaVersion: 1 },
      };
      await executeWorldCommand(
        { ...commandRequest(provisioned, resume), trustedWallTime: () => 1000n },
        ports,
      );
      const activation = {
        activationId: "continuation-activation",
        policyVersion: 2n,
        admit: true,
      };
      let chunks = 0;
      for (; chunks < 64; chunks++) {
        const state = await owner.reader.hydrate(provisioned.authorization, scope);
        if (state.continuation === undefined) break;
        expect(state.continuation.record.originCommand).toEqual(origin);
        expect(state.continuation.record.continuation.targetTime).toBe(1_200_000n);
        const next = continuationCommand(state.continuation.commandId, state.continuation.record);
        expected = pureStep(world, model, next, origin, expected.continuation);
        const result = await owner.advanceClock(scope, 1001n, {
          ...activation,
          admit: chunks === 0,
        });
        expect(result.status).toBe("pending");
        expect(result.commands.map((command) => command.outcome)).toEqual(["committed"]);
        expect(result.commands.map((command) => command.commandId)).toEqual([next.commandId]);
        const afterChunk = await owner.reader.hydrate(provisioned.authorization, scope);
        expect(afterChunk.document.state).toEqual(expected.state);
        expect(afterChunk.document.randomState).toEqual(model.random);
        expect(afterChunk.continuation?.record.continuation).toEqual(expected.continuation);
        expect(afterChunk.continuation?.record.attribution).toEqual(
          expected.complete ? undefined : before.continuation.record.attribution,
        );
        if (chunks === 0) {
          expect(afterChunk.document.state.simulationTime).toBe(160100n);
          expect(
            await truth("SELECT clock_admitted_horizon FROM clockgrove.partition_states"),
          ).toBe("100121");
          await withAdmissionInsertFailure(truth, async () => {
            await expect(
              owner.advanceClock(scope, 1_000_000n, {
                ...activation,
                activationId: "interrupted-next-activation",
              }),
            ).rejects.toMatchObject({ code: "XX998" });
          });
          expect(await owner.reader.hydrate(provisioned.authorization, scope)).toEqual(afterChunk);
          expect(
            await truth("SELECT clock_admitted_horizon FROM clockgrove.partition_states"),
          ).toBe("100121");
          expect(
            await truth("SELECT count(*) || '|' || sum(admitted) FROM clockgrove.clock_admissions"),
          ).toBe("1|1");
          expect(
            await truth(
              "SELECT count(*) FROM clockgrove.clock_admissions WHERE activation_id='interrupted-next-activation'",
            ),
          ).toBe("0");
        }
      }
      const completed = await owner.reader.hydrate(provisioned.authorization, scope);
      expect(expected.complete).toBe(true);
      expect(completed.continuation).toBeUndefined();
      expect(await stateHash(completed.document.state)).toBe(await stateHash(expected.state));
      expect(completed.document.state.simulationTime).toBe(1_200_000n);
      expect(await truth("SELECT count(*) FROM clockgrove.clock_admissions")).toBe("1");
      expect(
        await truth(
          "SELECT string_agg(DISTINCT inputs->>'principalId', ',') FROM clockgrove.authority_decisions WHERE command_id LIKE 'trusted:continue:%'",
        ),
      ).toBe(`system:world:${world.birth.world.worldId}`);
      const pause = {
        ...resume,
        commandId: advanceCommand(world, "pause-completed", 0n, null).commandId,
        type: "PauseWorld",
      };
      await executeWorldCommand(
        { ...commandRequest(provisioned, pause), trustedWallTime: () => 1001n },
        ports,
      );
      await expect(owner.advanceClock(scope, 1001n, activation)).rejects.toEqual(
        new JournalRevisionConflictError("clock-policy", 2n, 3n),
      );
      // The activation's own policy check refused it before any journal transaction.
      const conflicts = metrics.points.filter(({ name }) => name === "autonomous_conflicts");
      expect(conflicts.map(({ label }) => label)).toEqual(["clock-policy"]);
      expect(await owner.advanceClock(scope, 2000n)).toEqual({ status: "idle", commands: [] });
      expect((await owner.reader.hydrate(provisioned.authorization, scope)).document).toEqual(
        completed.document,
      );
    });
  });
}, 60_000);
