import { decodeCanonicalNode } from "@clockgrove/application";
import { describe, expect, it } from "vitest";
import type { RuntimeStateView } from "../src/inspector.js";
import { advanceCommand } from "./world-fixture.js";
import {
  canonicalResponse,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  waitForOwnerSql,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

describe("runtime-state inspector and operator actions", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns Queue delivery and PostgreSQL resources",
    async () => {
      await runNativeWorldOwnerProcess(
        "apps/runtime/test/operator-inspector.postgres.test.ts",
        "fixture",
        { queues: true },
      );
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "diagnoses a failed publication and a poison message, then repairs and replays them",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { sql, world, scope } = owner;
        const id = (key: string) => `${key}:dispatch:world-reactions`;
        const dispatch = (key: string, expression: string) =>
          sql(
            `SELECT ${expression} FROM clockgrove.event_dispatches WHERE dispatch_id='${id(key)}'`,
          );
        const advance = async (key: string, through: bigint) =>
          expect((await owner.submit(advanceCommand(world, key, through, null))).status).toBe(200);
        const logged = async (event: string) => {
          const records = () => owner.logs().filter((log) => log.includes(event));
          for (let attempt = 0; attempt < 300 && records().length === 0; attempt++)
            await sql("SELECT pg_sleep(0.01)");
          return records();
        };
        const state = () =>
          owner.request("/v1/runtime/runtime-state", { schemaVersion: 1, ...scope });
        // Issue 327: the world debugger's journal checks the same grant and the operator_evidence ceiling.
        const journal = () => owner.request("/v1/runtime/journal", { schemaVersion: 1, ...scope });
        const act = (action: string, key: string) =>
          owner.request("/v1/runtime/actions", {
            schemaVersion: 1,
            ...scope,
            action,
            messageId: id(key),
          });
        const grant = (name: string) =>
          sql(`UPDATE clockgrove.world_memberships SET grants = array_append(grants, '${name}')`);
        const refused = { status: 403, body: { error: "authorization_refused" } };

        await advance("op-consumed", 120_000n);
        await waitForOwnerSql(
          sql,
          `SELECT count(*) FROM clockgrove.event_dispatches WHERE consumed_at IS NOT NULL`,
          "1",
          500,
        );
        // A poison message: every consumption of this batch fails as an internal defect, so the
        // native Queue dead-letters it after its 31 delivery attempts.
        await sql(
          `CREATE FUNCTION clockgrove.op_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.dispatch_id='${id("op-poison")}' AND NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL THEN RAISE EXCEPTION USING ERRCODE='XX000'; END IF; RETURN NEW; END $$; CREATE TRIGGER op_poison BEFORE UPDATE ON clockgrove.event_dispatches FOR EACH ROW EXECUTE FUNCTION clockgrove.op_poison()`,
        );
        await advance("op-poison", 240_000n);
        // A failed publication: a message over the Queue's 128 KB limit fails permanently at once.
        await sql(
          `CREATE FUNCTION clockgrove.op_oversize() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.dispatch_id='${id("op-failed")}' THEN NEW.payload := NEW.payload || jsonb_build_object('pad', repeat('x', 130000)); END IF; RETURN NEW; END $$; CREATE TRIGGER op_oversize BEFORE INSERT ON clockgrove.event_dispatches FOR EACH ROW EXECUTE FUNCTION clockgrove.op_oversize()`,
        );
        await advance("op-failed", 360_000n);
        await waitForOwnerSql(
          sql,
          `SELECT status || '|' || attempts || '|' || last_error_class FROM clockgrove.event_dispatches WHERE dispatch_id='${id("op-failed")}'`,
          "failed|1|permanent",
          500,
        );
        await waitForOwnerSql(
          sql,
          `SELECT dead_letter_class FROM clockgrove.event_dispatches WHERE dispatch_id='${id("op-poison")}'`,
          "internal",
          3_000,
        );

        // Alert signals: one closed-name record per terminal failure.
        const publication = await logged("world_reactions_publication_failed");
        expect(publication.length).toBe(1);
        expect(publication[0]).toContain(`messageId: '${id("op-failed")}'`);
        expect(publication[0]).toContain("attempt: 1");
        expect(publication[0]).toContain("failureClass: 'too_large'");
        expect(publication[0]).toContain("disposition: 'awaiting-repair'");
        const deadLetter = await logged("world_reactions_dead_lettered");
        expect(deadLetter.length).toBe(1);
        expect(deadLetter[0]).toContain("failureClass: 'internal'");
        expect(deadLetter[0]).toContain("attempt: 31");
        expect(deadLetter[0]).toContain("disposition: 'awaiting-replay'");

        // Diagnosis: the inspector's grant, refusal codes and audit; canonical and operational labels.
        expect(await state()).toEqual(refused);
        expect(await journal()).toEqual(refused);
        await grant("runtime:world-inspect");
        const served = await state();
        expect(served.status).toBe(200);
        const view = decodeCanonicalNode(canonicalResponse(served.body)) as RuntimeStateView;
        expect(view.authority).toBe("journal");
        expect(view.placement.evidence).toBe("canonical");
        const head = await sql(
          "SELECT p.partition_id || '|' || p.head_sequence || '|' || s.revision FROM clockgrove.timeline_partitions p JOIN clockgrove.partition_states s USING (tenant_id, partition_id)",
        );
        const { partitionId, journalHead, projectionRevision } = view.placement.value;
        expect(`${partitionId}|${journalHead}|${projectionRevision}`).toBe(head);
        expect(view.worldReactions.evidence).toBe("canonical");
        expect(view.worldReactions.value.redacted).toBe(false);
        expect({ ...view.worldReactions.value.unconsumed }).toEqual({
          pending: 0,
          leased: 0,
          delivered: 1,
          failed: 1,
        });
        expect(
          view.worldReactions.value.oldest.map((row) => [
            row.messageId,
            row.status,
            row.attempts,
            row.lastErrorClass,
            row.deadLetter?.failureClass ?? null,
          ]),
        ).toEqual([
          [id("op-poison"), "delivered", 1, null, "internal"],
          [id("op-failed"), "failed", 1, "permanent", null],
        ]);
        for (const value of [view.runtime, view.owner, view.catchUpWorkflow]) {
          expect(value.evidence).toBe("operational");
          expect(value.mayBeStale).toBe(true);
          expect(typeof value.observedAt).toBe("number");
        }
        expect(view.runtime.value.routeVersion).toBe("clockgrove-route-v1");
        expect(view.runtime.value.localSchemaVersion).toBe(1);
        const { hydration, incarnation, mailbox } = view.owner.value;
        // Through world commands alone, the owner's last commit hydrated the current revision, in an
        // incarnation that started on empty storage.
        expect(hydration?.revision).toBe(projectionRevision);
        expect(incarnation.initialization?.disposition).toBe("rehydrated");
        expect([mailbox.depth, mailbox.admission, mailbox.active]).toEqual([0, "open", null]);
        // Protected values are redacted under the caller's privacy ceiling.
        await sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling = '{"version":1,"allowedCategories":["operator_evidence"]}'`,
        );
        const redacted = decodeCanonicalNode(
          canonicalResponse((await state()).body),
        ) as RuntimeStateView;
        expect(redacted.worldReactions.value.redacted).toBe(true);
        expect(redacted.worldReactions.value.unconsumed).toBeNull();
        expect(redacted.worldReactions.value.oldest).toEqual([]);
        await sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling = '{"version":1,"allowedCategories":["public_scene"]}'`,
        );
        expect(await journal()).toEqual(refused);
        await sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","operator_evidence"]}'`,
        );
        expect((await journal()).status).toBe(200);
        expect(
          await sql(
            "SELECT string_agg(concat_ws('|', subject, coalesce(command_id, '-'), decision, reason_code), ',' ORDER BY access_id) FROM clockgrove.inspector_accesses",
          ),
        ).toBe(
          [
            "runtime-state|-|deny|runtime-grant-missing",
            "journal|-|deny|runtime-grant-missing",
            "runtime-state|-|allow|served",
            "runtime-state|-|allow|served",
            "journal|-|deny|authority-mismatch",
            "journal|-|allow|served",
          ].join(","),
        );

        // Recovery: both actions need runtime:world-operate; runtime:world-inspect is read-only.
        const canonical = () =>
          sql(
            "SELECT md5(jsonb_build_object('events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM clockgrove.events e),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM clockgrove.command_receipts r),'decisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY authority_decision_id) FROM clockgrove.authority_decisions d),'states',(SELECT jsonb_agg(to_jsonb(s) ORDER BY partition_id) FROM clockgrove.partition_states s))::text)",
          );
        const before = await canonical();
        expect(await act("repair-publication", "op-failed")).toEqual(refused);
        expect(await act("replay-message", "op-poison")).toEqual(refused);
        await grant("runtime:world-operate");
        expect(await act("repair-publication", "op-consumed")).toEqual({
          status: 409,
          body: { error: "publication_not_failed" },
        });
        expect(await act("repair-publication", "op-unknown")).toEqual({
          status: 404,
          body: { error: "message_not_found" },
        });
        // Correct the cause, then repair: the row returns to pending under its message ID, and the
        // next sweep publishes it once (one more attempt) and the consumer verifies it.
        await sql(
          `DROP TRIGGER op_oversize ON clockgrove.event_dispatches; DROP FUNCTION clockgrove.op_oversize(); UPDATE clockgrove.event_dispatches SET payload = payload - 'pad' WHERE dispatch_id='${id("op-failed")}'`,
        );
        expect(await act("repair-publication", "op-failed")).toEqual({
          status: 200,
          body: { action: "repair-publication", messageId: id("op-failed"), outcome: "repaired" },
        });
        expect(await dispatch("op-failed", "status || '|' || attempts")).toBe("pending|1");
        await owner.reconcileDispatches();
        await waitForOwnerSql(
          sql,
          `SELECT status || '|' || attempts || '|' || (consumed_at IS NOT NULL) FROM clockgrove.event_dispatches WHERE dispatch_id='${id("op-failed")}'`,
          "delivered|2|true",
          500,
        );
        await owner.reconcileDispatches();
        expect(await dispatch("op-failed", "status || '|' || attempts")).toBe("delivered|2");
        // Replay the dead-lettered message through its source Queue under its message ID, after the
        // cause is fixed; a second replay finds the successful disposition and leaves it unchanged.
        const dlq = await owner.request("/dispatches/dlq", {});
        expect(
          (dlq.body as { body: { messageId: string } }[]).map(({ body }) => body.messageId),
        ).toEqual([id("op-poison")]);
        await sql(
          "DROP TRIGGER op_poison ON clockgrove.event_dispatches; DROP FUNCTION clockgrove.op_poison()",
        );
        const replayed = {
          status: 200,
          body: { action: "replay-message", messageId: id("op-poison"), outcome: "replayed" },
        };
        expect(await act("replay-message", "op-poison")).toEqual(replayed);
        await waitForOwnerSql(
          sql,
          `SELECT consumed_principal_id FROM clockgrove.event_dispatches WHERE dispatch_id='${id("op-poison")}'`,
          `system:world:${scope.worldId}`,
          500,
        );
        const consumedAt = await dispatch("op-poison", "consumed_at::text");
        expect(await act("replay-message", "op-poison")).toEqual(replayed);
        await sql("SELECT pg_sleep(1)");
        expect(
          await dispatch("op-poison", "consumed_at::text || '|' || status || '|' || attempts"),
        ).toBe(`${consumedAt}|delivered|1`);
        expect(await canonical()).toBe(before);
        const recovered = decodeCanonicalNode(
          canonicalResponse((await state()).body),
        ) as RuntimeStateView;
        expect(recovered.worldReactions.value.oldest).toEqual([]);
        // Every accepted or refused action is audited with its principal, action, message and outcome.
        expect(
          await sql(
            "SELECT string_agg(concat_ws('|', principal_id, action, message_id, decision, reason_code), ',' ORDER BY action_id) FROM clockgrove.runtime_operator_actions",
          ),
        ).toBe(
          [
            ["repair-publication", "op-failed", "deny|runtime-grant-missing"],
            ["replay-message", "op-poison", "deny|runtime-grant-missing"],
            ["repair-publication", "op-consumed", "allow|not-failed"],
            ["repair-publication", "op-unknown", "allow|not-found"],
            ["repair-publication", "op-failed", "allow|repaired"],
            ["replay-message", "op-poison", "allow|replayed"],
            ["replay-message", "op-poison", "allow|replayed"],
          ]
            .map(
              ([action, key, outcome]) => `principal-runtime|${action}|${id(key ?? "")}|${outcome}`,
            )
            .join(","),
        );

        // Issue 327: the journal reads under the caller's ceiling. A row above it (private
        // cognition) is absent from the window, and a replay across it is unavailable as a gap.
        type Page = {
          journalHead: string;
          events: { eventId: string; partitionSequence: string }[];
          replay?: { status: string; to: string; reason?: string; matchesLive?: boolean };
        };
        const page = async (extra: Record<string, string>) => {
          const response = await owner.request("/v1/runtime/journal", {
            schemaVersion: 1,
            ...scope,
            ...extra,
          });
          expect(response.status).toBe(200);
          return response.body as Page;
        };
        const covered = await sql(
          `SELECT covered_head_sequence::text FROM clockgrove.partition_states WHERE partition_id='${partitionId}'`,
        );
        const visible = await page({ replayTo: covered });
        expect(visible.replay?.status).toBe("replayed");
        expect(visible.replay?.matchesLive).toBe(true);
        expect(visible.events.map((event) => event.partitionSequence)).toContain("2");
        const hidden = await sql(
          `UPDATE clockgrove.events SET privacy_class='private_cognition' WHERE partition_id='${partitionId}' AND partition_sequence=2 RETURNING event_id`,
        );
        const ceiling = await page({ replayTo: covered });
        const sequences = ceiling.events.map((event) => event.partitionSequence);
        expect(sequences).toEqual(
          visible.events.map((event) => event.partitionSequence).filter((value) => value !== "2"),
        );
        expect(ceiling.events.map((event) => event.eventId)).not.toContain(hidden);
        expect(ceiling.replay).toEqual({
          status: "unavailable",
          to: covered,
          reason: "journal sequence-gap: an event above your privacy ceiling, or a missing one",
        });
        // Below the hidden row, a replay folds only what the caller may read.
        expect((await page({ replayTo: "1" })).replay?.status).toBe("replayed");

        // A replay folds at most 2,000 events past its start: the projection's covered head moved
        // 2,050 past where it stood, a position there is refused before any event is read.
        const far = (BigInt(covered) + 2_050n).toString();
        await sql(
          `UPDATE clockgrove.partition_states SET covered_head_sequence=${far} WHERE partition_id='${partitionId}'`,
        );
        const bounded = (await page({ replayTo: far })).replay;
        expect(bounded?.status).toBe("unavailable");
        expect(bounded?.reason).toMatch(
          /^\d{4,} events past (the world's birth|the snapshot at #\d+); a replay folds at most 2000 events and no snapshot is nearer$/u,
        );

        // Scope IDs are bounded like the runtime-state view's: 1 to 1024 octets, so an oversized
        // ID is refused as invalid before any read, and no audit row is attempted.
        const audited = () => sql("SELECT count(*) FROM clockgrove.inspector_accesses");
        const rows = await audited();
        for (const path of ["/v1/runtime/journal", "/v1/runtime/runtime-state"])
          expect(
            await owner.request(path, { schemaVersion: 1, ...scope, spaceId: "s".repeat(2_000) }),
          ).toEqual({ status: 400, body: { error: "invalid_inspection_request" } });
        expect(await audited()).toBe(rows);
      });
    },
    110_000,
  );
});
