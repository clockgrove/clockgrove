import { readFile } from "node:fs/promises";
import { executeWorldCommand } from "@clockgrove/application";
import {
  decodeFlashback,
  decodeObserverSceneMessage,
  decodeOpaqueId,
  decodeSceneConnectionControl,
  decodeSceneSurfaces,
  type SceneConnectionAttachment,
} from "@clockgrove/contracts";
import { PostgreSqlArtifactStore, PostgreSqlWorldCommandJournal } from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { expect, it } from "vitest";
import { REPO_ROOT } from "../../../packages/simulator/cli/repo.js";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { PostgreSqlFlashbackReader } from "../src/flashback.js";
import { PostgreSqlCausalInspector } from "../src/inspector.js";
import { PostgreSqlSceneStreamReader } from "../src/observation.js";
import type { SceneAuthorityFacts } from "../src/scene-audience.js";
import { SceneDelivery, type SceneSocket } from "../src/scene-delivery.js";
import {
  decodeScenePresentations,
  type ScenePresentationInput,
  SurfaceDecalBudgetRefusedError,
} from "../src/scene-presentation.js";
import { RuntimeWorker } from "../src/worker.js";
import { livingHallAuthentication } from "./living-hall-fixture.js";
import {
  advanceCommand,
  commandRequest,
  type DatabaseFixture,
  provisionTestWorld,
  testWorld,
  withClient,
} from "./world-fixture.js";

// Issue 267: the scene draws a zone's band through the world's per-tier treatment, its recent marks
// and the text path's sentence, all from state, the same live, in a patch to an open scene and in a
// flashback of the moment; a marker the read's scene does not project is never named, and a decal
// budget too small for the pack's marks is refused with its stable code on the socket and the
// flashback route.
it("projects a scratched zone's treatment, marks and sentence from state, the same live and replayed", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("fixture/reference");
    const provisioned = await provisionTestWorld(fixture, world, "principal-surfaces");
    const auth = livingHallAuthentication(provisioned);
    const runtime = JSON.parse(
      await readFile(`${REPO_ROOT}/worlds/fixture/reference/runtime.json`, "utf8"),
    );
    const presentations = decodeScenePresentations(JSON.stringify(runtime.presentations));
    await withClient(fixture.environment, async (client) => {
      const context = await auth.authenticator
        .identify(
          new Request("http://local.test/v1/runtime/scene", {
            method: "POST",
            headers: { authorization: "Bearer hall-inspect" },
            body: JSON.stringify({ version: 1, ...auth.scope }),
          }),
        )
        .then((identified) =>
          auth.authenticator.authorize(
            identified,
            {
              requestId: "surface-scene",
              correlationId: decodeOpaqueId("correlation-surface", "CorrelationId"),
            },
            "runtime:world-observe",
          ),
        );
      const attachment = {
        principalId: provisioned.authorization.principalId,
        acknowledgedRevision: null,
        connectionVersion: 1,
        audience: {
          ...auth.scope,
          privacyClass: "public_scene",
          interest: { selection: null, conversation: false, operator: false },
        },
      } as SceneConnectionAttachment;
      const facts: SceneAuthorityFacts = {
        categories: ["public_scene"],
        command: false,
        inspect: false,
      };
      // A scene the real delivery opened before the scratch: the scratch reaches it as a patch.
      const socketOf = () => {
        let stored: unknown = attachment;
        const sent: string[] = [];
        const closed: [number, string][] = [];
        const socket: SceneSocket = {
          deserializeAttachment: () => stored,
          serializeAttachment: (value) => {
            stored = value;
          },
          send: (message) => sent.push(message),
          close: (code, reason) => closed.push([code, reason]),
        };
        return { socket, sent, closed };
      };
      const deliveryOf = (inputs: readonly ScenePresentationInput[]) =>
        new SceneDelivery(
          async () => ({ key: "surfaces" }),
          (opened, _authority, from) =>
            new PostgreSqlSceneStreamReader(client, inputs).read(opened, from, context, facts),
          (error) => {
            throw error;
          },
        );
      const resume = {
        protocolVersion: 1,
        type: "resume",
        lastAppliedRevision: null,
        assetManifestVersion: 2,
      } as const;
      const delivery = deliveryOf(presentations);
      const open = socketOf();
      await delivery.resume(open.socket, resume);
      // A fresh resume is told a snapshot is coming, then sent it.
      const projections = () =>
        open.sent
          .map((wire) => JSON.parse(wire))
          .filter((message) => message.lane === "projection")
          .map(decodeObserverSceneMessage);
      const opened = projections()[0]!;
      if (opened.type !== "snapshot") throw new Error("expected the opening snapshot");
      expect(
        opened.payload.surfaces?.zones.find((zone) => zone.zoneId === "cedar-bark")?.sentence,
      ).toBeNull();

      const scratch = {
        ...advanceCommand(world, "surface-scratch", 0n, world.birth.state.revision),
        type: "surface.interact",
        attribution: { effectiveActorId: "fixture.keeper", causalRootActionId: "action-scratch" },
        payload: {
          schemaVersion: 1,
          actorId: "fixture.keeper",
          zoneId: "cedar-bark",
          interactionId: "scratch",
          intensity: 10000,
          point: { u: 3000, v: 7000 },
        },
      } as unknown as ReturnType<typeof advanceCommand>;
      expect(
        (
          await executeWorldCommand(commandRequest(provisioned, scratch), {
            journal: new PostgreSqlWorldCommandJournal(client),
            behavior: provisioned.behavior,
          })
        ).outcome,
      ).toBe("committed");

      const live = await new PostgreSqlSceneStreamReader(client, presentations).read(
        attachment,
        null,
        context,
        facts,
      );
      const at = world.birth.state.simulationTime;
      const tiers = (low: number, medium: number, high: number) => ({
        low: { tint: "#c9a27a", opacity: low, marks: false },
        medium: { tint: "#c9a27a", opacity: medium, marks: true },
        high: { tint: "#c9a27a", opacity: high, marks: true },
      });
      const surfaces = live.projection.surfaces;
      expect(surfaces?.decals).toEqual({ low: 0, medium: 12, high: 24 });
      expect(surfaces?.zones.find((zone) => zone.zoneId === "cedar-bark")).toEqual({
        zoneId: "cedar-bark",
        label: "The cedar's bark",
        host: { kind: "object", objectId: "fixture.cedar" },
        channels: [
          { channel: "wear", value: 300, max: 1000, bands: ["scratched"] },
          { channel: "scent", value: 400, max: 1000, bands: ["marked"] },
        ],
        treatments: [{ channel: "wear", band: "scratched", tiers: tiers(0.35, 0.45, 0.5) }],
        marks: [{ actorId: "fixture.keeper", at, intensity: 10000, point: { u: 3000, v: 7000 } }],
        sentence: "The cedar's bark is scratched; most recently by Keeper, a resident.",
      });
      // The garden bed starts muddy, unmarked; the clean porch and path draw nothing.
      expect(
        surfaces?.zones
          .filter((zone) => zone.zoneId !== "cedar-bark")
          .map(({ zoneId, host, sentence }) => [zoneId, host.kind, sentence]),
      ).toEqual([
        ["fence-path", "region", null],
        ["porch-boards", "region", null],
        ["garden-bed", "region", "The garden bed is muddy."],
      ]);

      // A flashback of the scratch replays the moment from the journal and draws the same surfaces.
      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("a flashback cannot route a command");
        },
        flashback: new PostgreSqlFlashbackReader(client, new PostgreSqlCausalInspector(client), {
          artifacts: new PostgreSqlArtifactStore(client),
          decodeResource,
          presentations,
        }),
      });
      const response = await worker.fetch(
        new Request("http://local.test/v1/runtime/flashback", {
          method: "POST",
          headers: { authorization: "Bearer hall-inspect", "content-type": "application/json" },
          body: JSON.stringify({ version: 1, ...auth.scope, commandId: "surface-scratch" }),
        }),
      );
      expect(response.status).toBe(200);
      const flashback = decodeFlashback(await response.json());
      const moment = flashback.frames.find((frame) => frame.moment);
      expect(moment?.projection.surfaces).toEqual(surfaces);

      // The open scene receives the scratch as a patch whose `set_surfaces` is the snapshot's.
      await delivery.publish(open.socket);
      const patched = projections()[1]!;
      if (patched.type !== "patch") throw new Error("expected a patch");
      expect(patched.payload.fromRevision).toBe(opened.payload.revision);
      expect(patched.payload.toRevision).toBe(live.projection.revision);
      expect(patched.payload.operations.filter((op) => op.op === "set_surfaces")).toEqual([
        { op: "set_surfaces", surfaces },
      ]);

      // A marker the scene does not project is never named there: a visitor belonging to another
      // space, standing in the neighborhood's garden, digs the bed; the neighborhood's scene, read
      // through the real reader for this audience, shows the dig with no actor id and no "by" clause.
      const commit = async (command: ReturnType<typeof advanceCommand>) => {
        const result = await executeWorldCommand(commandRequest(provisioned, command), {
          journal: new PostgreSqlWorldCommandJournal(client),
          behavior: provisioned.behavior,
        });
        expect(result.outcome).toBe("committed");
      };
      const readScene = () =>
        new PostgreSqlSceneStreamReader(client, presentations).read(
          attachment,
          null,
          context,
          facts,
        );
      const head = async () => (await readScene()).projection.revision;
      await commit({
        ...advanceCommand(world, "surface-visitor", 0n, await head()),
        type: "object.create",
        payload: {
          schemaVersion: 1,
          object: {
            objectId: "fixture.visitor",
            archetypeId: "fixture.resident-kind@1",
            spatial: {
              spaceId: "fixture.zz-household-store",
              pose: { frameId: "frame-grove", frameVersion: 1, coordinates: [22000n, 8000n] },
            },
          },
        },
      } as unknown as ReturnType<typeof advanceCommand>);
      await commit({
        ...advanceCommand(world, "surface-dig", 0n, await head()),
        type: "surface.interact",
        attribution: { effectiveActorId: "fixture.visitor", causalRootActionId: "action-dig" },
        payload: {
          schemaVersion: 1,
          actorId: "fixture.visitor",
          zoneId: "garden-bed",
          interactionId: "dig",
          intensity: 10000,
          point: { u: 5000, v: 5000 },
        },
      } as unknown as ReturnType<typeof advanceCommand>);
      const after = await readScene();
      expect(after.projection.entities.map((entity) => entity.objectId)).not.toContain(
        "fixture.visitor",
      );
      const garden = after.projection.surfaces?.zones.find((zone) => zone.zoneId === "garden-bed");
      expect(garden?.marks).toEqual([
        { actorId: null, at, intensity: 10000, point: { u: 5000, v: 5000 } },
      ]);
      expect(garden?.sentence).toBe("The garden bed is muddy, has a shallow hole dug in it.");
      // The keeper, projected, is still named on the bark it scratched.
      expect(
        after.projection.surfaces?.zones.find((zone) => zone.zoneId === "cedar-bark")?.sentence,
      ).toBe("The cedar's bark is scratched; most recently by Keeper, a resident.");
      // The decoder refuses a scene that names an actor it does not project.
      const cedar = decodeOpaqueId("fixture.cedar", "ObjectId");
      expect(() =>
        decodeSceneSurfaces(
          {
            decals: surfaces?.decals,
            zones: [
              { ...garden, marks: [{ ...garden?.marks[0], actorId: "fixture.visitor", at: "0" }] },
            ],
          },
          "surfaces",
          new Set([cedar]),
        ),
      ).toThrow("entity is not projected");

      // A runtime presentation too small for the pack's marks is refused with its code on the
      // scene socket and the flashback route, never as an anonymous internal error.
      const [entry] = runtime.presentations;
      const small = decodeScenePresentations(
        JSON.stringify([
          {
            ...entry,
            presentation: {
              ...entry.presentation,
              surfaces: {
                ...entry.presentation.surfaces,
                decals: { ...entry.presentation.surfaces.decals, medium: 10 },
              },
            },
          },
        ]),
      );
      const refused = socketOf();
      await expect(deliveryOf(small).resume(refused.socket, resume)).rejects.toBeInstanceOf(
        SurfaceDecalBudgetRefusedError,
      );
      expect(refused.sent.map((wire) => decodeSceneConnectionControl(JSON.parse(wire)))).toEqual([
        { protocolVersion: 1, type: "disconnect", reason: "surface_decal_budget_exceeded" },
      ]);
      expect(refused.closed).toEqual([[1011, "surface_decal_budget_exceeded"]]);
      const smallWorker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("a flashback cannot route a command");
        },
        flashback: new PostgreSqlFlashbackReader(client, new PostgreSqlCausalInspector(client), {
          artifacts: new PostgreSqlArtifactStore(client),
          decodeResource,
          presentations: small,
        }),
      });
      const refusedFlashback = await smallWorker.fetch(
        new Request("http://local.test/v1/runtime/flashback", {
          method: "POST",
          headers: { authorization: "Bearer hall-inspect", "content-type": "application/json" },
          body: JSON.stringify({ version: 1, ...auth.scope, commandId: "surface-scratch" }),
        }),
      );
      expect(refusedFlashback.status).toBe(500);
      expect(await refusedFlashback.json()).toMatchObject({
        error: "surface_decal_budget_exceeded",
      });
    });
  });
});
