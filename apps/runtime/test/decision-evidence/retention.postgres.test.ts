import { decodeCanonicalNode, encodeCanonicalNode } from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import { record } from "@clockgrove/persistence";
import { describe, expect, it } from "vitest";
import { advanceCommand, kernelModel, pureStep, stateHash } from "../world-fixture.js";
import {
  canonicalResponse,
  inspectNativeWorldOwner,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../world-owner/native-harness.js";

const FILE = "apps/runtime/test/decision-evidence/retention.postgres.test.ts";

describe("retained decision evidence over authenticated HTTP", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns the native runtime and PostgreSQL",
    async () => {
      await runNativeWorldOwnerProcess(FILE);
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "serves original evidence after replacement and audits privacy, unavailable history and corrupt storage distinctly",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { world, scope, sql } = owner;
        const model = kernelModel(world);
        const command = advanceCommand(world, "retained-decisions", 160_000n, null);
        const original = pureStep(world, model, {
          ...command,
          attribution: {
            ...command.attribution,
            principalId: decodeOpaqueId("principal-runtime", "PrincipalId"),
            worldMembershipId: decodeOpaqueId("membership-runtime", "WorldMembershipId"),
            personaId: decodeOpaqueId("persona-runtime", "WorldPersonaId"),
          },
        });
        const drafts = original.decisionDrafts.filter((draft) => draft.kind === "routine");
        expect(drafts.length).toBe(2);
        const accepted = await owner.submit(command);
        expect(accepted.status).toBe(200);
        expect(
          record(decodeCanonicalNode(canonicalResponse(accepted.body)), "response").value,
        ).toEqual({
          status: "committed",
          revision: model.state.revision.toString(),
          simulationTime: model.state.simulationTime.toString(),
          complete: original.complete,
          eventCount: original.events.length,
          stateHash: await stateHash(model.state),
        });
        const committed = await owner.durable();
        expect((await inspectNativeWorldOwner(owner)).partition.document).toEqual({
          state: model.state,
          schedules: model.schedules,
          randomState: model.random,
        });
        const chain = () =>
          owner.request("/v1/runtime/causal-chain", {
            schemaVersion: 1,
            ...scope,
            commandId: command.commandId,
          });
        expect(await chain()).toEqual({ status: 403, body: { error: "authorization_refused" } });
        await sql(
          "UPDATE clockgrove.world_memberships SET grants = array_append(grants, 'runtime:world-inspect')",
        );
        const served = await chain();
        expect(served.status).toBe(200);
        const view = record(decodeCanonicalNode(canonicalResponse(served.body)), "view");
        expect(view.decisionTraces).toEqual({
          status: "available",
          drafts: encodeCanonicalNode(drafts),
        });
        expect(record(view.receipt, "receipt").commandId).toBe(command.commandId);
        expect(record(view.decision, "decision").commandId).toBe(command.commandId);
        expect(
          await sql(
            "SELECT array_to_string(canonical_event_ids, ',') FROM clockgrove.command_receipts WHERE command_id='retained-decisions'",
          ),
        ).toBe(original.events.map((_, index) => `${command.commandId}:event:${index}`).join(","));
        const events = view.events;
        if (!Array.isArray(events)) throw new Error("expected inspected events");
        expect(
          events.map((event) => record(record(event, "event").payload, "payload").kernelEvent),
        ).toEqual(original.events.map(encodeCanonicalNode));
        await owner.replace(true);
        expect(await owner.submit(command)).toEqual(accepted);
        expect(await owner.submit(command)).toEqual(accepted);
        expect(await chain()).toEqual(served);
        expect(await owner.durable()).toBe(committed);
        await sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling = '{"version":1,"allowedCategories":["operator_evidence"]}'::jsonb`,
        );
        const hidden = await chain();
        const { result: _result, ...receipt } = record(view.receipt, "receipt");
        expect(hidden).toEqual({
          status: 200,
          body: encodeCanonicalNode({
            evidence: view.evidence,
            receipt,
            decision: view.decision,
            events: [],
            schedules: [],
            dispatches: [],
            links: { parents: [], children: [] },
          }),
        });
        await sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","operator_evidence"]}'::jsonb`,
        );
        expect(
          await owner.request("/v1/runtime/causal-chain", { schemaVersion: 1, ...scope }),
        ).toEqual({ status: 400, body: { error: "invalid_inspection_request" } });
        await sql(
          "SET session_replication_role=replica; UPDATE clockgrove.command_receipts SET result = jsonb_set(result, '{projectionDelta,decisionTraces,hash}', '\"broken\"') WHERE command_id='retained-decisions'",
        );
        expect(await chain()).toEqual({ status: 500, body: { error: "inspection_failed" } });
        await sql(
          "SET session_replication_role=replica; UPDATE clockgrove.command_receipts SET result = result #- '{projectionDelta,decisionTraces}' WHERE command_id='retained-decisions'",
        );
        const historical = await chain();
        expect(historical.status).toBe(200);
        expect(
          record(decodeCanonicalNode(canonicalResponse(historical.body)), "view").decisionTraces,
        ).toEqual({ status: "unavailable" });
        expect(
          await sql(
            "SELECT string_agg(decision || '|' || reason_code, ',' ORDER BY access_id) FROM clockgrove.inspector_accesses",
          ),
        ).toBe(
          "deny|runtime-grant-missing,allow|served,allow|served,allow|served,allow|failed,allow|served",
        );
        expect(
          await sql(
            "SELECT string_agg(DISTINCT principal_id, ',') FROM clockgrove.inspector_accesses",
          ),
        ).toBe("principal-runtime");
        // The existing inspector limit is 300 accesses per principal/tenant/hour (migration 0028).
        await sql(
          `INSERT INTO clockgrove.inspector_accesses (tenant_id, principal_id, world_id, timeline_id, space_id, command_id, decision, reason_code) SELECT '${scope.tenantId}', 'principal-runtime', '${scope.worldId}', '${scope.timelineId}', '${scope.spaceId}', 'filler', 'allow', 'served' FROM generate_series(1,294)`,
        );
        expect(await chain()).toEqual({ status: 429, body: { error: "inspection_rate_limited" } });
        expect(await sql("SELECT count(*) FROM clockgrove.inspector_accesses")).toBe("300");
      });
    },
    120_000,
  );
});
