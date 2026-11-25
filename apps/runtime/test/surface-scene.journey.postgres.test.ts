import { readFile } from "node:fs/promises";
import { executeWorldCommand } from "@clockgrove/application";
import {
  decodeFlashback,
  decodeOpaqueId,
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
import { decodeScenePresentations } from "../src/scene-presentation.js";
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
// and the text path's sentence, all from state, the same live and in a flashback of the moment.
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
      const live = await new PostgreSqlSceneStreamReader(client, presentations).read(
        attachment,
        null,
        context,
        { categories: ["public_scene"], command: false, inspect: false },
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
    });
  });
});
