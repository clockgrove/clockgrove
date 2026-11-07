import { decodeQueueEnvelope } from "@clockgrove/contracts";
import { describe, expect, it } from "vitest";
import { advanceCommand } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  waitForOwnerSql,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

describe("production world-reactions native Queue lifecycle", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns Queue delivery and PostgreSQL resources",
    async () => {
      await runNativeWorldOwnerProcess(
        "apps/runtime/test/queue-lifecycle.postgres.test.ts",
        "fixture",
        {
          queues: true,
        },
      );
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "publishes canonical batches, deduplicates redelivery and isolates poison siblings",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { sql, world } = owner;
        const unordered = (value: unknown) =>
          Array.isArray(value) ? value.map((item) => JSON.stringify(item)).sort() : value;
        const advance = async (id: string, through: bigint, revision: bigint | null = null) =>
          (await owner.submit(advanceCommand(world, id, through, revision))).status;
        const dispatchValue = (id: string, expression: string) =>
          sql(
            `SELECT ${expression} FROM clockgrove.event_dispatches WHERE dispatch_id='${id}:dispatch:world-reactions'`,
          );
        const waitConsumed = (id: string, status?: string) =>
          waitForOwnerSql(
            sql,
            `SELECT count(*) FROM clockgrove.event_dispatches WHERE dispatch_id='${id}:dispatch:world-reactions' AND consumed_at IS NOT NULL${status === undefined ? "" : ` AND status='${status}'`}`,
            "1",
            500,
          );
        const sweepFailures = async (count: number) => {
          const failed = () => owner.logs().filter((log) => log.includes("sweep_failed"));
          for (let attempt = 0; attempt < 300 && failed().length < count; attempt++)
            await sql("SELECT pg_sleep(0.01)");
          return failed().map((log) =>
            log
              .match(/trigger: '(\w+)'.*failureClass: '(\w+)'/su)
              ?.slice(1)
              .join(":"),
          );
        };
        // A transaction blocked before commit cannot expose its outbox or publish a message.
        await sql(
          "CREATE FUNCTION clockgrove.queue_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$; CREATE TRIGGER queue_pause BEFORE UPDATE ON clockgrove.partition_states FOR EACH ROW EXECUTE FUNCTION clockgrove.queue_pause()",
        );
        const command = advanceCommand(world, "queue-first", 120_000n, null);
        const pending = owner.submit(command);
        const sleeping =
          "SELECT count(*) FROM pg_stat_activity WHERE usename='clockgrove_runtime' AND wait_event='PgSleep'";
        await waitForOwnerSql(sql, sleeping, "1");
        expect(await dispatchValue("queue-first", "count(*)")).toBe("0");
        expect((await pending).status).toBe(200);
        await sql(
          "DROP TRIGGER queue_pause ON clockgrove.partition_states; DROP FUNCTION clockgrove.queue_pause()",
        );
        const successful =
          "SELECT count(*) FROM clockgrove.event_dispatches WHERE dispatch_id='queue-first:dispatch:world-reactions' AND status='delivered' AND consumed_at IS NOT NULL";
        await waitForOwnerSql(sql, successful, "1");
        expect(await advance("queue-no-events", 120_000n)).toBe(200);
        expect(await advance("queue-rejected", 240_000n, 999_999n)).toBe(409);
        expect(
          await sql(
            "SELECT count(*) FROM clockgrove.event_dispatches WHERE dispatch_id IN ('queue-no-events:dispatch:world-reactions','queue-rejected:dispatch:world-reactions')",
          ),
        ).toBe("0");
        expect(
          await sql(
            "SELECT string_agg(command_id || ':' || status,',' ORDER BY command_id) FROM clockgrove.command_receipts WHERE command_id IN ('queue-no-events','queue-rejected')",
          ),
        ).toBe("queue-no-events:committed");
        const consumedAt = await dispatchValue("queue-first", "consumed_at::text");
        const unchanged =
          "SELECT jsonb_build_object('events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM clockgrove.events e),'state',(SELECT jsonb_agg(to_jsonb(s) ORDER BY partition_id) FROM clockgrove.partition_states s))::text";
        const carrierSql =
          "SELECT jsonb_build_object('schemaVersion',2,'messageId',d.dispatch_id,'channel',d.channel,'tenantId',d.tenant_id,'worldId',d.world_id,'timelineId',d.timeline_id,'sourceEventId',d.event_id,'correlationId',e.correlation_id,'attemptHint',d.attempts,'payload',d.payload)::text FROM clockgrove.event_dispatches d JOIN clockgrove.events e ON e.tenant_id=d.tenant_id AND e.event_id=d.event_id WHERE d.dispatch_id='queue-first:dispatch:world-reactions'";
        const carrier = async (id: string) =>
          decodeQueueEnvelope(
            JSON.parse(
              await sql(
                carrierSql.replace(
                  "queue-first:dispatch:world-reactions",
                  `${id}:dispatch:world-reactions`,
                ),
              ),
            ),
            (value) => value,
          );
        const envelope = await carrier("queue-first");
        // Attempt counts are transport metadata. Concurrent redelivery and replacement preserve
        // the first durable disposition, without changing canonical event or simulation state.
        await Promise.all([
          owner.enqueue(envelope),
          owner.enqueue({ ...envelope, attemptHint: 99 }),
        ]);
        await owner.replace();
        await owner.enqueue({ ...envelope, attemptHint: 100 });
        await sql(
          "CREATE FUNCTION clockgrove.queue_sibling_hint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.dispatch_id='queue-second:dispatch:world-reactions' AND NEW.status='leased' THEN RAISE EXCEPTION USING ERRCODE='40001'; END IF; RETURN NEW; END $$; CREATE TRIGGER queue_sibling_hint BEFORE UPDATE ON clockgrove.event_dispatches FOR EACH ROW EXECUTE FUNCTION clockgrove.queue_sibling_hint()",
        );
        expect(await advance("queue-second", 240_000n)).toBe(200);
        expect(await sweepFailures(1)).toEqual(["hint:transient"]);
        await sql(
          "DROP TRIGGER queue_sibling_hint ON clockgrove.event_dispatches; DROP FUNCTION clockgrove.queue_sibling_hint()",
        );
        const secondEnvelope = await carrier("queue-second");
        expect(await dispatchValue("queue-second", "(consumed_at IS NULL)::text")).toBe("true");
        await owner.enqueue([
          { privatePayload: "must-never-be-logged" },
          { ...envelope, messageId: "missing-canonical-dispatch" },
          secondEnvelope,
        ]);
        await waitForOwnerSql(
          sql,
          "SELECT count(*) FROM clockgrove.event_dispatches WHERE consumed_at IS NOT NULL",
          "2",
        );
        expect(await dispatchValue("queue-first", "consumed_at::text")).toBe(consumedAt);
        expect(
          await sql(
            "SELECT string_agg(dispatch_id,',' ORDER BY dispatch_id) FROM clockgrove.event_dispatches WHERE consumed_at IS NOT NULL",
          ),
        ).toBe("queue-first:dispatch:world-reactions,queue-second:dispatch:world-reactions");
        let dlq = await owner.request("/dispatches/dlq", {});
        for (
          let attempt = 0;
          attempt < 100 && (!Array.isArray(dlq.body) || dlq.body.length < 2);
          attempt++
        ) {
          await sql("SELECT pg_sleep(0.1)");
          dlq = await owner.request("/dispatches/dlq", {});
        }
        expect(dlq.status).toBe(200);
        const poisonTransport = [
          {
            siblings: [
              "malformed",
              "missing-canonical-dispatch",
              "queue-second:dispatch:world-reactions",
            ],
          },
          { attempt: 1, delaySeconds: 1 },
          { attempt: 2, delaySeconds: 2 },
          { attempt: 3, delaySeconds: 4 },
          { attempt: 4, delaySeconds: 8 },
        ];
        expect(await owner.request("/dispatches/transport", {})).toEqual({
          status: 200,
          body: poisonTransport,
        });
        expect(unordered(dlq.body)).toEqual(
          [
            JSON.stringify({ body: { privatePayload: "must-never-be-logged" }, attempts: 1 }),
            JSON.stringify({
              body: { ...envelope, messageId: "missing-canonical-dispatch" },
              attempts: 1,
            }),
          ].sort(),
        );
        const afterSecond = await sql(unchanged);

        const secondConsumedAt = await dispatchValue("queue-second", "consumed_at::text");
        // Reverse independent delivery order, then verify both original durable dispositions.
        await owner.enqueue(secondEnvelope);
        await owner.enqueue(envelope);
        await owner.reconcileDispatches();
        expect(await dispatchValue("queue-second", "consumed_at::text")).toBe(secondConsumedAt);
        expect(await sql(unchanged)).toBe(afterSecond);
        expect(await dispatchValue("queue-first", "consumed_principal_id")).toBe(
          `system:world:${owner.scope.worldId}`,
        );
        // Fixture decision: allow 500 existing 10 ms polls for the production 1 s retry.
        // A transient failure before durable consumption leaves no disposition and uses the
        // native Queue retry budget. A nontransactional sequence independently counts attempts.
        await sql(
          "CREATE SEQUENCE clockgrove.queue_attempts; GRANT USAGE, SELECT ON SEQUENCE clockgrove.queue_attempts TO clockgrove_runtime, clockgrove_migrator; CREATE FUNCTION clockgrove.queue_transient() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL AND nextval('clockgrove.queue_attempts')=1 THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='native transient consumption failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER queue_transient BEFORE UPDATE ON clockgrove.event_dispatches FOR EACH ROW EXECUTE FUNCTION clockgrove.queue_transient()",
        );
        expect(await advance("queue-transient", 360_000n)).toBe(200);
        expect(await dispatchValue("queue-transient", "(consumed_at IS NULL)::text")).toBe("true");
        const beforeSemanticConsumption = await sql(unchanged);
        await waitConsumed("queue-transient");
        expect(await sql("SELECT last_value FROM clockgrove.queue_attempts")).toBe("2");
        expect(await sql(unchanged)).toBe(beforeSemanticConsumption);
        await sql(
          "DROP TRIGGER queue_transient ON clockgrove.event_dispatches; DROP FUNCTION clockgrove.queue_transient(); DROP SEQUENCE clockgrove.queue_attempts",
        );
        // The fixture interrupts acknowledgement after the production consumer commits. Native
        // Queue redelivery must retain that same durable disposition.
        expect(await advance("queue-ack-loss", 480_000n)).toBe(200);
        await waitConsumed("queue-ack-loss");
        const ackTime = await dispatchValue("queue-ack-loss", "consumed_at::text");
        await sql("SELECT pg_sleep(2)");
        expect(await dispatchValue("queue-ack-loss", "consumed_at::text")).toBe(ackTime);
        const transport = await owner.request("/dispatches/transport", {});
        expect(transport.body).toEqual([
          ...poisonTransport,
          { messageId: "queue-ack-loss:dispatch:world-reactions", attempt: 1, disposition: "ack" },
          { messageId: "queue-ack-loss:dispatch:world-reactions", attempt: 2, disposition: "ack" },
        ]);
        expect(
          await sql(
            "SELECT count(*) FROM clockgrove.event_dispatches WHERE consumed_at IS NOT NULL",
          ),
        ).toBe("4");
        // A failed postcommit claim loses only the hint. Scheduled reconciliation on a fresh
        // isolate recovers it without a browser command or injected dispatch composition.
        await sql(
          "CREATE FUNCTION clockgrove.queue_hint_loss() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.dispatch_id='queue-lost-hint:dispatch:world-reactions' THEN PERFORM pg_sleep(1); RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='native hint interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER queue_hint_loss BEFORE UPDATE ON clockgrove.event_dispatches FOR EACH ROW EXECUTE FUNCTION clockgrove.queue_hint_loss()",
        );
        expect(await advance("queue-lost-hint", 600_000n)).toBe(200);
        // The command returned while its hint is still blocked in the claim: it never awaits it.
        await waitForOwnerSql(sql, sleeping, "1");
        expect(await sweepFailures(2)).toEqual(["hint:transient", "hint:transient"]);
        // A failing principal is logged and counted; the scheduled run itself still succeeds.
        expect(await owner.reconcileDispatches()).toEqual({ outcome: "ok", noRetry: false });
        expect(await sweepFailures(3)).toEqual([
          "hint:transient",
          "hint:transient",
          "cron:transient",
        ]);
        expect(
          await dispatchValue(
            "queue-lost-hint",
            "status || '|' || attempts || '|' || (consumed_at IS NULL)::text",
          ),
        ).toBe("pending|0|true");
        await sql(
          "DROP TRIGGER queue_hint_loss ON clockgrove.event_dispatches; DROP FUNCTION clockgrove.queue_hint_loss()",
        );
        await owner.replace(true);
        expect(await owner.reconcileDispatches()).toEqual({
          outcome: "ok",
          noRetry: false,
        });
        await waitConsumed("queue-lost-hint", "delivered");
        // Publication succeeded, then settlement fails. Lease expiry republishes the same ID;
        // durable consumption must keep its original timestamp across that second transport send.
        await sql(
          "CREATE FUNCTION clockgrove.queue_settle_loss() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.dispatch_id='queue-settle-loss:dispatch:world-reactions' AND NEW.status='delivered' THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='native settlement interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER queue_settle_loss BEFORE UPDATE ON clockgrove.event_dispatches FOR EACH ROW EXECUTE FUNCTION clockgrove.queue_settle_loss()",
        );
        expect(await advance("queue-settle-loss", 720_000n)).toBe(200);
        await waitConsumed("queue-settle-loss", "leased");
        const settledTime = await dispatchValue("queue-settle-loss", "consumed_at::text");
        await sql(
          "DROP TRIGGER queue_settle_loss ON clockgrove.event_dispatches; DROP FUNCTION clockgrove.queue_settle_loss(); UPDATE clockgrove.event_dispatches SET next_attempt_at=now() - interval '1 second' WHERE dispatch_id='queue-settle-loss:dispatch:world-reactions'",
        );
        await owner.reconcileDispatches();
        await waitForOwnerSql(
          sql,
          "SELECT status || '|' || attempts FROM clockgrove.event_dispatches WHERE dispatch_id='queue-settle-loss:dispatch:world-reactions'",
          "delivered|2",
          500,
        );
        expect(await dispatchValue("queue-settle-loss", "consumed_at::text")).toBe(settledTime);
        // Persistent operational failure and internal defect both exhaust the configured physical
        // Queue budget. The sequence counters survive rollback and count real consume attempts.
        await sql(
          "CREATE SEQUENCE clockgrove.queue_exhausted; CREATE SEQUENCE clockgrove.queue_internal; GRANT USAGE, SELECT ON SEQUENCE clockgrove.queue_exhausted, clockgrove.queue_internal TO clockgrove_migrator; CREATE FUNCTION clockgrove.queue_exhaust() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL THEN IF NEW.dispatch_id='queue-exhausted:dispatch:world-reactions' THEN PERFORM nextval('clockgrove.queue_exhausted'); RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='private operational failure'; ELSIF NEW.dispatch_id='queue-internal:dispatch:world-reactions' THEN PERFORM nextval('clockgrove.queue_internal'); RAISE EXCEPTION USING ERRCODE='XX000', MESSAGE='private internal defect'; END IF; END IF; RETURN NEW; END $$; CREATE TRIGGER queue_exhaust BEFORE UPDATE ON clockgrove.event_dispatches FOR EACH ROW EXECUTE FUNCTION clockgrove.queue_exhaust()",
        );
        expect(await advance("queue-exhausted", 840_000n)).toBe(200);
        expect(await advance("queue-internal", 960_000n)).toBe(200);
        const exhausted = await carrier("queue-exhausted");
        const internal = await carrier("queue-internal");
        for (let attempt = 0; attempt < 100; attempt++) {
          dlq = await owner.request("/dispatches/dlq", {});
          if (Array.isArray(dlq.body) && dlq.body.length === 2) break;
          await sql("SELECT pg_sleep(0.1)");
        }
        expect(unordered(dlq.body)).toEqual(
          [
            JSON.stringify({ body: exhausted, attempts: 1 }),
            JSON.stringify({ body: internal, attempts: 1 }),
          ].sort(),
        );
        expect(
          await sql(
            "SELECT (SELECT last_value FROM clockgrove.queue_exhausted) || '|' || (SELECT last_value FROM clockgrove.queue_internal) || '|' || count(*) FILTER (WHERE consumed_at IS NULL) FROM clockgrove.event_dispatches WHERE dispatch_id IN ('queue-exhausted:dispatch:world-reactions','queue-internal:dispatch:world-reactions')",
          ),
        ).toBe("4|4|2");
        const failures = owner
          .logs()
          .filter((log) => log.includes("world_reactions_delivery_failed"));
        expect(
          failures
            .map(
              (log) =>
                `${log.match(/failureClass: '([^']+)'/u)?.[1]}:${log.match(/attempt: (\d+)/u)?.[1]}`,
            )
            .sort(),
        ).toEqual(
          [
            "malformed:1,malformed:2,malformed:3,malformed:4",
            "inconsistent:1,inconsistent:2,inconsistent:3,inconsistent:4",
            "transient:1,transient:1,transient:2,transient:3,transient:4",
            "internal:1,internal:1,internal:2,internal:3,internal:4",
          ]
            .flatMap((group) => group.split(","))
            .sort(),
        );
        const identities = await owner.request("/dispatches/transport", {});
        expect(unordered(identities.body)).toEqual(
          failures
            .slice(-8)
            .map((log) =>
              JSON.stringify({
                transportMessageId: log.match(/transportMessageId: '([^']+)'/u)?.[1],
                attempt: Number(log.match(/attempt: (\d+)/u)?.[1]),
                delaySeconds: [1, 2, 4, 8][Number(log.match(/attempt: (\d+)/u)?.[1]) - 1],
                source: log.includes("failureClass: 'transient'")
                  ? "queue-exhausted:dispatch:world-reactions"
                  : "queue-internal:dispatch:world-reactions",
              }),
            )
            .sort(),
        );
        expect(owner.logs().join("\n")).not.toContain("must-never-be-logged");
        expect(owner.logs().join("\n")).not.toContain("private operational failure");
        expect(owner.logs().join("\n")).not.toContain("private internal defect");
        await sql(
          "DROP TRIGGER queue_exhaust ON clockgrove.event_dispatches; DROP FUNCTION clockgrove.queue_exhaust(); DROP SEQUENCE clockgrove.queue_exhausted, clockgrove.queue_internal",
        );
        // A second due world proves isolation. Its principal sorts after this world's, whose sweep
        // fails first: on a broken connection (claim 2) the run fails; on a transient error it continues.
        await sql(
          "CREATE SEQUENCE clockgrove.queue_isolation; CREATE FUNCTION clockgrove.queue_isolate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN IF NEW.dispatch_id='queue-isolated:dispatch:world-reactions' THEN IF nextval('clockgrove.queue_isolation')=2 THEN PERFORM pg_terminate_backend(pg_backend_pid()); END IF; RAISE EXCEPTION USING ERRCODE='40001'; END IF; RETURN NEW; END $$; CREATE TRIGGER queue_isolate BEFORE UPDATE ON clockgrove.event_dispatches FOR EACH ROW EXECUTE FUNCTION clockgrove.queue_isolate()",
        );
        expect(await advance("queue-isolated", 1_080_000n)).toBe(200);
        await waitForOwnerSql(
          sql,
          "SELECT is_called::text FROM clockgrove.queue_isolation",
          "true",
        );
        const second = `${owner.scope.worldId}-second`;
        await sql(
          `SET session_replication_role = replica; INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id, system_world_id) VALUES ('${owner.scope.tenantId}', 'system:world:${second}', '${second}'); UPDATE clockgrove.event_dispatches SET world_id='${second}', status='pending', attempts=0, lease_owner=NULL, settled_at=NULL, next_attempt_at=now() - interval '1 second' WHERE dispatch_id='queue-first:dispatch:world-reactions'`,
        );
        const isolation = `SELECT string_agg(status || '|' || attempts, ',' ORDER BY dispatch_id) FROM clockgrove.event_dispatches WHERE dispatch_id IN ('queue-first:dispatch:world-reactions','queue-isolated:dispatch:world-reactions')`;
        const cronFailures = () => owner.logs().filter((log) => log.includes("trigger: 'cron'"));
        const before = cronFailures().length;
        expect(await owner.reconcileDispatches()).toMatchObject({ outcome: "exception" });
        expect(await sql(isolation)).toBe("pending|0,pending|0");
        await sql("SELECT pg_sleep(0.2)");
        expect(cronFailures().length).toBe(before + 1);
        expect(await owner.reconcileDispatches()).toEqual({ outcome: "ok", noRetry: false });
        expect(await sql(isolation)).toBe("delivered|1,pending|0");
      });
    },
    110_000,
  );
});
