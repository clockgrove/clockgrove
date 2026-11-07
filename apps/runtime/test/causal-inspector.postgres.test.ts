import {
  advanceDueWork,
  createPartitionSnapshot,
  encodeCanonicalNode,
  executeWorldCommand,
  inspectCommand,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  type WorldKernel,
} from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import { executeWorldKernel } from "@clockgrove/kernel";
import {
  PostgreSqlArtifactStore,
  PostgreSqlDueWorkReader,
  PostgreSqlJournalRangeSource,
  PostgreSqlPersistenceTransactionPort,
  PostgreSqlSnapshotStore,
  PostgreSqlWorldCommandJournal,
  PostgreSqlWorldProvisioningStore,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
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
  kernelModel,
  provisionTestWorld,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

describe("causal inspector", () => {
  it("walks a command's chain, verifies its projection by replay and hides it by tenant and privacy ceiling", async () => {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      await applyMigrations(fixture.tools, fixture.environment);
      const world = await testWorld();
      const provisioned = await provisionTestWorld(fixture, world, "principal-inspector");
      const { authorization, partition } = provisioned;
      const first = kernelModel(world).schedules[0]!.dueAt;
      // One runtime connection; every call installs its own principal.
      await withClient(fixture.environment, async (client) => {
        const original: Extract<ReturnType<typeof executeWorldKernel>, { ok: true }>["result"][] =
          [];
        const kernel: WorldKernel = (input) => {
          const output = executeWorldKernel(input);
          if (output.ok) original.push(output.result);
          return output;
        };
        const ports = {
          journal: new PostgreSqlWorldCommandJournal(client),
          behavior: provisioned.behavior,
          dueWork: new PostgreSqlDueWorkReader(client),
          kernel,
        };
        const replay = {
          birth: new PostgreSqlWorldProvisioningStore(client),
          decodeResource,
          snapshots: new PostgreSqlSnapshotStore(client),
          artifacts: new PostgreSqlArtifactStore(client),
        };
        const inspect = (commandId: string, principal = authorization, verify = false) =>
          inspectCommand(
            principal,
            decodeOpaqueId(commandId, "CommandId"),
            {
              transactions: new PostgreSqlPersistenceTransactionPort(client),
              events: (reader) =>
                new JournalRangeReader(
                  new PostgreSqlJournalRangeSource(client, reader),
                  JOURNAL_EVENT_REGISTRY,
                ),
            },
            verify ? { verifyProjection: replay } : {},
          );
        const walk = async (from: string, edge: "parents" | "children") => {
          const seen = new Set([from]);
          for (const next of seen) for (const id of (await inspect(next)).links[edge]) seen.add(id);
          return [...seen];
        };

        // Client command A schedules work; the due-work advance B consumes it in 1-input chunks C.
        const request = commandRequest(
          provisioned,
          advanceCommand(world, "command-a", first + 60_000n, null),
        );
        ports.journal = new PostgreSqlWorldCommandJournal(client, undefined, {
          failureStage: "before-commit",
        });
        await expect(executeWorldCommand(request, ports)).rejects.toMatchObject({
          code: "P0001",
        });
        expect(await commandCounts(truthOf(fixture), "command-a")).toBe("0|0|0");
        const lost = new Error("test response loss");
        ports.journal = new PostgreSqlWorldCommandJournal(client, undefined, {
          afterCommit: async () => {
            throw lost;
          },
        });
        await expect(executeWorldCommand(request, ports)).rejects.toBe(lost);
        expect(original[0]?.decisionDrafts).toEqual(original[1]?.decisionDrafts);
        ports.journal = new PostgreSqlWorldCommandJournal(client);
        const callsBeforeRetry = original.length;
        await executeWorldCommand(request, ports);
        await executeWorldCommand(request, ports);
        expect(original.length).toBe(callsBeforeRetry);
        const scope = { ...partition.target, partitionId: partition.route.partitionId };
        const { snapshotId } = await createPartitionSnapshot(authorization, scope, replay);
        const budget = { maxInputs: 1, maxEvents: 256 };
        const advanced = await advanceDueWork(
          { ...partition, through: first + 600_000n, budget },
          ports,
        );
        const [b, ...chunks] = advanced.commands.map((command) => command.commandId);
        // A client command that declares B as its correlation and cause is not B's chunk.
        const forge = advanceCommand(world, "command-forge", first + 600_000n, null);
        const correlationId = decodeOpaqueId(b!, "CorrelationId");
        await executeWorldCommand(
          commandRequest(provisioned, {
            ...forge,
            context: { ...forge.context, correlationId },
            attribution: { ...forge.attribution, immediateCauseId: b! },
          }),
          ports,
        );
        const truth = truthOf(fixture);
        const eventIds = await truth(
          `SELECT array_to_string(canonical_event_ids, ',') FROM clockgrove.command_receipts WHERE command_id = 'command-a'`,
        );

        const a = await inspect("command-a");
        expect(original[1]?.decisionDrafts.length).toBe(2);
        expect(a.decisionTraces).toEqual({
          status: "available",
          drafts: encodeCanonicalNode(
            original[1]?.decisionDrafts.filter((draft) => draft.kind === "routine"),
          ),
        });
        expect(chunks.length).toBe(8);
        for (const [index, command] of advanced.commands.entries()) {
          expect((await inspect(command.commandId)).decisionTraces).toEqual({
            status: "available",
            drafts: encodeCanonicalNode(
              original[index + 2]?.decisionDrafts.filter((draft) => draft.kind === "routine"),
            ),
          });
        }
        expect(a).toMatchObject({
          receipt: { status: "committed" },
          decision: { outcome: "allow", authorityDecisionId: a.receipt.authorityDecisionId },
          dispatches: [{ eventId: a.events[0]!.eventId, channel: "world-reactions" }],
          links: { children: expect.arrayContaining([b]) },
        });
        expect(a.events.map((event) => event.eventId).join(",")).toBe(eventIds);
        expect(a.schedules).toContainEqual(
          expect.objectContaining({ scheduledBy: "command-a", completedBy: b }),
        );
        expect((await inspect(b!)).links).toEqual({
          parents: ["command-a"],
          children: expect.arrayContaining(chunks),
        });
        expect((await inspect(b!)).links.children).not.toContain("command-forge");
        expect(await walk("command-a", "children")).toEqual(expect.arrayContaining([b, ...chunks]));
        expect(await walk(chunks[0]!, "parents")).toEqual(expect.arrayContaining([b, "command-a"]));

        // Another tenant's command and an unknown ID are the same refusal.
        const foreign = { ...authorization, tenantId: decodeOpaqueId("tenant-b", "TenantId") };
        for (const [commandId, principal] of [
          ["command-a", foreign],
          ["command-unknown", authorization],
        ] as const) {
          await expect(inspect(commandId, principal)).rejects.toMatchObject({
            name: "InspectedCommandNotFoundError",
            message: "command not found",
          });
        }

        // Without public_scene: exactly the receipt (no result, no event IDs) and the decision.
        const privacyCeiling = decodePrivacyCeiling({
          version: 1,
          allowedCategories: ["private_cognition"],
        });
        const hidden = await inspect("command-a", { ...authorization, privacyCeiling });
        const { result: _result, ...receipt } = a.receipt;
        expect(hidden).toEqual({
          evidence: a.evidence,
          receipt,
          decision: a.decision,
          events: [],
          schedules: [],
          dispatches: [],
          links: { parents: [], children: [] },
        });
        const hiddenB = await inspect(b!, { ...authorization, privacyCeiling });
        expect(hiddenB.links).toEqual({ parents: [], children: [] });
        expect(await inspect("command-a")).toEqual(a);

        // The projection link: replay from the snapshot after A to the command's last event only.
        const link = async (commandId: string) =>
          (await inspect(commandId, authorization, true)).projection!;
        const [linkA, linkB] = [await link("command-a"), await link(b!)];
        for (const { stateHash, replay: replayed } of [linkA, linkB]) {
          expect(replayed).toMatchObject({ stateHash, start: snapshotId, verified: true });
        }
        expect([linkA.replay!.eventsApplied, linkB.replay!.eventsApplied > 0]).toEqual([0, true]);
        expect(linkB.stateHash).not.toBe(
          (await replay.snapshots.readCommitted(authorization, scope))!.stored.stateHash,
        );

        // A forged recorded hash is reported; a corrupt snapshot fails with its integrity error.
        const forged = "0".repeat(64);
        await truth(
          `SET session_replication_role = replica;
           UPDATE clockgrove.command_receipts SET result = jsonb_set(result, '{value,stateHash}', '"${forged}"')
            WHERE command_id = 'command-a'`,
        );
        expect(await link("command-a")).toMatchObject({
          stateHash: forged,
          replay: { stateHash: linkA.stateHash, verified: false },
        });
        await truth(`UPDATE clockgrove.snapshots SET state_hash = '${forged}'`);
        await expect(link(b!)).rejects.toMatchObject({
          name: "SnapshotIntegrityError",
          reason: "row-mismatch",
        });
      });
    });
  }, 120_000);
});
