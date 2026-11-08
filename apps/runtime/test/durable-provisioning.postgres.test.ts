import {
  decodeCanonicalNode,
  encodeProvisioningSource,
  type LifecycleWorkflowEnvelope,
} from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import { canonicalBytes } from "@clockgrove/kernel";
import { seedGenesis } from "@clockgrove/simulator";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../../packages/simulator/test/fixtures/lamp-hall.js";
import { runtimeBindingManifest } from "../src/cloudflare-entry.js";
import { stableWorkflowInstanceId } from "../src/routing.js";
import * as workflows from "../src/workflows.js";
import { advanceCommand, provisioningRequest } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  waitForNativeWorkflow,
  waitForOwnerSql,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/durable-provisioning.postgres.test.ts";
const COUNTS = `SELECT
  (SELECT count(*) FROM clockgrove_birth.pack_installations),
  (SELECT count(*) FROM clockgrove.events WHERE event_type='WorldGenesisCreated'),
  (SELECT count(*) FROM clockgrove.events WHERE event_type='WorldSeedCommandApplied'),
  (SELECT count(*) FROM clockgrove.events WHERE event_type='WorldProjectionVerified'),
  (SELECT count(*) FROM clockgrove.events WHERE event_type='WorldReady'),
  (SELECT count(*) FROM clockgrove.command_receipts),
  (SELECT count(*) FROM clockgrove.worlds WHERE lifecycle_status='ready'),
  (SELECT seed_projection_hash FROM clockgrove_birth.world_birth_states)`;
// The terminal case released its source; the header stays as permanent evidence.
const RELEASED = `SELECT (workflow_source IS NULL AND workflow_source_bytes IS NULL)::text || '|' ||
  (workflow_request->'authorization' IS NOT NULL)::text FROM clockgrove_birth.provisioning_cases`;
const EXPECTED_COUNTS =
  "1|1|2|1|1|5|1|702644ad67a391da9aef59165338c00055e728eb5df8a644c99550fddf4a34e0";

interface Launch {
  readonly envelope: LifecycleWorkflowEnvelope;
  readonly instanceId: string;
  readonly readinessInstanceId: string;
}

describe("native durable world birth", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns the finite native Workflow/PostgreSQL process and cleanup",
    async () => {
      await runNativeWorldOwnerProcess(FILE, "lamp-hall", { provision: false, queues: true });
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "recovers every canonical commit boundary and reconciles lost execution history without duplicate birth effects",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const reference = await seedGenesis(
          { artifact: owner.world.artifact, source: owner.world.source },
          { sha256: sha256Hex },
        );
        expect(reference.ok).toBe(true);
        if (!reference.ok)
          throw new Error(`independent simulator reference refused: ${reference.error.code}`);
        const expectedReceiptIds = [
          reference.value.bundle.genesisCommandId,
          ...reference.value.bundle.seedCommands.map(({ commandId }) => commandId),
          `${reference.value.bundle.genesisCommandId}:projection-verified`,
          `${reference.value.bundle.genesisCommandId}:world-ready`,
        ]
          .map((id) => `trusted:world-provisioning:${id}`)
          .sort();
        for (const point of [
          "genesis",
          "seed-command-0",
          "seed-command-1",
          "projection-verified",
          "ready",
        ] as const) {
          for (const when of ["before-commit", "after-commit"] as const) {
            await owner.reset();
            const caseId = `native-fault:${point}:${when}`;
            const request = provisioningRequest(owner.world, "principal-runtime", caseId);
            const input = {
              request: encodeProvisioningSource(request),
              applicationRunId: `run-${point}-${when}`,
            };
            const launches = await Promise.all([
              owner.request("/provisioning/launch", input),
              owner.request("/provisioning/launch", input),
            ]);
            expect(launches.map(({ status }) => status)).toEqual([200, 200]);
            const launched = launches[0];
            if (launched === undefined) throw new Error("native launch result missing");
            const launch = launched.body as Launch;
            const repeated = launches[1];
            if (repeated === undefined) throw new Error("concurrent native launch result missing");
            expect((repeated.body as Launch).instanceId).toBe(launch.instanceId);
            expect((repeated.body as Launch).readinessInstanceId).toBe(launch.readinessInstanceId);
            expect(launch.envelope).toEqual({
              version: 1,
              tenantId: owner.scope.tenantId,
              caseId,
              applicationRunId: input.applicationRunId,
            });
            const redeliveryId = `redelivery-${point}-${when}`;
            expect(
              await owner.request("/provisioning/raw", {
                id: redeliveryId,
                params: launch.envelope,
              }),
            ).toEqual({ status: 200, body: { id: redeliveryId } });
            await waitForOwnerSql(
              owner.sql,
              "SELECT status FROM clockgrove_birth.provisioning_cases",
              "ready",
              1000,
            );
            expect(await owner.request("/provisioning/faults", {})).toEqual({
              status: 200,
              body: [caseId],
            });
            expect(await owner.sql(COUNTS)).toBe(EXPECTED_COUNTS);
            expect(
              JSON.parse(
                await owner.sql(
                  "SELECT json_agg(json_build_array(command_id,status) ORDER BY command_id)::text FROM clockgrove.command_receipts",
                ),
              ),
            ).toEqual(expectedReceiptIds.map((id) => [id, "committed"]));
            expect(await owner.sql(RELEASED)).toBe("true|true");
            expect(await owner.sql("SELECT state_hash FROM clockgrove.partition_states")).toBe(
              reference.value.bundle.finalStateHash,
            );
            expect(
              JSON.parse(
                await owner.sql(
                  "SELECT json_build_array(installation_id,case_id,world_id,pack_id,pack_version,content_hash,status)::text FROM clockgrove_birth.pack_installations",
                ),
              ),
            ).toEqual([
              `installation:${caseId}`,
              caseId,
              owner.scope.worldId,
              request.artifact.packId,
              request.artifact.version,
              request.artifact.contentHash,
              "installed",
            ]);
            expect(
              await owner.sql(
                "SELECT revision::text || '|' || simulation_time::text FROM clockgrove.partition_states",
              ),
            ).toBe("2|0");
            expect(await owner.sql("SELECT count(*) FROM clockgrove.partition_schedules")).toBe(
              reference.value.bundle.schedules.length.toString(),
            );
            const document = decodeCanonicalNode(
              JSON.parse(await owner.sql("SELECT document::text FROM clockgrove.partition_states")),
            ) as { readonly randomState: string; readonly schedulesHash: string };
            expect(document.randomState).toBe(reference.value.bundle.randomState);
            expect(document.schedulesHash).toBe(
              await sha256Hex(canonicalBytes(reference.value.bundle.schedules)),
            );
            expect(
              (
                await waitForNativeWorkflow(
                  owner,
                  launch.readinessInstanceId,
                  "complete",
                  "readiness",
                )
              ).output,
            ).toEqual({
              version: 1,
              disposition: "ready",
              world: {
                tenantId: owner.scope.tenantId,
                caseId,
                worldId: owner.scope.worldId,
                timelineId: owner.scope.timelineId,
                installationId: `installation:${caseId}`,
                packId: owner.world.artifact.packId,
                packVersion: owner.world.artifact.version,
                contentHash: owner.world.artifact.contentHash,
                lifecycleStatus: "ready",
              },
            });
            const durable = await owner.durable();
            const caseEvidence = await owner.sql(
              "SELECT to_jsonb(c)::text FROM clockgrove_birth.provisioning_cases c",
            );
            // A compatible runtime replacement discards all Workflow and DO history, keeping PostgreSQL.
            await owner.replace(true);
            const reconciled = await owner.request("/provisioning/reconcile", launch.envelope);
            expect(reconciled.status).toBe(200);
            expect(reconciled.body).toEqual({
              version: 1,
              envelope: launch.envelope,
              instanceId: launch.instanceId,
              readinessInstanceId: launch.readinessInstanceId,
              executionStatus: "not-needed",
              canonical: {
                status: "ready",
                worldId: owner.scope.worldId,
                receiptCommandIds: expectedReceiptIds,
              },
            });
            expect((reconciled.body as Launch).instanceId).toBe(launch.instanceId);
            expect((reconciled.body as Launch).readinessInstanceId).toBe(
              launch.readinessInstanceId,
            );
            expect(await owner.request("/provisioning/launch", input)).toMatchObject({
              status: 200,
              body: {
                instanceId: launch.instanceId,
                readinessInstanceId: launch.readinessInstanceId,
              },
            });
            expect(await owner.sql(COUNTS)).toBe(EXPECTED_COUNTS);
            expect(await owner.durable()).toBe(durable);
            await owner.sql(`INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
              VALUES ('${owner.scope.tenantId}', 'other-principal');
              INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('other-tenant', 'other');
              INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('other-tenant', 'principal-runtime')`);
            for (const conflicting of [
              { ...request, caseId: "conflicting-case" },
              {
                ...request,
                authorization: {
                  ...request.authorization,
                  principalId: decodeOpaqueId("other-principal", "PrincipalId"),
                },
              },
              { ...request, artifact: { ...request.artifact, contentHash: "0".repeat(64) } },
              { ...request, source: { changed: true } },
              {
                ...request,
                authorization: {
                  ...request.authorization,
                  tenantId: decodeOpaqueId("other-tenant", "TenantId"),
                },
              },
            ]) {
              expect(
                await owner.request("/provisioning/launch", {
                  ...input,
                  request: encodeProvisioningSource(conflicting),
                }),
              ).toEqual({ status: 409, body: { error: "ProvisioningCaseConflictError" } });
              expect(
                await owner.sql(
                  "SELECT to_jsonb(c)::text FROM clockgrove_birth.provisioning_cases c",
                ),
              ).toBe(caseEvidence);
              expect(await owner.durable()).toBe(durable);
            }
            expect(
              await owner.request("/provisioning/launch", {
                ...input,
                applicationRunId: "conflicting-run",
              }),
            ).toEqual({ status: 409, body: { error: "ProvisioningCaseConflictError" } });
            expect(
              await owner.sql(
                "SELECT to_jsonb(c)::text FROM clockgrove_birth.provisioning_cases c",
              ),
            ).toBe(caseEvidence);
            if (point === "genesis" && when === "before-commit") {
              // Ordinary world membership and both command/clock grants cannot invoke creation.
              await owner.sql(`INSERT INTO clockgrove.world_memberships (tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
                VALUES ('${owner.scope.tenantId}','${owner.scope.worldId}','${owner.scope.timelineId}','${owner.scope.spaceId}','principal-runtime','member','persona',ARRAY['world-member'],ARRAY['runtime:world-command','runtime:world-clock'],'{"version":1,"allowedCategories":["public_scene"]}',now())`);
              for (const path of [
                "/v1/runtime/worlds",
                "/WorldProvisioningEntrypoint/launch",
                "/launch",
              ]) {
                expect(await owner.request(path, input)).toEqual({
                  status: 404,
                  body: { error: "not_found" },
                });
              }
              expect(await owner.request("/v1/runtime/commands", input)).toEqual({
                status: 400,
                body: { error: "invalid_world_command" },
              });
              expect(
                await owner.sql(
                  "SELECT to_jsonb(c)::text FROM clockgrove_birth.provisioning_cases c",
                ),
              ).toBe(caseEvidence);
              expect(await owner.durable()).toBe(durable);
              const completeCase = await owner.sql(
                "SELECT to_jsonb(c)::text FROM clockgrove_birth.provisioning_cases c",
              );
              for (const direct of [
                { ...request, source: { changed: true } },
                {
                  ...request,
                  authorization: {
                    ...request.authorization,
                    principalId: decodeOpaqueId("other-principal", "PrincipalId"),
                  },
                },
              ]) {
                expect(
                  await owner.request("/provisioning/direct", encodeProvisioningSource(direct)),
                ).toEqual({ status: 409, body: { error: "ProvisioningCaseConflictError" } });
                expect(
                  await owner.sql(
                    "SELECT to_jsonb(c)::text FROM clockgrove_birth.provisioning_cases c",
                  ),
                ).toBe(completeCase);
                expect(await owner.durable()).toBe(durable);
              }
              const wrongRunId = "native-valid-envelope-wrong-run";
              expect(
                await owner.request("/provisioning/raw", {
                  id: wrongRunId,
                  params: { ...launch.envelope, applicationRunId: "wrong-run" },
                }),
              ).toEqual({ status: 200, body: { id: wrongRunId } });
              expect(
                (await waitForNativeWorkflow(owner, wrongRunId, "complete")).output,
              ).toMatchObject({
                version: 1,
                disposition: "refused",
                refusal: { code: "PROVISIONING_CASE_CONFLICT", path: "workflow" },
              });
              expect(
                await owner.sql(
                  "SELECT to_jsonb(c)::text FROM clockgrove_birth.provisioning_cases c",
                ),
              ).toBe(completeCase);
              expect(await owner.durable()).toBe(durable);
            }
          }
        }
      });
    },
    120_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "keeps exhausted and cancelled birth non-ready and hides readiness from unauthenticated callers and tenant outsiders",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        await owner.reset();
        const request = provisioningRequest(
          owner.world,
          "principal-runtime",
          "native-exhausted:ready:before-commit",
        );
        const launched = await owner.request("/provisioning/launch", {
          request: encodeProvisioningSource(request),
          applicationRunId: "exhausted-birth",
        });
        expect(launched.status).toBe(200);
        const launch = launched.body as Launch;
        await waitForOwnerSql(
          owner.sql,
          "SELECT status FROM clockgrove_birth.provisioning_cases",
          "verified",
          1000,
        );
        await owner.sql(`INSERT INTO clockgrove.world_memberships (tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
        VALUES ('${owner.scope.tenantId}','${owner.scope.worldId}','${owner.scope.timelineId}','${owner.scope.spaceId}','principal-runtime','birth-member','birth-persona',ARRAY['world-member'],ARRAY['runtime:world-command'],'{"version":1,"allowedCategories":["public_scene"]}',now())`);
        const before = await owner.durable();
        const command = advanceCommand(owner.world, "before-readiness", 0n, null);
        expect(await owner.submit(command)).toEqual({
          status: 409,
          body: { error: "world_not_ready" },
        });
        expect(await owner.submit(command, {}, "invalid-session")).toEqual({
          status: 401,
          body: { error: "authentication_refused" },
        });
        expect(await owner.submit(command, {}, "outsider-session-token")).toEqual({
          status: 403,
          body: { error: "authorization_refused" },
        });
        expect(await owner.durable()).toBe(before);
        const execution = await waitForNativeWorkflow(
          owner,
          launch.readinessInstanceId,
          "errored",
          "readiness",
        );
        expect(execution.status).toBe("errored");
        expect(execution.error?.name).toBe("Error");
        expect(
          await owner.sql("SELECT last_failure->>'code' FROM clockgrove_birth.provisioning_cases"),
        ).toBe("ProvisioningFaultInjectedError");
        expect(
          await owner.sql("SELECT count(*) FROM clockgrove.events WHERE event_type='WorldReady'"),
        ).toBe("0");
        expect(await owner.request("/provisioning/cancel", launch.envelope)).toMatchObject({
          status: 200,
        });
        await owner.replace(true);
        expect((await owner.request("/provisioning/reconcile", launch.envelope)).status).toBe(200);
        expect(
          await owner.sql(
            "SELECT status || '|' || (failure->>'code') FROM clockgrove_birth.provisioning_cases",
          ),
        ).toBe("failed|PROVISIONING_CANCELLED");
        expect(
          await owner.sql("SELECT count(*) FROM clockgrove.events WHERE event_type='WorldReady'"),
        ).toBe("0");
        expect(
          await owner.sql("SELECT count(*) FROM clockgrove.worlds WHERE lifecycle_status='ready'"),
        ).toBe("0");
      });
    },
    120_000,
  );
  it.skipIf(!isNativeWorldOwnerChild())(
    "refuses malformed native envelopes and reports terminal pack refusal separately from failed attempts",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        await owner.reset();
        const envelope = {
          version: 1,
          tenantId: owner.scope.tenantId,
          caseId: "malformed-case",
          applicationRunId: "malformed-run",
        };
        const malformed = [
          { ...envelope, version: 2 },
          { ...envelope, extra: true },
          { ...envelope, caseId: undefined },
          { ...envelope, tenantId: " tenant " },
          { ...envelope, applicationRunId: " run " },
        ];
        for (const [index, params] of malformed.entries()) {
          const id = `native-malformed-${index}`;
          expect(await owner.request("/provisioning/raw", { id, params })).toEqual({
            status: 200,
            body: { id },
          });
          expect((await waitForNativeWorkflow(owner, id, "errored")).status).toBe("errored");
          expect(
            await owner.sql(
              "SELECT (SELECT count(*) FROM clockgrove_birth.provisioning_cases), (SELECT count(*) FROM clockgrove.worlds), (SELECT count(*) FROM clockgrove.events)",
            ),
          ).toBe("0|0|0");
        }
        const accepted = provisioningRequest(owner.world, "principal-runtime", "terminal-birth");
        const request = {
          ...accepted,
          artifact: { ...accepted.artifact, contentHash: "0".repeat(64) },
        };
        const launchResponse = await owner.request("/provisioning/launch", {
          request: encodeProvisioningSource(request),
          applicationRunId: "terminal-birth",
        });
        expect(launchResponse.status).toBe(200);
        const launch = launchResponse.body as Launch;
        const execution = await waitForNativeWorkflow(owner, launch.instanceId, "complete");
        expect(execution.output).toEqual({
          version: 1,
          disposition: "refused",
          refusal: {
            code: "ARTIFACT_MISMATCH",
            path: "artifact.contentHash",
            message: "contentHash differs from the built artifact",
          },
        });
        expect(
          await owner.sql(
            "SELECT status || '|' || (failure->>'code') || '|' || (failure->>'path') FROM clockgrove_birth.provisioning_cases",
          ),
        ).toBe("failed|ARTIFACT_MISMATCH|artifact.contentHash");
        expect(await owner.sql(RELEASED)).toBe("true|true");
        expect(
          await owner.sql(
            "SELECT (SELECT count(*) FROM clockgrove.events), (SELECT count(*) FROM clockgrove.command_receipts), (SELECT count(*) FROM clockgrove.worlds)",
          ),
        ).toBe("0|0|0");
        expect((await owner.request("/provisioning/reconcile", launch.envelope)).body).toEqual({
          ...launch,
          canonical: { status: "failed", receiptCommandIds: [] },
          executionStatus: "not-needed",
        });
        await owner.reset();
        const defective = provisioningRequest(owner.world, "principal-runtime", "native-defect");
        const defectLaunch = await owner.request("/provisioning/launch", {
          request: encodeProvisioningSource(defective),
          applicationRunId: "defective-birth",
        });
        expect(defectLaunch.status).toBe(200);
        expect(
          (await waitForNativeWorkflow(owner, (defectLaunch.body as Launch).instanceId, "errored"))
            .error?.name,
        ).toBe("TypeError");
        expect(
          await owner.sql(
            "SELECT status || '|' || (failure IS NULL)::text FROM clockgrove_birth.provisioning_cases",
          ),
        ).toBe("requested|true");
        expect(
          await owner.sql(
            "SELECT (SELECT count(*) FROM clockgrove.worlds), (SELECT count(*) FROM clockgrove.events WHERE event_type='WorldReady')",
          ),
        ).toBe("0|0");
        // A deterministic defect fails its step once instead of exhausting the retry budget.
        await owner.reset();
        const deterministic = await owner.request("/provisioning/launch", {
          request: encodeProvisioningSource(
            provisioningRequest(owner.world, "principal-runtime", "native-genesis-defect"),
          ),
          applicationRunId: "deterministic-defect",
        });
        expect(deterministic.status).toBe(200);
        const defectExecution = await waitForNativeWorkflow(
          owner,
          (deterministic.body as Launch).instanceId,
          "errored",
        );
        expect(defectExecution.error?.name).toBe("WorkflowFatalError");
        expect(
          await owner.sql(
            "SELECT status || '|' || attempts || '|' || (last_failure->>'code') FROM clockgrove_birth.provisioning_cases",
          ),
        ).toBe("requested|2|WorldGenesisDefectError");
        // The scheduled reconcile leaves a defect to an operator: no restart, no new attempt.
        await owner.reconcileDispatches().catch(() => undefined);
        expect(
          await owner.sql(
            "SELECT (SELECT count(*) FROM clockgrove_birth.open_workflow_cases(25)) || '|' || attempts FROM clockgrove_birth.provisioning_cases",
          ),
        ).toBe("0|2");
      });
    },
    120_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "recovers private creation after provider launch unavailability using only scheduled reconciliation",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        await owner.reset();
        const request = provisioningRequest(owner.world, "principal-runtime", "production-birth");
        await owner.replace(false, true, true);
        expect(
          await owner.request("/provisioning/launch", {
            request: encodeProvisioningSource(request),
            applicationRunId: "production-birth-run",
          }),
        ).toEqual({ status: 409, body: { error: "TypeError" } });
        expect(
          await owner.sql(
            "SELECT case_id || '|' || workflow_run_id || '|' || status FROM clockgrove_birth.provisioning_cases",
          ),
        ).toBe("production-birth|production-birth-run|requested");
        expect(await owner.sql("SELECT count(*) FROM clockgrove.worlds")).toBe("0");
        const accepted = await owner.sql(
          "SELECT workflow_request_hash FROM clockgrove_birth.provisioning_cases",
        );
        // Restore provider availability; no repeat creation or manual reconciliation follows.
        await owner.replace(false, true);
        expect(await owner.reconcileDispatches()).toEqual({ outcome: "ok", noRetry: false });
        await waitForOwnerSql(
          owner.sql,
          "SELECT status FROM clockgrove_birth.provisioning_cases",
          "ready",
          1000,
        );
        // Literal vectors for the existing version-1 framed Workflow identity contract.
        await waitForNativeWorkflow(
          owner,
          "v1-WorldProvisioningWorkflow-24cbbb769c09385159615fa9f8be9e84a41353271d8b883d901b6d220c817d9e",
          "complete",
        );
        await waitForNativeWorkflow(
          owner,
          "v1-WorldReadinessWorkflow-ee98d1ce9a3cb4836ab417831bc550f4169f32bfed4396a3c92488173d24a3b5",
          "complete",
          "readiness",
        );
        expect(await owner.sql(COUNTS)).toBe(EXPECTED_COUNTS);
        expect(
          await owner.sql("SELECT workflow_request_hash FROM clockgrove_birth.provisioning_cases"),
        ).toBe(accepted);
      });
    },
    120_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "replaces native execution while the canonical case is open and completes the same birth",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        await owner.reset();
        const request = provisioningRequest(
          owner.world,
          "principal-runtime",
          "native-exhausted:projection-verified:before-commit",
        );
        const response = await owner.request("/provisioning/launch", {
          request: encodeProvisioningSource(request),
          applicationRunId: "replacement-birth",
        });
        expect(response.status).toBe(200);
        const launch = response.body as Launch;
        expect((await waitForNativeWorkflow(owner, launch.instanceId, "errored")).status).toBe(
          "errored",
        );
        expect(
          await owner.sql(
            "SELECT status || '|' || seeded_commands::text FROM clockgrove_birth.provisioning_cases",
          ),
        ).toBe("seeding|2");
        expect(
          await owner.sql(
            "SELECT (SELECT count(*) FROM clockgrove.events WHERE event_type='WorldReady'), (SELECT count(*) FROM clockgrove.partition_states)",
          ),
        ).toBe("0|0");
        const accepted = await owner.sql(
          "SELECT workflow_run_id || '|' || request_hash || '|' || content_hash FROM clockgrove_birth.provisioning_cases",
        );
        const openCase = await owner.sql(
          "SELECT to_jsonb(c)::text FROM clockgrove_birth.provisioning_cases c",
        );
        const openDurable = await owner.durable();
        // Open: the source bytes are stored once, exactly their own length.
        const sourceLength = Object.values(owner.world.source.resources).reduce(
          (total, bytes) => total + bytes.byteLength,
          0,
        );
        expect(
          await owner.sql(
            "SELECT octet_length(workflow_source_bytes) FROM clockgrove_birth.provisioning_cases",
          ),
        ).toBe(String(sourceLength));
        const malformedId = "native-malformed-open-case";
        expect(
          await owner.request("/provisioning/raw", {
            id: malformedId,
            params: { ...launch.envelope, version: 2 },
          }),
        ).toEqual({ status: 200, body: { id: malformedId } });
        expect((await waitForNativeWorkflow(owner, malformedId, "errored")).status).toBe("errored");
        expect(
          await owner.sql("SELECT to_jsonb(c)::text FROM clockgrove_birth.provisioning_cases c"),
        ).toBe(openCase);
        expect(await owner.durable()).toBe(openDurable);
        // A case the cron picked moves behind an untouched one.
        await owner.sql(`INSERT INTO clockgrove_birth.provisioning_cases (tenant_id, case_id, request_hash, pack_id, pack_version, content_hash, workflow_run_id, workflow_request_hash, workflow_request, workflow_source, workflow_source_bytes)
          VALUES ('${owner.scope.tenantId}', 'untouched', repeat('0', 64), 'p', 'v', repeat('0', 64), 'untouched-run', repeat('0', 64), '{}', '[]', '')`);
        const pick = "SELECT case_id FROM clockgrove_birth.open_workflow_cases(1)";
        expect([await owner.sql(pick), await owner.sql(pick)]).toEqual([
          request.caseId,
          "untouched",
        ]);
        await owner.sql(
          "DELETE FROM clockgrove_birth.provisioning_cases WHERE case_id = 'untouched'",
        );
        // Lost history: reconciliation recreates the same instance, which exhausts again.
        await owner.replace(true);
        const reconciled = await owner.request("/provisioning/reconcile", launch.envelope);
        expect(reconciled.status).toBe(200);
        expect((reconciled.body as Launch).instanceId).toBe(launch.instanceId);
        await waitForNativeWorkflow(owner, launch.instanceId, "errored");
        // Kept history, outage over: the scheduled run alone restarts the errored instance.
        await owner.replace(false, true);
        await owner.reconcileDispatches().catch(() => undefined);
        await waitForNativeWorkflow(owner, launch.instanceId, "complete");
        await waitForOwnerSql(
          owner.sql,
          "SELECT status FROM clockgrove_birth.provisioning_cases",
          "ready",
          1000,
        );
        await waitForNativeWorkflow(owner, launch.readinessInstanceId, "complete", "readiness");
        expect(await owner.sql(COUNTS)).toBe(EXPECTED_COUNTS);
        expect(
          await owner.sql(
            "SELECT workflow_run_id || '|' || request_hash || '|' || content_hash FROM clockgrove_birth.provisioning_cases",
          ),
        ).toBe(accepted);
      });
    },
    120_000,
  );
});

it("retains the six unrelated Workflow shells and the exact expanded binding membership", async () => {
  expect(runtimeBindingManifest.workflows).toEqual({
    WORLD_CATCH_UP_WORKFLOW: "WorldCatchUpWorkflow",
    WORLD_PROVISIONING_WORKFLOW: "WorldProvisioningWorkflow",
    WORLD_READINESS_WORKFLOW: "WorldReadinessWorkflow",
    WORLD_PACK_UPGRADE_WORKFLOW: "WorldPackUpgradeWorkflow",
    INGESTION_WORKFLOW: "IngestionWorkflow",
    CONSOLIDATION_WORKFLOW: "ConsolidationWorkflow",
    AUTHORING_WORKFLOW: "AuthoringWorkflow",
    AGENT_JOB_WORKFLOW: "AgentJobWorkflow",
    TRANSFER_RECOVERY_WORKFLOW: "TransferRecoveryWorkflow",
  });
  const applicationRunId = decodeOpaqueId("unchanged-shell-run", "RunId");
  for (const [name, shell] of [
    ["WorldPackUpgradeWorkflow", new workflows.WorldPackUpgradeWorkflow()],
    ["IngestionWorkflow", new workflows.IngestionWorkflow()],
    ["ConsolidationWorkflow", new workflows.ConsolidationWorkflow()],
    ["AuthoringWorkflow", new workflows.AuthoringWorkflow()],
    ["AgentJobWorkflow", new workflows.AgentJobWorkflow()],
    ["TransferRecoveryWorkflow", new workflows.TransferRecoveryWorkflow()],
  ] as const) {
    expect(await shell.run({ applicationRunId, payload: {} })).toEqual({
      instanceId: await stableWorkflowInstanceId(name, applicationRunId),
      disposition: "shell-only",
    });
  }
});
