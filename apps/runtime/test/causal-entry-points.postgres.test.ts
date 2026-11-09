import {
  type CausalEventView,
  type CausalScheduleView,
  decodeCanonicalNode,
  executeWorldCommand,
} from "@clockgrove/application";
import {
  decodeClientViewTrace,
  decodeEntitySelection,
  decodeRecordedWhy,
} from "@clockgrove/contracts";
import { PostgreSqlWorldCommandJournal, PostgreSqlWorldOwnerReader } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { PostgreSqlCausalInspector } from "../src/inspector.js";
import {
  PostgreSqlEntitySelectionReader,
  PostgreSqlLivingSceneReader,
  PostgreSqlSceneStreamReader,
} from "../src/observation.js";
import { sceneAuthorityFacts } from "../src/scene-audience.js";
import { PostgreSqlClientViewInspector } from "../src/view-trace.js";
import { RuntimeWorker } from "../src/worker.js";
import { livingHallAuthentication } from "./living-hall-fixture.js";
import {
  advanceCommand,
  commandRequest,
  type DatabaseFixture,
  provisionTestWorld,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

// issue 819: event, scheduled-action and client-view entries, through HTTP, against PostgreSQL rows.
it("traverses from an event, a scheduled action and the viewer's own view, labelled and audited", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-entry-points");
    const auth = livingHallAuthentication(provisioned);
    const sql = truthOf(fixture);
    const rows = async (query: string): Promise<string[][]> =>
      JSON.parse(
        (await sql(`SELECT coalesce(jsonb_agg(r.a), '[]')::text FROM (${query}) r(a)`)) || "[]",
      );
    await withClient(fixture.environment, async (client) => {
      const observer = new PostgreSqlLivingSceneReader(new PostgreSqlWorldOwnerReader(client));
      const selected = new PostgreSqlEntitySelectionReader(client);
      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("inspection cannot route a command");
        },
        inspector: new PostgreSqlCausalInspector(client),
        viewTrace: new PostgreSqlClientViewInspector(client),
        observation: {
          observe: (scope, context) => observer.observe(scope, context),
          select: (input, context) => selected.select(input, context, 100n),
        },
      });
      const post = async (endpoint: string, fields: object) => {
        const response = await worker.fetch(
          new Request(`http://local.test/v1/runtime/${endpoint}`, {
            method: "POST",
            headers: { authorization: "Bearer hall-inspect", "content-type": "application/json" },
            body: JSON.stringify({ ...fields, ...auth.scope }),
          }),
        );
        return [response.status, await response.json()] as const;
      };
      const step = world.behavior.policy.decisionIntervalMs;
      for (const [key, through] of [
        ["entry-first", world.birth.state.simulationTime + step],
        ["entry-second", world.birth.state.simulationTime + 2n * step],
      ] as const)
        expect(
          (
            await executeWorldCommand(
              commandRequest(provisioned, advanceCommand(world, key, through, null)),
              {
                journal: new PostgreSqlWorldCommandJournal(client),
                behavior: provisioned.behavior,
              },
            )
          ).outcome,
        ).toBe("committed");
      const eventsOf = async (commandId: string) =>
        (
          await rows(
            `SELECT event_id FROM clockgrove.events WHERE command_id = '${commandId}' ORDER BY partition_sequence`,
          )
        ).flat();
      const firstEvents = await eventsOf("entry-first");
      const eventId = firstEvents[0]!;
      const [[scheduleId, idempotencyKey, dueAt, trigger]] = (await rows(
        `SELECT jsonb_build_array(schedule_id, idempotency_key, due_at::text, scheduled_by_command_id) FROM clockgrove.partition_schedules WHERE completed_by_command_id = 'entry-first' ORDER BY due_at, schedule_id LIMIT 1`,
      )) as unknown as [[string, string, string, string]];
      const linked = async (column: string, other: string) =>
        Promise.all(
          (
            await rows(
              `SELECT DISTINCT ${column} FROM clockgrove.partition_schedules WHERE ${other} = 'entry-first' AND ${column} <> 'entry-first' AND ${column} IS NOT NULL ORDER BY 1`,
            )
          )
            .flat()
            .map(async (commandId) => ({ commandId, eventIds: await eventsOf(commandId) })),
        );
      const byCommand = (list: readonly { commandId: string }[]) =>
        [...list].sort((a, b) => a.commandId.localeCompare(b.commandId));
      const revision = await sql(
        "SELECT result->'value'->>'revision' FROM clockgrove.command_receipts WHERE command_id = 'entry-first'",
      );

      // Before the inspect grant: refused with the stable code and audited.
      expect(await post("causal-chain", { schemaVersion: 1, eventId })).toEqual([
        403,
        { error: "authorization_refused" },
      ]);
      auth.grant("runtime:world-inspect");

      const [eventStatus, eventBody] = await post("causal-chain", { schemaVersion: 1, eventId });
      expect(eventStatus).toBe(200);
      const event = decodeCanonicalNode(eventBody as never) as unknown as CausalEventView;
      const { command } = event;
      expect([event.entry, event.evidence, event.event.eventId]).toEqual([
        "event",
        {
          event: "canonical",
          command: "canonical",
          parentEvents: "derived",
          childEvents: "derived",
          projections: "canonical",
        },
        eventId,
      ]);
      expect([command.receipt.commandId, command.evidence]).toEqual([
        "entry-first",
        {
          receipt: "canonical",
          decision: "canonical",
          events: "canonical",
          decisionTraces: "canonical",
          schedules: "canonical",
          dispatches: "operational",
          projection: "canonical",
          replay: "derived",
          links: "derived",
        },
      ]);
      expect(command.events.map((e) => e.eventId)).toEqual(firstEvents);
      expect(byCommand(event.parentEvents)).toEqual(
        await linked("scheduled_by_command_id", "completed_by_command_id"),
      );
      const children = await linked("completed_by_command_id", "scheduled_by_command_id");
      expect(children.map((child) => child.commandId)).toContain("entry-second");
      expect(byCommand(event.childEvents)).toEqual(children);
      expect(event.projections.map((p) => p.revision)).toEqual([revision]);

      const [scheduleStatus, scheduleBody] = await post("causal-chain", {
        schemaVersion: 1,
        scheduleId,
        idempotencyKey,
      });
      expect(scheduleStatus).toBe(200);
      const schedule = decodeCanonicalNode(scheduleBody as never) as unknown as CausalScheduleView;
      expect([
        schedule.entry,
        schedule.evidence,
        schedule.schedule.dueAt.toString(),
        schedule.trigger.receipt.commandId,
        schedule.completion?.receipt.commandId,
        schedule.completion?.events.map((e) => e.eventId),
      ]).toEqual([
        "scheduled-action",
        { schedule: "canonical", trigger: "canonical", completion: "canonical" },
        dueAt,
        trigger,
        "entry-first",
        firstEvents,
      ]);

      // The browser's public Why from the same entries: the event's and the row's consuming command.
      for (const entry of [{ eventId }, { scheduleId, idempotencyKey }]) {
        const [status, body] = await post("why", { version: 1, ...entry });
        expect(status).toBe(200);
        const why = decodeRecordedWhy(body);
        expect([why.commandId, why.entry, why.evidence, why.traces.status]).toEqual([
          "entry-first",
          "eventId" in entry ? { kind: "event", eventId } : { kind: "scheduled-action", ...entry },
          { receipt: "canonical", traces: "canonical", schedules: "canonical", links: "derived" },
          "available",
        ]);
        expect(why.schedules).toContainEqual({
          scheduleId,
          idempotencyKey,
          kind: expect.any(String),
          dueAt,
          status: "done",
          scheduledBy: trigger,
          completedBy: "entry-first",
        });
      }

      // The viewer's own view: the decided audience is the one its scene frames carry.
      const interest = { selection: null, conversation: false, operator: false };
      const [viewStatus, viewBody] = await post("view-trace", { version: 1, interest });
      expect(viewStatus).toBe(200);
      const view = decodeClientViewTrace(viewBody);
      const identified = await auth.authenticator.identify(
        new Request("http://local.test/", {
          method: "POST",
          headers: { authorization: "Bearer hall-inspect" },
          body: JSON.stringify({ version: 1, ...auth.scope }),
        }),
      );
      const context = await auth.authenticator.authorize(
        { ...identified, commandId: "view-trace-frame" },
        undefined,
        "runtime:world-observe",
      );
      const frame = await new PostgreSqlSceneStreamReader(client).read(
        {
          principalId: context.principalId,
          audience: { ...auth.scope, privacyClass: "public_scene", interest },
          acknowledgedRevision: null,
          connectionVersion: 1,
        },
        null,
        context,
        sceneAuthorityFacts(context.grants, context.privacyCeiling),
      );
      expect([
        view.evidence,
        view.audience.privacyCategories,
        view.audience.hash,
        view.projection.revision,
        view.audience.reasons.map((reason) => [reason.viewer, reason.outcome]),
      ]).toEqual([
        { audience: "transient", projection: "canonical" },
        ["public_scene", "private_cognition"],
        frame.projection.audienceHash,
        await sql("SELECT revision::text FROM clockgrove.partition_states"),
        [
          ["conversation", "excluded"],
          ["operator", "excluded"],
          ["selection", "excluded"],
          ["space", "included"],
        ],
      ]);

      // issue 740's earned values are labelled derived on the selected-object view.
      const [, selection] = await post("entity", { version: 1, objectId: "fixture.keeper" });
      expect(decodeEntitySelection(selection).evidence).toEqual({
        entity: "canonical",
        physical: "canonical",
        derived: "derived",
        history: "canonical",
      });

      expect(await post("causal-chain", { schemaVersion: 1, eventId: "unknown" })).toEqual([
        404,
        { error: "event_not_found" },
      ]);
      expect(
        await post("causal-chain", { schemaVersion: 1, scheduleId, idempotencyKey: "unknown" }),
      ).toEqual([404, { error: "schedule_not_found" }]);
      // An identity whose JSON encoding exceeds `entry_id`'s 2100 octets is undecodable: no row.
      expect(
        await post("causal-chain", {
          schemaVersion: 1,
          scheduleId: '"'.repeat(1024),
          idempotencyKey: '"'.repeat(1024),
        }),
      ).toEqual([400, { error: "invalid_inspection_request" }]);
      // A ceiling without the schedule rows' class refuses the entry with the stable code, audited.
      auth.withoutPublicScene();
      auth.grant("runtime:world-inspect");
      expect(await post("causal-chain", { schemaVersion: 1, scheduleId, idempotencyKey })).toEqual([
        403,
        { error: "authorization_refused" },
      ]);
      // One row per entry access; the Why's link checks are causal-chain rows of their own.
      const scheduled = JSON.stringify([scheduleId, idempotencyKey]);
      expect(
        await rows(
          "SELECT jsonb_build_array(subject, entry_id, decision, reason_code) FROM clockgrove.inspector_accesses WHERE subject <> 'causal-chain' ORDER BY access_id",
        ),
      ).toEqual([
        ["event", eventId, "deny", "runtime-grant-missing"],
        ["event", eventId, "allow", "served"],
        ["scheduled-action", scheduled, "allow", "served"],
        ["event", eventId, "allow", "served"],
        ["scheduled-action", scheduled, "allow", "served"],
        ["client-view", null, "allow", "served"],
        ["event", "unknown", "allow", "not-found"],
        ["scheduled-action", JSON.stringify([scheduleId, "unknown"]), "allow", "not-found"],
        ["scheduled-action", scheduled, "deny", "authority-mismatch"],
      ]);
    });
  });
}, 120_000);
