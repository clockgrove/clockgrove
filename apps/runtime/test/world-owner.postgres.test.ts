import {
  type CausalCommandView,
  continuationCommandId,
  decodeCanonicalNode,
  encodeCanonicalNode,
  type WorldCommandResult,
} from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import { canonicalBytes } from "@clockgrove/kernel";
import { withClientTransaction } from "@clockgrove/persistence";
import { describe, expect, it } from "vitest";
import { decodeWorldCommandInput, PostgreSqlCommandOwner } from "../src/world-commands.js";
import {
  advanceCommand,
  commandCounts,
  kernelModel,
  pureStep,
  stateHash,
} from "./world-fixture.js";
import {
  canonicalResponse,
  inspectNativeWorldOwner,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  waitForOwnerSql,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

describe("authenticated native physical owner", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns the finite native subprocess and disposable database",
    async () => {
      await runNativeWorldOwnerProcess("apps/runtime/test/world-owner.postgres.test.ts");
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "preserves journal authority, admission, fences, retries and recovery through the production Worker",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { world, sql, scope } = owner;
        const model = kernelModel(world);
        const inspect = () => inspectNativeWorldOwner(owner);
        const advance = (id: string, target: bigint, expected: bigint | null = null) =>
          advanceCommand(world, id, target, expected);
        const first = advance("native-first", 120_000n, model.state.revision);

        // Readiness is disclosed only after authenticating a member of the named tenant.
        await sql("UPDATE clockgrove.worlds SET lifecycle_status = 'provisioning'");
        const unready = await owner.durable();
        expect(await owner.submit(first)).toEqual({
          status: 409,
          body: { error: "world_not_ready" },
        });
        expect(await owner.durable()).toBe(unready);
        expect(await owner.submit(first, {}, "invalid-session")).toEqual({
          status: 401,
          body: { error: "authentication_refused" },
        });
        expect(await owner.submit(first, {}, "")).toEqual({
          status: 401,
          body: { error: "authentication_refused" },
        });
        const foreign = {
          tenantId: "foreign-tenant",
          command: encodeCanonicalNode({
            ...first,
            target: { ...first.target, tenantId: decodeOpaqueId("foreign-tenant", "TenantId") },
          }),
        };
        const outsiderUnready = await owner.submit(first, {}, "outsider-session-token");
        expect(outsiderUnready).toEqual({ status: 403, body: { error: "authorization_refused" } });
        const foreignUnready = await owner.submit(first, foreign);
        expect(foreignUnready).toEqual({ status: 403, body: { error: "authorization_refused" } });
        await sql("UPDATE clockgrove.worlds SET lifecycle_status = 'ready'");
        expect(await owner.submit(first, foreign)).toEqual(foreignUnready);
        expect(await owner.submit(first, {}, "outsider-session-token")).toEqual(outsiderUnready);
        expect(await owner.submit(first, {}, "")).toEqual({
          status: 401,
          body: { error: "authentication_refused" },
        });
        expect(await owner.submit(first, {}, "invalid-session")).toEqual({
          status: 401,
          body: { error: "authentication_refused" },
        });
        expect(await owner.durable()).toBe(unready);

        // Neither the no-op grant nor administrative membership supplies physical authority.
        const physicalQuery =
          "SELECT jsonb_build_object('states',(SELECT jsonb_agg(to_jsonb(s)) FROM clockgrove.partition_states s),'schedules',(SELECT jsonb_agg(to_jsonb(s) ORDER BY schedule_id,idempotency_key) FROM clockgrove.partition_schedules s),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY partition_sequence) FROM clockgrove.events e))::text";
        const physicalBefore = await sql(physicalQuery);
        await sql("UPDATE clockgrove.world_memberships SET grants = ARRAY['runtime:no-op']");
        expect(await owner.submit(advance("native-denied-noop", 120_000n))).toEqual({
          status: 403,
          body: encodeCanonicalNode({
            commandId: "native-denied-noop",
            outcome: "rejected",
            value: { status: "denied", reasonCode: "runtime-grant-missing" },
            events: [],
          }),
        });
        await sql(
          `INSERT INTO clockgrove_management.workspace_memberships VALUES ('${scope.tenantId}','principal-runtime','native-admin',ARRAY['admin'],ARRAY['runtime:world-command'],NULL)`,
        );
        await sql("UPDATE clockgrove.world_memberships SET revoked_at = now()");
        expect(await owner.submit(advance("native-denied-admin", 120_000n))).toEqual({
          status: 403,
          body: encodeCanonicalNode({
            commandId: "native-denied-admin",
            outcome: "rejected",
            value: { status: "denied", reasonCode: "world-participation-absent" },
            events: [],
          }),
        });
        expect(
          await owner.submit(first, {
            authority: { grants: ["runtime:world-command"], worldMembershipId: "spoof" },
          }),
        ).toEqual({ status: 400, body: { error: "invalid_world_command" } });
        expect(await commandCounts(sql, first.commandId)).toBe("0|0|0");
        expect(await commandCounts(sql, "native-denied-noop")).toBe("1|1|0");
        expect(await commandCounts(sql, "native-denied-admin")).toBe("1|1|0");
        expect(await sql(physicalQuery)).toBe(physicalBefore);
        await sql(
          "UPDATE clockgrove.world_memberships SET revoked_at = NULL, grants = ARRAY['runtime:no-op','runtime:world-command']",
        );

        const deniedBeforeGrantRetry = await owner.durable();
        expect(await owner.submit(advance("native-denied-noop", 120_000n))).toEqual({
          status: 403,
          body: encodeCanonicalNode({
            commandId: "native-denied-noop",
            outcome: "rejected",
            value: { status: "denied", reasonCode: "runtime-grant-missing" },
            events: [],
          }),
        });
        expect(await owner.durable()).toBe(deniedBeforeGrantRetry);
        const initial = await inspect();
        expect(initial.partition.document.state).toEqual(model.state);
        expect(initial.partition.document.randomState).toBe(model.random);
        expect(initial.partition.document.schedules).toEqual(model.schedules);
        expect(initial.worldName).not.toBe(initial.spaceName);
        expect(initial.local.state.routeName).toBe(initial.spaceName);
        expect(initial.local.state.partitionId).toBe(initial.partition.partitionId);

        // A sleep inside the state write proves the HTTP result waits for the whole transaction.
        await sql(
          "CREATE FUNCTION clockgrove.native_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$; CREATE TRIGGER native_pause BEFORE UPDATE ON clockgrove.partition_states FOR EACH ROW EXECUTE FUNCTION clockgrove.native_pause()",
        );
        const beforeCommit = await owner.durable();
        let responseSettled = false;
        const pending = owner.submit(first).then((response) => {
          responseSettled = true;
          return response;
        });
        await waitForOwnerSql(
          sql,
          "SELECT count(*) FROM pg_stat_activity WHERE usename='clockgrove_runtime' AND wait_event='PgSleep'",
          "1",
        );
        expect(responseSettled).toBe(false);
        expect(
          await sql(
            "SELECT count(*) || '|' || count(*) FILTER (WHERE state='active' AND xact_start IS NOT NULL) FROM pg_stat_activity WHERE usename='clockgrove_runtime'",
          ),
        ).toBe("1|1");
        expect(await owner.durable()).toBe(beforeCommit);
        const firstResponse = await pending;
        expect(firstResponse.status).toBe(200);
        const firstResult = decodeCanonicalNode(
          canonicalResponse(firstResponse.body),
        ) as WorldCommandResult;
        const pure = pureStep(world, model, {
          ...first,
          attribution: {
            ...first.attribution,
            principalId: decodeOpaqueId("principal-runtime", "PrincipalId"),
            worldMembershipId: decodeOpaqueId("membership-runtime", "WorldMembershipId"),
            personaId: decodeOpaqueId("persona-runtime", "WorldPersonaId"),
          },
        });
        expect({
          commandId: firstResult.commandId,
          outcome: firstResult.outcome,
          value: firstResult.value,
        }).toEqual({
          commandId: first.commandId,
          outcome: "committed",
          value: {
            status: "committed",
            revision: model.state.revision.toString(),
            simulationTime: model.state.simulationTime.toString(),
            complete: pure.complete,
            eventCount: pure.events.length,
            stateHash: await stateHash(model.state),
          },
        });
        expect(
          firstResult.events.map((event) =>
            canonicalBytes(
              decodeCanonicalNode((event.payload as { kernelEvent: unknown }).kernelEvent),
            ),
          ),
        ).toEqual(pure.events.map(canonicalBytes));
        expect(await commandCounts(sql, first.commandId)).toBe(`1|1|${pure.events.length}`);
        expect(
          await sql(
            "SELECT status || '|' || (committed_at IS NOT NULL)::text FROM clockgrove.command_receipts WHERE command_id='native-first'",
          ),
        ).toBe("committed|true");
        expect(
          await sql(
            "SELECT outcome FROM clockgrove.authority_decisions WHERE command_id='native-first'",
          ),
        ).toBe("allow");
        const afterFirstInspection = await inspect();
        expect(afterFirstInspection.local.state.projectionRevision).toBe(
          BigInt(await sql("SELECT head_sequence FROM clockgrove.timeline_partitions")),
        );
        expect(afterFirstInspection.local.state.projectionRevision).not.toBe(
          initial.local.state.projectionRevision,
        );
        expect(afterFirstInspection.partition.document).toEqual({
          state: model.state,
          schedules: model.schedules,
          randomState: model.random,
        });
        expect(await sql("SELECT state_hash FROM clockgrove.partition_states")).toBe(
          await stateHash(model.state),
        );
        expect(
          await sql("SELECT count(*) FROM clockgrove.partition_schedules WHERE status='pending'"),
        ).toBe(model.schedules.length.toString());
        await sql(
          "DROP TRIGGER native_pause ON clockgrove.partition_states; DROP FUNCTION clockgrove.native_pause()",
        );

        // Causal-chain inspector: its own grant, one audit row per access, stable codes only.
        const chain = (commandId: string, tenantId = scope.tenantId, spaceId = scope.spaceId) =>
          owner.request("/v1/runtime/causal-chain", {
            schemaVersion: 1,
            ...scope,
            tenantId,
            spaceId,
            commandId,
          });
        const audit = () =>
          sql(
            "SELECT string_agg(concat_ws('|', tenant_id, principal_id, world_id, timeline_id, space_id, command_id, decision, reason_code), ',' ORDER BY access_id) FROM clockgrove.inspector_accesses",
          );
        const accessRow = (
          tenant: string,
          command: string,
          decision: string,
          space = scope.spaceId,
        ) =>
          [tenant, "principal-runtime", scope.worldId, scope.timelineId, space, command]
            .concat(decision)
            .join("|");
        const refused = { status: 403, body: { error: "authorization_refused" } };
        expect(await chain("native-first")).toEqual(refused);
        // An existing foreign tenant is audited under it; an invented one is refused alike, unrecorded.
        await sql(
          "INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('foreign-tenant', 'Foreign')",
        );
        expect(await chain("native-first", "foreign-tenant")).toEqual(refused);
        expect(await chain("native-first", "invented-tenant")).toEqual(refused);
        await sql(
          "UPDATE clockgrove.world_memberships SET grants = array_append(grants, 'runtime:world-inspect')",
        );
        const served = await chain("native-first");
        expect(served.status).toBe(200);
        const view = decodeCanonicalNode(canonicalResponse(served.body)) as CausalCommandView;
        expect(view.receipt).toMatchObject({ commandId: "native-first", status: "committed" });
        expect(view.receipt).not.toHaveProperty("committedEventIds");
        expect(view.decision).toMatchObject({ outcome: "allow", commandId: "native-first" });
        expect(view.events.map((event) => event.eventId).join(",")).toBe(
          await sql(
            "SELECT array_to_string(canonical_event_ids, ',') FROM clockgrove.command_receipts WHERE command_id='native-first'",
          ),
        );
        const notFound = { status: 404, body: { error: "command_not_found" } };
        expect(await chain("native-unknown")).toEqual(notFound);
        // A grant on another space of the same world does not reach this space's chain.
        await sql(
          "INSERT INTO clockgrove.world_memberships (tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id, roles, grants, privacy_ceiling, committed_at) SELECT tenant_id, world_id, timeline_id, 'space-other', principal_id, membership_id || '-other', persona_id, roles, grants, privacy_ceiling, committed_at FROM clockgrove.world_memberships",
        );
        expect(await chain("native-first", scope.tenantId, "space-other")).toEqual(notFound);
        expect(await audit()).toBe(
          [
            accessRow(scope.tenantId, "native-first", "deny|runtime-grant-missing"),
            accessRow("foreign-tenant", "native-first", "deny|world-participation-absent"),
            accessRow(scope.tenantId, "native-first", "allow|served"),
            accessRow(scope.tenantId, "native-unknown", "allow|not-found"),
            accessRow(scope.tenantId, "native-first", "allow|not-found", "space-other"),
          ].join(","),
        );
        // Retention: the next access retires the tenant's rows older than 90 days and keeps newer ones.
        await sql(
          `INSERT INTO clockgrove.inspector_accesses (tenant_id, principal_id, world_id, timeline_id, space_id, command_id, decision, reason_code, accessed_at) SELECT '${scope.tenantId}', 'principal-aged', 'w', 't', 's', aged.id, 'allow', 'served', statement_timestamp() - aged.age FROM (VALUES ('aged-91', interval '91 days'), ('aged-89', interval '89 days')) AS aged (id, age)`,
        );
        expect(await chain("native-first")).toMatchObject({ status: 200 });
        expect(
          await sql(
            "SELECT string_agg(command_id, ',') FROM clockgrove.inspector_accesses WHERE principal_id = 'principal-aged'",
          ),
        ).toBe("aged-89");

        const beforeRefusal = (await inspect()).partition;
        const refusalResponse = await owner.submit(advance("native-kernel-refusal", 0n));
        expect(refusalResponse.status).toBe(409);
        const refusal = decodeCanonicalNode(
          canonicalResponse(refusalResponse.body),
        ) as WorldCommandResult;
        expect({
          commandId: refusal.commandId,
          outcome: refusal.outcome,
          value: refusal.value,
          events: refusal.events,
        }).toEqual({
          commandId: "native-kernel-refusal",
          outcome: "rejected",
          value: {
            status: "refused",
            refusal: { code: "invalid-input", path: "payload.targetTime" },
          },
          events: [],
        });
        expect((await inspect()).partition).toEqual(beforeRefusal);
        expect(await commandCounts(sql, "native-kernel-refusal")).toBe("1|1|0");
        // issue 749: a rejected command has no events; its routed space scopes and serves it.
        const rejected = await chain("native-kernel-refusal");
        expect(rejected.status).toBe(200);
        expect(
          (decodeCanonicalNode(canonicalResponse(rejected.body)) as CausalCommandView).receipt,
        ).toMatchObject({ commandId: "native-kernel-refusal", status: "rejected" });
        expect(await chain("native-kernel-refusal", scope.tenantId, "space-other")).toEqual(
          notFound,
        );
        // issue 748: 300 accesses per principal per tenant an hour. Over it, an allow is refused before
        // anything is read or recorded, and a denial answers alike but is not recorded.
        const fill = (tenant: string, count: number) =>
          sql(
            `INSERT INTO clockgrove.inspector_accesses (tenant_id, principal_id, world_id, timeline_id, space_id, command_id, decision, reason_code) SELECT '${tenant}', 'principal-runtime', 'w', 't', 's', 'filler', 'deny', 'authority-mismatch' FROM generate_series(1, ${count})`,
          );
        await fill(scope.tenantId, 300 - 7);
        await fill("foreign-tenant", 300 - 1);
        const rows = "SELECT count(*) FROM clockgrove.inspector_accesses";
        const limitedAt = await sql(rows);
        expect(await chain("native-first")).toEqual({
          status: 429,
          body: { error: "inspection_rate_limited" },
        });
        expect(await chain("native-first", "foreign-tenant")).toEqual(refused);
        expect(await sql(rows)).toBe(limitedAt);

        // A decided command retains its accepted identity after the durable fence changes.
        const decided = await owner.durable();
        await sql("UPDATE clockgrove.timeline_partitions SET routing_epoch=2");
        expect(await owner.submit(first)).toEqual(firstResponse);
        expect(await owner.durable()).toBe(decided);
        expect(
          await owner.submit({
            ...first,
            payload: { schemaVersion: 1, targetTime: 180_000n, maxInputs: 64, maxEvents: 256 },
          }),
        ).toEqual({ status: 409, body: { error: "command_id_reused" } });
        expect(await owner.durable()).toBe(decided);
        for (const field of ["routingEpoch", "authorityEpoch"]) {
          expect(
            await owner.submit(advance(`native-stale-${field}`, 180_000n), {
              routingEpoch: "2",
              authorityEpoch: "2",
              [field]: "1",
            }),
          ).toEqual({
            status: 409,
            body: { error: "world_command_conflict", kind: "routing-epoch" },
          });
          expect(await commandCounts(sql, `native-stale-${field}`)).toBe("0|0|0");
        }
        // The immutable-resource read follows hydration. Block it, commit a new durable epoch,
        // then release it: the journal transaction must fence the already hydrated owner.
        const raced = await owner.withSqlClient((client) =>
          withClientTransaction(client, {}, async () => {
            await client.query(
              "LOCK TABLE clockgrove_birth.pack_artifact_resources IN ACCESS EXCLUSIVE MODE",
            );
            const response = owner.submit(advance("native-race-fence", 180_000n), {
              routingEpoch: "2",
              authorityEpoch: "2",
            });
            await waitForOwnerSql(
              sql,
              "SELECT count(*) FROM pg_stat_activity WHERE usename='clockgrove_runtime' AND wait_event_type='Lock' AND query LIKE '%resource.resource_kind%'",
              "1",
            );
            await sql("UPDATE clockgrove.timeline_partitions SET routing_epoch=3");
            return { response };
          }),
        );
        expect(await raced.response).toEqual({
          status: 409,
          body: { error: "world_command_conflict", kind: "routing-epoch" },
        });
        expect(await owner.durable()).toBe(decided);
        expect(await sql("SELECT routing_epoch FROM clockgrove.timeline_partitions")).toBe("3");
        await sql("UPDATE clockgrove.timeline_partitions SET routing_epoch=1");

        // Owner admission order spans the database await and a failed admission never strands its successor.
        await sql(
          "CREATE FUNCTION clockgrove.native_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.simulation_time IN (240000,480000) THEN PERFORM pg_sleep(0.5); END IF; IF NEW.simulation_time=360000 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='native failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER native_order BEFORE UPDATE ON clockgrove.partition_states FOR EACH ROW EXECUTE FUNCTION clockgrove.native_order()",
        );
        const left = advance("native-left", 240_000n);
        const leftPending = owner.submit(left);
        await waitForOwnerSql(
          sql,
          "SELECT count(*) FROM pg_stat_activity WHERE usename='clockgrove_runtime' AND wait_event='PgSleep'",
          "1",
        );
        const right = advance("native-right", 300_000n);
        const rightPending = owner.submit(right);
        expect((await leftPending).status).toBe(200);
        expect((await rightPending).status).toBe(200);
        pureStep(world, model, left);
        pureStep(world, model, right);
        expect(
          await sql(
            "SELECT string_agg(command_id,',' ORDER BY (result->>'revision')::bigint) FROM clockgrove.command_receipts WHERE command_id IN ('native-left','native-right')",
          ),
        ).toBe("native-left,native-right");
        const failure = await owner.submit(advance("native-failed", 360_000n));
        expect(failure).toEqual({ status: 500, body: { error: "world_command_failed" } });
        expect(await commandCounts(sql, "native-failed")).toBe("0|0|0");
        const afterFailure = advance("native-after-failure", 420_000n);
        expect((await owner.submit(afterFailure)).status).toBe(200);
        pureStep(world, model, afterFailure);
        const cancelled = advance("native-cancelled-response", 480_000n);
        const controller = new AbortController();
        const lostResponse = owner.request(
          "/v1/runtime/commands",
          {
            schemaVersion: 1,
            ...scope,
            routingEpoch: "1",
            authorityEpoch: "1",
            command: encodeCanonicalNode(cancelled),
          },
          undefined,
          controller.signal,
        );
        // Attach the rejection assertion before cancellation so no unhandled rejection can escape.
        const cancelledAssertion = expect(lostResponse).rejects.toMatchObject({
          name: "AbortError",
        });
        await waitForOwnerSql(
          sql,
          "SELECT count(*) FROM pg_stat_activity WHERE usename='clockgrove_runtime' AND wait_event='PgSleep'",
          "1",
        );
        controller.abort();
        await cancelledAssertion;
        const afterCancellation = advance("native-after-cancellation", 540_000n);
        expect((await owner.submit(afterCancellation)).status).toBe(200);
        const cancelledStep = pureStep(world, model, cancelled);
        const cancelledValue = {
          status: "committed",
          revision: model.state.revision.toString(),
          simulationTime: "480000",
          complete: cancelledStep.complete,
          eventCount: cancelledStep.events.length,
          stateHash: await stateHash(model.state),
        };
        pureStep(world, model, afterCancellation);
        const storedAfterLoss = await owner.withSqlClient((client) =>
          new PostgreSqlCommandOwner(client).stored(
            decodeWorldCommandInput({
              schemaVersion: 1,
              ...scope,
              routingEpoch: "1",
              authorityEpoch: "1",
              command: encodeCanonicalNode(cancelled),
            }),
            decodeOpaqueId("principal-runtime", "PrincipalId"),
          ),
        );
        if (storedAfterLoss === undefined)
          throw new Error("cancelled response must leave a decided receipt");
        expect({
          commandId: storedAfterLoss.commandId,
          outcome: storedAfterLoss.outcome,
          value: storedAfterLoss.value,
        }).toEqual({ commandId: cancelled.commandId, outcome: "committed", value: cancelledValue });
        const afterLossDurable = await owner.durable();
        await sql("UPDATE clockgrove.timeline_partitions SET routing_epoch=2");
        expect(await owner.submit(cancelled)).toEqual({
          status: 200,
          body: encodeCanonicalNode(storedAfterLoss),
        });
        expect(await commandCounts(sql, cancelled.commandId)).toBe(
          `1|1|${cancelledStep.events.length}`,
        );
        expect(await owner.durable()).toBe(afterLossDurable);
        await sql("UPDATE clockgrove.timeline_partitions SET routing_epoch=1");
        expect(
          await sql(
            "SELECT string_agg(command_id,',' ORDER BY (result->>'revision')::bigint) FROM clockgrove.command_receipts WHERE command_id IN ('native-cancelled-response','native-after-cancellation')",
          ),
        ).toBe("native-cancelled-response,native-after-cancellation");
        expect(
          await sql("SELECT count(*) FROM pg_stat_activity WHERE usename='clockgrove_runtime'"),
        ).toBe("0");
        await sql(
          "DROP TRIGGER native_order ON clockgrove.partition_states; DROP FUNCTION clockgrove.native_order()",
        );

        // Mailbox bounds, narrowed to depth 2 and a 2 s deadline: a full mailbox refuses
        // before enqueue, a queued entry past its deadline is dropped unrun, and a deadline passing
        // mid-transaction answers for retry while the command still commits. Expected values are literals.
        const mailbox = async (bounds?: unknown) =>
          (await owner.request("/mailbox", { scope, bounds })).body as {
            depth: number;
            oldestEntryAgeMs: number;
          };
        await mailbox({ maxDepth: 2, requestDeadlineMs: 2_000, retryAfterSeconds: 1 });
        await sql(
          "CREATE FUNCTION clockgrove.native_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.simulation_time=600000 THEN PERFORM pg_sleep(5); END IF; RETURN NEW; END $$; CREATE TRIGGER native_hold BEFORE UPDATE ON clockgrove.partition_states FOR EACH ROW EXECUTE FUNCTION clockgrove.native_hold()",
        );
        const held = advance("native-held", 600_000n);
        const heldPending = owner.submit(held);
        await waitForOwnerSql(
          sql,
          "SELECT count(*) FROM pg_stat_activity WHERE usename='clockgrove_runtime' AND wait_event='PgSleep'",
          "1",
        );
        const expired = advance("native-expired", 660_000n);
        const expiredPending = owner.submit(expired);
        let full = await mailbox();
        for (let attempt = 0; full.depth < 2 && attempt < 100; attempt++) full = await mailbox();
        expect(full).toMatchObject({
          depth: 2,
          admission: "full",
          active: {
            kind: "command",
            commandId: "native-held",
            requestId: "native-held",
            correlationId: "correlation-native-held",
            routeEpoch: "1",
            startedAt: expect.any(Number),
          },
        });
        expect(full.oldestEntryAgeMs).toBeGreaterThan(0);
        const overflow = advance("native-overflow", 720_000n);
        const retryLater = { retryAfterSeconds: 1 };
        expect(await owner.submit(overflow)).toEqual({
          status: 503,
          body: { error: "owner_mailbox_full", ...retryLater },
        });
        expect(await heldPending).toEqual({
          status: 503,
          body: { error: "owner_mailbox_timeout", ...retryLater },
        });
        expect(await expiredPending).toEqual({
          status: 503,
          body: { error: "owner_mailbox_expired", ...retryLater },
        });
        // The timed-out command commits after its answer; its exact retry returns the stored receipt.
        await waitForOwnerSql(
          sql,
          "SELECT count(*) FROM clockgrove.command_receipts WHERE command_id='native-held' AND status='committed'",
          "1",
          1_000,
        );
        // Once the lane drains, the dropped and refused commands still never ran.
        let drained = await mailbox();
        for (let attempt = 0; drained.depth > 0 && attempt < 500; attempt++)
          drained = await mailbox();
        expect(drained.depth).toBe(0);
        expect(await commandCounts(sql, "native-expired")).toBe("0|0|0");
        expect(await commandCounts(sql, "native-overflow")).toBe("0|0|0");
        const heldRetry = await owner.submit(held);
        const heldStep = pureStep(world, model, held);
        expect(heldRetry.status).toBe(200);
        expect(
          (decodeCanonicalNode(canonicalResponse(heldRetry.body)) as WorldCommandResult).value,
        ).toEqual({
          status: "committed",
          revision: model.state.revision.toString(),
          simulationTime: "600000",
          complete: heldStep.complete,
          eventCount: heldStep.events.length,
          stateHash: await stateHash(model.state),
        });
        expect(await commandCounts(sql, held.commandId)).toBe(`1|1|${heldStep.events.length}`);
        // The dropped and refused commands' successors run; the lane drains to empty.
        for (const next of [expired, overflow]) {
          expect((await owner.submit(next)).status).toBe(200);
          pureStep(world, model, next);
        }
        expect(await mailbox(null)).toEqual({
          depth: 0,
          oldestEntryAgeMs: 0,
          admission: "open",
          active: null,
        });
        await sql(
          "DROP TRIGGER native_hold ON clockgrove.partition_states; DROP FUNCTION clockgrove.native_hold()",
        );

        // The public result exposes incomplete progress; only trusted owner work resumes its stored chunks.
        const incomplete = advanceCommand(world, "native-incomplete", 1_200_000n, null, {
          maxInputs: 1,
          maxEvents: 256,
        });
        const incompleteResponse = await owner.submit(incomplete);
        expect(incompleteResponse.status).toBe(200);
        const incompleteResult = decodeCanonicalNode(
          canonicalResponse(incompleteResponse.body),
        ) as WorldCommandResult;
        const partial = pureStep(world, model, incomplete);
        expect(partial.complete).toBe(false);
        expect(incompleteResult.value).toEqual({
          status: "committed",
          revision: model.state.revision.toString(),
          simulationTime: model.state.simulationTime.toString(),
          complete: false,
          eventCount: partial.events.length,
          stateHash: await stateHash(model.state),
        });
        const open = (await inspect()).partition.continuation;
        if (open === undefined) throw new Error("incomplete command must persist continuation");
        expect(await owner.submit({ ...incomplete, commandId: open.commandId })).toEqual({
          status: 400,
          body: { error: "invalid_world_command" },
        });
        expect(await commandCounts(sql, open.commandId)).toBe("0|0|0");
        const openDurable = await owner.durable();
        expect(await owner.submit(incomplete)).toEqual(incompleteResponse);
        expect(await owner.submit(advance("native-during-continuation", 1_260_000n))).toEqual({
          status: 409,
          body: { error: "world_continuation_pending" },
        });
        expect(await commandCounts(sql, "native-during-continuation")).toBe("0|0|0");
        expect(
          await owner.request("/resume", { ...scope, commandId: "trusted-resume" }, ""),
        ).toEqual({ status: 401, body: { error: "authentication_refused" } });
        expect(
          await owner.request(
            "/resume",
            { ...scope, commandId: "trusted-resume" },
            "outsider-session-token",
          ),
        ).toEqual({ status: 403, body: { error: "authorization_refused" } });
        await sql("UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:no-op']");
        expect(await owner.request("/resume", { ...scope, commandId: "trusted-resume" })).toEqual({
          status: 403,
          body: { error: "authorization_refused" },
        });
        expect(await owner.submit(incomplete)).toEqual(incompleteResponse);
        await sql(
          "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:no-op','runtime:world-command']",
        );
        expect(await owner.durable()).toBe(openDurable);
        let chunks = 0;
        for (; chunks < 32; chunks++) {
          const next = (await inspect()).partition.continuation;
          if (next === undefined) break;
          expect(next.commandId).toBe(continuationCommandId(incomplete.commandId, chunks + 1));
          expect(next.record.chunk).toBe(chunks + 1);
          const resumed = await owner.request("/resume", { ...scope, commandId: "trusted-resume" });
          expect(resumed.status).toBe(200);
          const chunk = decodeCanonicalNode(canonicalResponse(resumed.body)) as WorldCommandResult;
          const expected = pureStep(
            world,
            model,
            next.record.originCommand,
            next.record.originCommand,
            next.record.continuation,
          );
          expect({
            commandId: chunk.commandId,
            outcome: chunk.outcome,
            value: chunk.value,
          }).toEqual({
            commandId: next.commandId,
            outcome: "committed",
            value: {
              status: "committed",
              revision: model.state.revision.toString(),
              simulationTime: model.state.simulationTime.toString(),
              complete: expected.complete,
              eventCount: expected.events.length,
              stateHash: await stateHash(model.state),
            },
          });
          expect(
            chunk.events.map((event) =>
              canonicalBytes(
                decodeCanonicalNode((event.payload as { kernelEvent: unknown }).kernelEvent),
              ),
            ),
          ).toEqual(expected.events.map(canonicalBytes));
        }
        expect((await inspect()).partition.continuation).toBeUndefined();
        expect(model.state.simulationTime).toBe(1_200_000n);
        expect(await owner.request("/resume", { ...scope, commandId: "trusted-resume" })).toEqual({
          status: 200,
          body: encodeCanonicalNode(null),
        });

        const afterContinuation = advance("native-after-continuation", 1_260_000n);
        const afterContinuationResponse = await owner.submit(afterContinuation);
        expect(afterContinuationResponse.status).toBe(200);
        const finalStep = pureStep(world, model, afterContinuation);
        expect(
          (
            decodeCanonicalNode(
              canonicalResponse(afterContinuationResponse.body),
            ) as WorldCommandResult
          ).value,
        ).toEqual({
          status: "committed",
          revision: model.state.revision.toString(),
          simulationTime: "1260000",
          complete: finalStep.complete,
          eventCount: finalStep.events.length,
          stateHash: await stateHash(model.state),
        });
        const committedInspection = await inspect();
        const committedDurable = await owner.durable();
        for (const loseStorage of [false, true]) {
          await owner.replace(loseStorage);
          const recovered = await inspect();
          expect({
            worldId: recovered.worldId,
            spaceId: recovered.spaceId,
            worldName: recovered.worldName,
            spaceName: recovered.spaceName,
          }).toEqual({
            worldId: initial.worldId,
            spaceId: initial.spaceId,
            worldName: initial.worldName,
            spaceName: initial.spaceName,
          });
          expect(canonicalBytes(recovered.partition)).toEqual(
            canonicalBytes(committedInspection.partition),
          );
          expect(recovered.partition.document).toEqual({
            state: model.state,
            schedules: model.schedules,
            randomState: model.random,
          });
          expect(await stateHash(recovered.partition.document.state)).toBe(
            await stateHash(model.state),
          );
          expect(await owner.durable()).toBe(committedDurable);
        }
        // A local projection left at epoch 1 is superseded by database truth on the next invocation.
        await sql("UPDATE clockgrove.timeline_partitions SET routing_epoch=4");
        const authoritative = await inspect();
        expect(authoritative.local.state.placement.routingEpoch).toBe(4n);
        expect(authoritative.partition.routingEpoch).toBe(4n);
        expect(authoritative.partition.document).toEqual(committedInspection.partition.document);
        // Corruption is a durable defect, never a malformed-client response or another execution.
        await sql("UPDATE clockgrove.partition_states SET document_hash=repeat('0',64)");
        const corrupt = await owner.durable();
        expect(
          await owner.submit(advance("native-corrupt", 1_320_000n), {
            routingEpoch: "4",
            authorityEpoch: "4",
          }),
        ).toEqual({ status: 500, body: { error: "durable_state_corrupt" } });
        expect(await commandCounts(sql, "native-corrupt")).toBe("0|0|0");
        // The fresh space owner's fencing claim precedes any read of the corrupt document: exactly
        // one new generation for this owner, and every other canonical row stays as it was.
        const prior = JSON.parse(corrupt) as { states: Record<string, unknown>[] };
        const claimed = JSON.parse(await owner.durable()) as typeof prior;
        expect(claimed).toEqual({
          ...prior,
          states: prior.states.map((state) => ({
            ...state,
            clock_owner_generation: Number(state.clock_owner_generation) + 1,
            clock_owner_id: expect.stringMatching(/^cloudflare:/),
          })),
        });
        expect(claimed.states[0]?.clock_owner_id).not.toBe(prior.states[0]?.clock_owner_id);
      });
    },
    110_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "settles native connections when the journey callback fails",
    async () => {
      const failure = new Error("deliberate owner journey failure");
      await expect(
        withNativeWorldOwner(async (owner) => {
          expect(
            await owner.request("/v1/runtime/commands", {
              schemaVersion: 1,
              ...owner.scope,
              routingEpoch: "1",
              authorityEpoch: "1",
              command: ["invalid"],
            }),
          ).toEqual({ status: 400, body: { error: "invalid_world_command" } });
          throw failure;
        }),
      ).rejects.toBe(failure);
      await withNativeWorldOwner(async (owner) => {
        expect(
          await owner.sql(
            "SELECT count(*) FROM pg_stat_activity WHERE usename IN ('clockgrove_runtime','clockgrove_auth_verifier','clockgrove_management_reader','clockgrove_world_reader')",
          ),
        ).toBe("0");
      });
    },
    30_000,
  );
});
