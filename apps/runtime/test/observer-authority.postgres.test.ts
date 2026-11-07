import { readFile } from "node:fs/promises";
import { decodeCanonicalNode } from "@clockgrove/application";
import { decodeLivingScene } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  canonicalResponse,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

it.skipIf(isNativeWorldOwnerChild())(
  "owns the native observation authority proof",
  async () => {
    await runNativeWorldOwnerProcess(
      "apps/runtime/test/observer-authority.postgres.test.ts",
      "fixture",
    );
  },
  180_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "separates observation, inspection and mutation at HTTP boundaries",
  async () => {
    const plan = await readFile(
      "docs/waves/clockgrove-wave-4-visual-projection-web-client-implementation-plan.md",
      "utf8",
    );
    expect(plan).toContain("Amended (2026-10-30)");
    expect(plan).toContain(
      "does not imply observation: operators need both grants to observe and inspect.",
    );
    await withNativeWorldOwner(async (owner) => {
      const scope = { version: 1, ...owner.scope };
      const refused = { status: 403, body: { error: "authorization_refused" } };
      const canonical =
        "SELECT jsonb_build_object('states',(SELECT jsonb_agg(to_jsonb(s) ORDER BY partition_id) FROM clockgrove.partition_states s),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM clockgrove.events e),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM clockgrove.command_receipts r),'schedules',(SELECT jsonb_agg(to_jsonb(q) ORDER BY schedule_id,idempotency_key) FROM clockgrove.partition_schedules q))::text";
      const before = await owner.sql(canonical);
      const commandId = await owner.sql(
        "SELECT command_id FROM clockgrove.events WHERE event_type='WorldReady'",
      );
      await owner.sql(
        "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe']",
      );
      const scene = decodeLivingScene((await owner.request("/v1/runtime/scene", scope)).body);
      const objectId = scene.entities[0]?.objectId;
      const reads = [
        ["scene", scope],
        ["entity", { ...scope, objectId }],
        ["why", { ...scope, commandId }],
      ] as const;
      for (const grants of [
        ["runtime:world-observe"],
        ["runtime:world-inspect"],
        ["runtime:world-observe", "runtime:world-inspect"],
      ]) {
        await owner.sql(
          `UPDATE clockgrove.world_memberships SET grants=ARRAY[${grants.map((grant) => `'${grant}'`).join(",")}]`,
        );
        for (const [endpoint, input] of reads) {
          const response = await owner.request(`/v1/runtime/${endpoint}`, input);
          if (grants.length === 1 && grants[0] === "runtime:world-inspect")
            expect(response).toEqual(refused);
          else expect(response.status).toBe(200);
        }
        const inspected = await owner.request("/v1/runtime/causal-chain", {
          schemaVersion: 1,
          ...owner.scope,
          commandId,
        });
        if (grants[0] === "runtime:world-observe" && grants.length === 1) {
          expect(inspected).toEqual(refused);
          expect(
            await owner.request("/v1/runtime/runtime-state", { schemaVersion: 1, ...owner.scope }),
          ).toEqual(refused);
        } else {
          expect(inspected.status).toBe(200);
          expect(decodeCanonicalNode(canonicalResponse(inspected.body))).toMatchObject({
            receipt: { commandId, status: "committed" },
          });
        }
        if (grants.includes("runtime:world-observe")) {
          for (const action of ["repair-publication", "replay-message"])
            expect(
              await owner.request("/v1/runtime/actions", {
                schemaVersion: 1,
                ...owner.scope,
                action,
                messageId: "unknown",
              }),
            ).toEqual(refused);
        }
      }
      expect(
        await owner.sql(
          "SELECT principal_id || '|' || subject || '|' || decision || '|' || reason_code FROM clockgrove.inspector_accesses WHERE decision='deny' ORDER BY access_id",
        ),
      ).toBe(
        "principal-runtime|causal-chain|deny|runtime-grant-missing\nprincipal-runtime|runtime-state|deny|runtime-grant-missing\nprincipal-runtime|causal-chain|deny|runtime-grant-missing",
      );
      expect(await owner.sql(canonical)).toBe(before);
    });
  },
  110_000,
);
