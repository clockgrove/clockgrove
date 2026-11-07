import {
  decodeCanonicalNode,
  encodeCanonicalNode,
  executeWorldCommand,
  JournalRevisionConflictError,
  type TimelineClockPolicy,
  type WorldCommandResult,
} from "@clockgrove/application";
import { type CommandEnvelope, decodeOpaqueId } from "@clockgrove/contracts";
import { PostgreSqlWorldCommandJournal } from "@clockgrove/persistence";
import { describe, expect, it } from "vitest";
import { advanceCommand, commandCounts, commandRequest } from "./world-fixture.js";
import { configureAutonomousOwner } from "./world-owner/autonomous-parity.js";
import {
  canonicalResponse,
  inspectNativeWorldOwner,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

describe("journal-backed native timeline clock", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns the native process and PostgreSQL",
    async () => {
      await runNativeWorldOwnerProcess("apps/runtime/test/timeline-clock.postgres.test.ts");
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "commits controls, fences work and reconstructs policy",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { scope, world, sql } = owner;
        // Keep this control-command suite isolated; autonomous delivery has its own native matrix.
        await configureAutonomousOwner(owner, undefined, 4, false);
        const control = (
          id: string,
          type: string,
          payload: unknown = { schemaVersion: 1 },
        ): CommandEnvelope<string, unknown> => ({
          ...advanceCommand(world, id, 0n, null),
          type,
          payload,
        });
        const inspect = async () => (await inspectNativeWorldOwner(owner)).partition;
        const committed = async (
          command: CommandEnvelope<string, unknown>,
        ): Promise<TimelineClockPolicy> => {
          const response = await owner.submit(command);
          expect(response.status).toBe(200);
          const result = decodeCanonicalNode(
            canonicalResponse(response.body),
          ) as WorldCommandResult;
          expect(result.commandId).toBe(command.commandId);
          expect(result.outcome).toBe("committed");
          expect(result.events.map((event) => event.type)).toEqual(["ClockPolicyChanged"]);
          if (result.value.status !== "committed" || result.value.clockPolicy === undefined)
            throw new Error("committed clock policy required");
          expect(result.value.eventCount).toBe(1);
          expect(result.events[0]?.payload).toEqual({
            reason: command.type,
            previousVersion: (result.value.clockPolicy.version - 1n).toString(),
            clockPolicy: encodeCanonicalNode(result.value.clockPolicy),
          });
          return result.value.clockPolicy;
        };
        const initial = await inspect();
        expect(initial.clockPolicy).toEqual({
          schemaVersion: 1,
          version: 0n,
          running: false,
          simulationAnchor: initial.document.state.simulationTime,
          wallAnchor: 0n,
          simulationMillisecondsPerWallMillisecond:
            world.birth.clock.simulationMillisecondsPerWallMillisecond,
          catchUpCapMs: 86_400_000n,
        });
        const physical =
          "SELECT jsonb_build_object('revision',revision,'document',document,'stateHash',state_hash,'continuation',continuation,'schedules',(SELECT jsonb_agg(to_jsonb(q) ORDER BY schedule_id,idempotency_key) FROM clockgrove.partition_schedules q))::text FROM clockgrove.partition_states";
        const before = await sql(physical);
        expect((await owner.request("/advance-clock", scope, "")).status).toBe(200);
        expect(await sql(physical)).toBe(before);
        const pauseCommand = control("clock-pause", "PauseWorld");
        const paused = await committed(pauseCommand);
        expect(paused.running).toBe(false);
        expect(paused.version).toBe(1n);
        expect(paused.simulationAnchor).toBe(initial.document.state.simulationTime);
        const durable = await owner.durable();
        const retry = await owner.submit(pauseCommand);
        expect(retry.status).toBe(200);
        const retryResult = decodeCanonicalNode(
          canonicalResponse(retry.body),
        ) as WorldCommandResult;
        expect(retryResult.value).toEqual({
          status: "committed",
          revision: initial.revision.toString(),
          simulationTime: initial.document.state.simulationTime.toString(),
          complete: true,
          eventCount: 1,
          stateHash: await sql("SELECT state_hash FROM clockgrove.partition_states"),
          clockPolicy: paused,
        });
        expect(await owner.durable()).toBe(durable);
        expect(await commandCounts(sql, pauseCommand.commandId)).toBe("1|1|1");
        expect(
          await sql(
            "SELECT outcome FROM clockgrove.authority_decisions WHERE command_id='clock-pause'",
          ),
        ).toBe("allow");
        expect(await sql(physical)).toBe(before);
        expect(await owner.submit({ ...pauseCommand, type: "ResumeWorld" })).toEqual({
          status: 409,
          body: { error: "command_id_reused" },
        });
        for (const [id, payload] of [
          [
            "zero-speed",
            { schemaVersion: 1, simulationMillisecondsPerWallMillisecond: 0, catchUpCapMs: 1n },
          ],
          [
            "large-speed",
            {
              schemaVersion: 1,
              simulationMillisecondsPerWallMillisecond: 1_000_001,
              catchUpCapMs: 1n,
            },
          ],
          [
            "zero-cap",
            { schemaVersion: 1, simulationMillisecondsPerWallMillisecond: 1, catchUpCapMs: 0n },
          ],
          [
            "large-cap",
            {
              schemaVersion: 1,
              simulationMillisecondsPerWallMillisecond: 1,
              catchUpCapMs: 9_223_372_036_854_775_808n,
            },
          ],
        ] as const) {
          expect(await owner.submit(control(id, "SetClockPolicy", payload))).toEqual({
            status: 400,
            body: { error: "invalid_world_command" },
          });
          expect(await commandCounts(sql, id)).toBe("0|0|0");
        }
        expect(
          await owner.submit(control("bad-pause", "PauseWorld", { schemaVersion: 1, extra: true })),
        ).toEqual({ status: 400, body: { error: "invalid_world_command" } });
        const configurationWallBefore = BigInt(Date.now());
        const configured = await committed(
          control("clock-config", "SetClockPolicy", {
            schemaVersion: 1,
            simulationMillisecondsPerWallMillisecond: 1_000_000,
            catchUpCapMs: 120_000n,
          }),
        );
        const { wallAnchor: configurationWall, ...configuredFields } = configured;
        expect(configuredFields).toEqual({
          schemaVersion: 1,
          version: 2n,
          running: false,
          simulationAnchor: initial.document.state.simulationTime,
          simulationMillisecondsPerWallMillisecond: 1_000_000,
          catchUpCapMs: 120_000n,
        });
        expect(
          configurationWall >= configurationWallBefore && configurationWall <= BigInt(Date.now()),
        ).toBe(true);
        const wallBefore = BigInt(Date.now());
        const running = await committed(control("clock-resume", "ResumeWorld"));
        const { wallAnchor: runningWall, ...runningFields } = running;
        expect(runningFields).toEqual({ ...configuredFields, version: 3n, running: true });
        expect(runningWall >= wallBefore && runningWall <= BigInt(Date.now())).toBe(true);
        expect(running.simulationAnchor).toBe(initial.document.state.simulationTime);
        expect(await sql(physical)).toBe(before);
        await owner.withSqlClient(async (client) => {
          const authorization = {
            tenantId: initial.document.state.tenantId,
            principalId: decodeOpaqueId("principal-runtime", "PrincipalId"),
            privacyCeiling: { version: 1 as const, allowedCategories: ["public_scene" as const] },
          };
          const partition = {
            authorization,
            target: {
              tenantId: initial.document.state.tenantId,
              worldId: initial.document.state.worldId,
              timelineId: initial.document.state.timelineId,
            },
            route: {
              partitionId: initial.partitionId,
              spaceId: initial.spaceId,
              streamId: initial.streamId,
            },
          };
          const behavior = { behaviorFor: async () => world.behavior };
          await expect(
            executeWorldCommand(
              commandRequest(
                { world, behavior, authorization, partition },
                advanceCommand(world, "superseded-advance", 120_000n, null),
              ),
              {
                journal: new PostgreSqlWorldCommandJournal(
                  client,
                  undefined,
                  {},
                  undefined,
                  undefined,
                  2n,
                ),
                behavior,
              },
            ),
          ).rejects.toEqual(new JournalRevisionConflictError("clock-policy", 2n, 3n));
          expect(await commandCounts(sql, "superseded-advance")).toBe("0|0|0");
        });
        await sql(
          "CREATE FUNCTION clockgrove.refuse_clock_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected policy persistence failure'; END $$; CREATE TRIGGER refuse_clock_test BEFORE UPDATE OF clock_policy ON clockgrove.partition_states FOR EACH ROW EXECUTE FUNCTION clockgrove.refuse_clock_test()",
        );
        try {
          const atomicBefore = await owner.durable();
          expect(await owner.submit(control("atomic-clock-fault", "PauseWorld"))).toEqual({
            status: 500,
            body: { error: "world_command_failed" },
          });
          expect(await commandCounts(sql, "atomic-clock-fault")).toBe("0|0|0");
          expect(await owner.durable()).toBe(atomicBefore);
        } finally {
          await sql(
            "DROP TRIGGER refuse_clock_test ON clockgrove.partition_states; DROP FUNCTION clockgrove.refuse_clock_test()",
          );
        }
        await owner.replace(true);
        await configureAutonomousOwner(owner, undefined, 4, false);
        expect((await inspect()).clockPolicy).toEqual(running);
        await sql("UPDATE clockgrove.partition_states SET clock_policy=NULL");
        expect((await inspect()).clockPolicy).toEqual(running);
        await sql("UPDATE clockgrove_auth.session SET \"expiresAt\"='1970-01-01'");
        try {
          expect(await owner.submit(control("expired-session-clock", "ResumeWorld"))).toEqual({
            status: 401,
            body: { error: "authentication_refused" },
          });
          const advanced = await owner.request("/advance-clock", scope, "");
          expect(advanced.status).toBe(200);
        } finally {
          await sql("UPDATE clockgrove_auth.session SET \"expiresAt\"='2099-01-01'");
        }
        const after = await inspect();
        expect(after.document.state.simulationTime).toBe(initial.document.state.simulationTime);
        expect(after.clockPolicy).toEqual(running);
        const stopped = await committed(control("clock-stop", "PauseWorld"));
        expect(stopped.running).toBe(false);
        expect(stopped.version).toBe(4n);
        const stoppedPhysical = await sql(physical);
        expect((await owner.request("/advance-clock", scope, "")).status).toBe(200);
        expect(await sql(physical)).toBe(stoppedPhysical);
        const incompleteCommand = advanceCommand(world, "clock-admitted-work", 1_200_000n, null, {
          maxInputs: 1,
          maxEvents: 256,
        });
        const incompleteResponse = await owner.submit(incompleteCommand);
        expect(incompleteResponse.status).toBe(200);
        const incompleteResult = decodeCanonicalNode(
          canonicalResponse(incompleteResponse.body),
        ) as WorldCommandResult;
        expect(incompleteResult.value).toMatchObject({ status: "committed", complete: false });
        const pending = await inspect();
        if (pending.continuation === undefined)
          throw new Error("admitted work must retain a continuation");
        const pendingPhysical = await sql(physical);
        const pausedPending = await committed(control("clock-pause-pending", "PauseWorld"));
        expect(pausedPending.running).toBe(false);
        expect(pausedPending.version).toBe(5n);
        expect(await sql(physical)).toBe(pendingPhysical);
        await owner.replace(true);
        await configureAutonomousOwner(owner, undefined, 4, false);
        const recoveredPending = await inspect();
        expect(recoveredPending.continuation).toEqual(pending.continuation);
        expect(recoveredPending.document).toEqual(pending.document);
        expect((await owner.request("/advance-clock", scope, "")).status).toBe(200);
        expect(await sql(physical)).toBe(pendingPhysical);
        const resumedPending = await committed(control("clock-resume-pending", "ResumeWorld"));
        expect(resumedPending.running).toBe(true);
        expect(resumedPending.version).toBe(6n);
        expect(resumedPending.simulationAnchor).toBe(pausedPending.simulationAnchor);
        for (let chunk = 0; chunk < 32 && (await inspect()).continuation !== undefined; chunk++) {
          expect((await owner.request("/advance-clock", scope, "")).status).toBe(200);
        }
        const completedPending = await inspect();
        expect(completedPending.continuation).toBeUndefined();
        expect(completedPending.document.state.simulationTime).toBe(1_200_000n);
        expect(
          await owner.submit(control("stale-clock", "ResumeWorld"), { routingEpoch: "0" }),
        ).toEqual({
          status: 409,
          body: { error: "world_command_conflict", kind: "routing-epoch" },
        });
        expect(
          await owner.submit(control("stale-authority", "ResumeWorld"), { authorityEpoch: "0" }),
        ).toEqual({
          status: 409,
          body: { error: "world_command_conflict", kind: "routing-epoch" },
        });
        expect(await owner.submit(control("unauth-clock", "ResumeWorld"), {}, "")).toEqual({
          status: 401,
          body: { error: "authentication_refused" },
        });
        expect(
          await owner.submit(control("outside-clock", "ResumeWorld"), {}, "outsider-session-token"),
        ).toEqual({ status: 403, body: { error: "authorization_refused" } });
        expect(
          await owner.submit(
            control("outside-space", "ResumeWorld"),
            { spaceId: "missing-space" },
            "outsider-session-token",
          ),
        ).toEqual({ status: 403, body: { error: "authorization_refused" } });
        await sql("UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-command']");
        expect(await owner.submit(control("denied-clock", "ResumeWorld"))).toEqual({
          status: 403,
          body: encodeCanonicalNode({
            commandId: "denied-clock",
            outcome: "rejected",
            value: { status: "denied", reasonCode: "runtime-grant-missing" },
            events: [],
          }),
        });
        expect(await commandCounts(sql, "denied-clock")).toBe("1|1|0");
        await sql("UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-clock']");
        expect((await committed(control("granted-clock", "PauseWorld"))).running).toBe(false);
        expect(
          await owner.submit(control("denied-unknown-clock", "ResumeWorld"), {
            spaceId: "missing-space",
          }),
        ).toEqual({
          status: 403,
          body: encodeCanonicalNode({
            commandId: "denied-unknown-clock",
            outcome: "rejected",
            value: { status: "denied", reasonCode: "world-participation-absent" },
            events: [],
          }),
        });
        expect(await commandCounts(sql, "denied-unknown-clock")).toBe("0|0|0");
        await sql(
          "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:no-op','runtime:world-command','runtime:world-clock']",
        );
        await sql("UPDATE clockgrove.world_memberships SET revoked_at=now()");
        for (const [id, overrides] of [
          ["revoked-clock", {}],
          ["revoked-unknown-clock", { spaceId: "missing-space" }],
        ] as const) {
          expect(await owner.submit(control(id, "ResumeWorld"), overrides)).toEqual({
            status: 403,
            body: encodeCanonicalNode({
              commandId: id,
              outcome: "rejected",
              value: { status: "denied", reasonCode: "world-participation-absent" },
              events: [],
            }),
          });
        }
        expect(await commandCounts(sql, "revoked-clock")).toBe("1|1|0");
        expect(await commandCounts(sql, "revoked-unknown-clock")).toBe("0|0|0");
        await sql("UPDATE clockgrove.world_memberships SET revoked_at=NULL");
        const foreign = control("foreign-clock", "ResumeWorld");
        expect(
          await owner.submit(
            {
              ...foreign,
              target: { ...foreign.target, tenantId: decodeOpaqueId("foreign-tenant", "TenantId") },
            },
            { tenantId: "foreign-tenant" },
          ),
        ).toEqual({ status: 403, body: { error: "authorization_refused" } });
        await sql("UPDATE clockgrove.worlds SET lifecycle_status='provisioning'");
        expect(await owner.submit(control("unready-clock", "ResumeWorld"))).toEqual({
          status: 409,
          body: { error: "world_not_ready" },
        });
        await sql("UPDATE clockgrove.worlds SET lifecycle_status='ready'");
        // Undecodable, well-formed but stale against the latest ClockPolicyChanged, and an event
        // with no policy (never a genesis fallback): each is a durable defect with nothing written.
        for (const [id, corruption] of [
          [
            "corrupt-clock",
            "UPDATE clockgrove.partition_states SET clock_policy='[\"object\",[]]'::jsonb",
          ],
          [
            "stale-clock",
            "UPDATE clockgrove.partition_states SET clock_policy=(SELECT payload->'clockPolicy' FROM clockgrove.events WHERE event_type='ClockPolicyChanged' ORDER BY partition_sequence LIMIT 1)",
          ],
          [
            "policyless-clock",
            "UPDATE clockgrove.partition_states SET clock_policy=NULL; UPDATE clockgrove.events SET payload=payload-'clockPolicy' WHERE event_type='ClockPolicyChanged'",
          ],
        ] as const) {
          await sql(corruption);
          expect(await owner.submit(control(id, "ResumeWorld"))).toEqual({
            status: 500,
            body: { error: "durable_state_corrupt" },
          });
          expect(await commandCounts(sql, id)).toBe("0|0|0");
        }
      });
    },
    180_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "runs a client command at earned time after overdue work, and refuses when too far behind",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { world, sql } = owner;
        const wall0 = BigInt(Date.now());
        await owner.reset();
        await configureAutonomousOwner(owner, wall0, 4, false);
        const control = (id: string, type: string, payload: unknown) =>
          owner.submit({ ...advanceCommand(world, id, 0n, null), type, payload });
        const policy = { schemaVersion: 1, simulationMillisecondsPerWallMillisecond: 1 };
        await control("speed", "SetClockPolicy", { ...policy, catchUpCapMs: 1_000_000_000n });
        await control("resume", "ResumeWorld", { schemaVersion: 1 });
        const { document } = (await inspectNativeWorldOwner(owner)).partition;
        const due = BigInt(
          await sql(
            "SELECT min(due_at) FROM clockgrove.partition_schedules WHERE status='pending'",
          ),
        );
        // One wall millisecond past the first deadline: that deadline is overdue.
        const earned = due + 1n;
        const wall = wall0 + earned - document.state.simulationTime;
        await configureAutonomousOwner(owner, wall, 4, false);
        const view = (await inspectNativeWorldOwner(owner)).partition as {
          earned?: { canonical: boolean; simulationTime: bigint };
        };
        expect(view.earned).toMatchObject({ canonical: false, simulationTime: earned });
        const rain = { schemaVersion: 2, rainIntensity: 5000 };
        const weather = (id: string) => ({
          ...advanceCommand(world, id, 0n, null),
          type: "world.weather.set",
          payload: rain,
        });
        expect((await owner.submit(weather("at-earned"))).status).toBe(200);
        expect(
          await sql(
            `SELECT simulation_time||'|'||(SELECT count(*) FROM clockgrove.command_receipts WHERE command_id LIKE 'trusted:advance:%') FROM clockgrove.partition_states`,
          ),
        ).toBe(`${earned}|1`);
        // More than 8 deadlines overdue: refused retryably, the command not recorded.
        await configureAutonomousOwner(owner, wall + 10_000_000_000n, 4, false);
        expect(await owner.submit(weather("too-far-behind"))).toEqual({
          status: 503,
          body: { error: "world_catching_up" },
        });
        expect(await commandCounts(sql, "too-far-behind")).toBe("0|0|0");
        // Across a weather boundary (3600000) with no deadline due: the boundary is processed as
        // its own step, then the command runs at earned time rather than stopping before it.
        await owner.reset();
        await configureAutonomousOwner(owner, wall0, 4, false);
        expect(
          (await owner.submit(advanceCommand(world, "near-boundary", 3_599_000n, null))).status,
        ).toBe(200);
        await control("speed2", "SetClockPolicy", { ...policy, catchUpCapMs: 1_000_000_000n });
        await control("resume2", "ResumeWorld", { schemaVersion: 1 });
        await configureAutonomousOwner(owner, wall0 + 21_000n, 4, false);
        expect((await owner.submit(weather("across-boundary"))).status).toBe(200);
        expect(
          await sql(
            "SELECT simulation_time||'|'||(SELECT string_agg(simulation_time::text, ',') FROM clockgrove.events WHERE event_type='weather.transitioned') FROM clockgrove.partition_states",
          ),
        ).toBe("3620000|3600000");
      });
    },
    180_000,
  );
});
