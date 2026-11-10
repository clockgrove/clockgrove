import { advanceDueWork, decodeCanonicalNode, executeWorldCommand } from "@clockgrove/application";
import {
  PostgreSqlDueWorkReader,
  PostgreSqlRuntimeStateReader,
  PostgreSqlWorldCommandJournal,
  PostgreSqlWorldOwnerReader,
} from "@clockgrove/persistence";
import { expect, it, vi } from "vitest";
import type { Json } from "../../../packages/simulator/test/fixtures/lamp-hall.js";
import { buildSectionHallSource } from "../../../packages/simulator/test/fixtures/section-hall.js";
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
  packWorld,
  provisionTestWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

it("recovers declared process deadlines from PostgreSQL without actors and ahead of actor decisions", async () => {
  for (const actorless of [true, false]) {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      await applyMigrations(fixture.tools, fixture.environment);
      const source = await buildSectionHallSource({
        edit: ({ docs, manifest }) => {
          const policy = (docs["policies/behavior.json"] as Json).policy;
          policy.ecology.sources = [];
          policy.ecology.perishables = [];
          delete policy.lifecycle;
          delete policy.utility;
          delete policy.wellbeing;
          (docs["traits/needs.json"] as Json).components["clockgrove.needs"].state.hunger = 0;
          (docs["archetypes/crate.json"] as Json).components["clockgrove.resource"].state = {
            kind: "water",
            quantity: 0,
          };
          policy.processes = [
            {
              id: "household",
              principalId: "household-principal",
              firstAtMs: 100001n,
              periodMs: 1000n,
              command: {
                type: "resource.transfer",
                payload: {
                  schemaVersion: 1,
                  fromObjectId: "sec.pond",
                  toObjectId: "sec.crate",
                  kind: "water",
                  quantity: 3,
                },
              },
            },
          ];
          for (const id of ["parent", "child"]) {
            if (actorless) {
              manifest.actors = manifest.actors.filter((entry: Json) => entry.id !== `sec.${id}`);
              delete docs[`actors/${id}.json`];
            } else delete (docs[`actors/${id}.json`] as Json).lifecycle;
          }
          manifest.cognitiveSeeds = [];
          for (const name of ["first", "second", "other"]) delete docs[`cognition/${name}.json`];
        },
      });
      const packed = await packWorld(source);
      if (packed.behavior === null) throw new Error("behavior required");
      const world = { ...packed, behavior: packed.behavior };
      const provisioned = await provisionTestWorld(fixture, world, "principal-process-wake");
      const { authorization, partition } = provisioned;
      const scope = { ...partition.target, ...partition.route };
      const deadline = () =>
        withClient(fixture.environment, async (client) => {
          const due = await new PostgreSqlDueWorkReader(client).pendingWork(authorization, scope);
          const owner = await new PostgreSqlWorldOwnerReader(client).clockOwner(scope);
          expect(owner?.nextDueAt).toBe(due?.nextDueAt);
          const runtime = await new PostgreSqlRuntimeStateReader(client).read(authorization, scope);
          expect(runtime.clock.nextDeadline).toBe(due?.nextDueAt);
          return due?.nextDueAt;
        });
      const advance = (through: bigint) =>
        withClient(fixture.environment, (client) =>
          advanceDueWork(
            { ...partition, through },
            {
              behavior: provisioned.behavior,
              journal: new PostgreSqlWorldCommandJournal(client),
              dueWork: new PostgreSqlDueWorkReader(client),
            },
          ),
        );
      const hydrated = () =>
        withClient(fixture.environment, (client) =>
          new PostgreSqlWorldOwnerReader(client).hydrate(authorization, scope),
        );
      expect(world.birth.schedules.length === 0).toBe(actorless);
      expect(await deadline()).toBe(actorless ? 100001n : 100000n);
      expect((await advance(100000n)).status).toBe(actorless ? "idle" : "advanced");
      expect(await deadline()).toBe(100001n);
      await withClient(fixture.environment, (client) =>
        executeWorldCommand(
          {
            ...commandRequest(provisioned, {
              ...advanceCommand(world, "process-resume", 100000n, null),
              type: "ResumeWorld",
              payload: { schemaVersion: 1 },
            }),
            trustedWallTime: () => 0n,
          },
          { journal: new PostgreSqlWorldCommandJournal(client), behavior: provisioned.behavior },
        ),
      );
      const first = await withClient(fixture.environment, async (client) => {
        const owner = new PostgreSqlCommandOwner(client);
        const now = vi.spyOn(Date, "now").mockReturnValue(1000);
        try {
          expect(await owner.clockAlarmPlan(scope, 0n)).toEqual({
            policyVersion: 1n,
            nextAlarmAt: 1001,
          });
        } finally {
          now.mockRestore();
        }
        return owner.advanceClock(scope, 1n, {
          activationId: "process-first",
          policyVersion: 1n,
          admit: true,
        });
      });
      expect(first.commands).toHaveLength(1);
      expect(first.commands[0]?.outcome).toBe("committed");
      const events = first.commands
        .flatMap((command) => command.events)
        .map((event) => decodeCanonicalNode((event.payload as Json).kernelEvent) as Json);
      expect(
        events
          .filter((event) => event.type === "process.command-attempted")
          .map((event) => [
            event.simulationTime,
            (event.payload as Json).refusal,
            event.attribution.principalId,
            event.attribution.effectiveActorId,
          ]),
      ).toEqual([[100001n, null, "household-principal", "process:household"]]);
      expect(events.filter((event) => event.type === "resource.transferred")).toHaveLength(1);
      expect(await deadline()).toBe(101001n);
      const recovered = await hydrated();
      expect(recovered.document.state.processes).toEqual([
        { processId: "household", nextAt: 101001n },
      ]);
      const quantities = () =>
        hydrated().then((owner) =>
          owner.document.state.entities
            .filter((entity) => entity.objectId === "sec.pond" || entity.objectId === "sec.crate")
            .map((entity) => [entity.objectId, entity.resource?.quantity]),
        );
      expect(await quantities()).toEqual([
        ["sec.crate", 3],
        ["sec.pond", 2],
      ]);
      const refused = await advance(101001n);
      expect(refused.status).toBe("advanced");
      const refusedEvents = refused.commands
        .flatMap((command) => command.events)
        .map((event) => decodeCanonicalNode((event.payload as Json).kernelEvent) as Json);
      expect(refusedEvents.filter((event) => event.type === "resource.transferred")).toEqual([]);
      expect(
        refusedEvents
          .filter((event) => event.type === "process.command-attempted")
          .map((event) => [event.simulationTime, (event.payload as Json).refusal]),
      ).toEqual([
        [
          101001n,
          {
            code: "precondition-failed",
            path: "payload.quantity",
            check: "resource.available-and-bounded@1",
          },
        ],
      ]);
      expect(await quantities()).toEqual([
        ["sec.crate", 3],
        ["sec.pond", 2],
      ]);
      expect(await deadline()).toBe(102001n);
      const sql = truthOf(fixture);
      const before = await sql("SELECT count(*) FROM clockgrove.events");
      expect((await advance(101001n)).status).toBe("idle");
      expect(await sql("SELECT count(*) FROM clockgrove.events")).toBe(before);
    });
  }
});
