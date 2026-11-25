import { resolve } from "node:path";
import { executeWorldCommand } from "@clockgrove/application";
import {
  type CommandEnvelope,
  decodeFlashback,
  decodeFlashbackMarks,
  decodeOpaqueId,
  type FlashbackMarks,
} from "@clockgrove/contracts";
import { PostgreSqlArtifactStore, PostgreSqlWorldCommandJournal } from "@clockgrove/persistence";
import { decodeResource, encodeResource } from "@clockgrove/world-pack-sdk";
import { expect, it } from "vitest";
import { readPackDirectory, sdkSource } from "../../../packages/simulator/cli/pack-source.js";
import { REPO_ROOT } from "../../../packages/simulator/cli/repo.js";
import { sha256Hex } from "../../../packages/simulator/test/fixtures/lamp-hall.js";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { PostgreSqlFlashbackReader } from "../src/flashback.js";
import { PostgreSqlFlashbackMarksReader } from "../src/flashback-marks.js";
import { PostgreSqlCausalInspector } from "../src/inspector.js";
import { RuntimeWorker } from "../src/worker.js";
import { seedProvisioningBirth } from "../src/workflows.js";
import { livingHallAuthentication } from "./living-hall-fixture.js";
import {
  advanceCommand,
  commandRequest,
  type DatabaseFixture,
  type PackSource,
  packArtifact,
  packWorld,
  provisionTestWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

const HOUR = 3_600_000n;
const surfaces = {
  schemaVersion: 1,
  budgets: { zones: 4, marksPerZone: 4 },
  channels: [
    {
      id: "wear",
      max: 100,
      carried: false,
      bands: [
        { name: "fresh", min: 0, max: 9 },
        { name: "scuffed", min: 10, max: 59 },
        { name: "scarred", min: 60, max: 100 },
      ],
      recovery: { driver: "time", amount: 10, periodMs: HOUR },
    },
  ],
  zones: [
    {
      id: "cedar-bark",
      host: { kind: "object", objectId: "fixture.cedar" },
      channels: [{ channel: "wear", initial: 0 }],
      markCapacity: 4,
    },
    {
      id: "den-floor",
      host: { kind: "region", regionId: "den" },
      channels: [{ channel: "wear", initial: 0 }],
      markCapacity: 0,
      traffic: "tread",
    },
    // Hosted by an object in the household store, a space this observer's scene does not hold.
    {
      id: "pantry-shelf",
      host: { kind: "object", objectId: "fixture.household-food" },
      channels: [{ channel: "wear", initial: 0 }],
      markCapacity: 0,
    },
  ],
  interactions: [
    { id: "scratch", effects: [{ channel: "wear", kind: "add", amount: 30 }], leavesMark: true },
    { id: "tread", effects: [{ channel: "wear", kind: "add", amount: 5 }], leavesMark: false },
  ],
};

/** The reference pack with a surfaces policy added to its behavior policy resource. */
async function surfaceWorld() {
  const base = sdkSource(
    await readPackDirectory(resolve(REPO_ROOT, "worlds", "fixture/reference")),
  );
  const path = "policies/behavior.json";
  const behavior = decodeResource(base.resources[path]!, path) as { policy: object };
  const bytes = encodeResource({ ...behavior, policy: { ...behavior.policy, surfaces } });
  const manifest = structuredClone(base.manifest) as {
    policies: { path: string; sha256: string }[];
  };
  manifest.policies.find((item) => item.path === path)!.sha256 = await sha256Hex(bytes);
  const source: PackSource = { ...base, manifest, resources: { ...base.resources, [path]: bytes } };
  // The surfaces change the seeded projection: pin the hash the seeding itself reports.
  const { artifact } = await packArtifact(source);
  const seeded = await seedProvisioningBirth(artifact, source);
  const actual = !seeded.ok && /actual ([0-9a-f]{64})/.exec(seeded.refusal.message)?.[1];
  if (actual)
    (manifest as { expectedSeedProjectionHash?: string }).expectedSeedProjectionHash = actual;
  const packed = await packWorld(source);
  if (packed.behavior === null) throw new Error("the reference pack has a behavior policy");
  return { ...packed, behavior: packed.behavior };
}

it("lists the journaled moments of a surface's zones newest first, bounded, read-only, and plays one as a flashback", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await surfaceWorld();
    const provisioned = await provisionTestWorld(fixture, world, "principal-marks");
    const auth = livingHallAuthentication(provisioned);
    const truth = truthOf(fixture);
    const { entities } = world.birth.state;
    const cedar = entities.find((entity) => entity.objectId === "fixture.cedar")!;
    const actors = entities
      .filter((entity) => entity.needs !== undefined && entity.spaceId === cedar.spaceId)
      .map((entity) => entity.objectId);
    expect(actors.length).toBeGreaterThan(0);
    await withClient(fixture.environment, async (client) => {
      const journal = new PostgreSqlWorldCommandJournal(client);
      const step = world.behavior.policy.decisionIntervalMs;
      const run = async (command: CommandEnvelope<string, unknown>) =>
        expect(
          (
            await executeWorldCommand(commandRequest(provisioned, command), {
              journal,
              behavior: provisioned.behavior,
            })
          ).outcome,
        ).toBe("committed");
      const scratcher = new Map<string, string>();
      const { tenantId, worldId, timelineId } = world.birth.world;
      // Eighteen scratches, a day apart every sixth, so wear recovers and crosses its bands.
      for (let n = 1; n <= 18; n += 1) {
        const actorId = actors[n % actors.length]!;
        scratcher.set(`scratch-${n}`, actorId);
        await run({
          schemaVersion: 1,
          commandId: decodeOpaqueId(`scratch-${n}`, "CommandId"),
          type: "surface.interact",
          target: { version: 1, tenantId, worldId, timelineId, kind: "world", id: worldId },
          expected: {
            partitionRevision: BigInt(
              await truth("SELECT revision FROM clockgrove.partition_states"),
            ),
          },
          issuedAt: world.birth.clock.wallEpoch,
          context: {
            version: 1,
            correlationId: `correlation-scratch-${n}`,
            requestId: `scratch-${n}`,
          },
          attribution: { effectiveActorId: actorId, causalRootActionId: `action-scratch-${n}` },
          payload: {
            schemaVersion: 1,
            actorId,
            zoneId: "cedar-bark",
            interactionId: "scratch",
            intensity: 10000,
            point: { u: 5000, v: 5000 },
          },
        } as unknown as CommandEnvelope<string, unknown>);
        if (n % 6 === 0)
          await run(
            advanceCommand(
              world,
              `advance-${n}`,
              world.birth.state.simulationTime + step * BigInt(n / 6),
              null,
            ),
          );
      }

      // Keeper walks into the den, wearing its floor, and the floor is swept.
      const now = world.birth.state.simulationTime + step * 3n;
      const command = async (key: string, type: string, payload: object) =>
        run({
          ...advanceCommand(
            world,
            key,
            0n,
            BigInt(await truth("SELECT revision FROM clockgrove.partition_states")),
          ),
          type,
          payload,
        } as CommandEnvelope<string, unknown>);
      await command("walk-den", "movement.start", {
        schemaVersion: 1,
        objectId: "fixture.keeper",
        destination: {
          kind: "pose",
          pose: { frameId: "frame-grove", frameVersion: 1, coordinates: [8000n, 22000n] },
        },
        unitsPerSecond: 1000n,
      });
      await run(advanceCommand(world, "walked-den", now + 60_000n, null));
      await command("sweep-den", "surface.repair", {
        schemaVersion: 1,
        zoneId: "den-floor",
        reason: "sweep",
      });

      const artifacts = new PostgreSqlArtifactStore(client);
      const flashbackReader = new PostgreSqlFlashbackReader(
        client,
        new PostgreSqlCausalInspector(client),
        {
          artifacts,
          decodeResource,
        },
      );
      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("a marks read cannot route a command");
        },
        flashback: flashbackReader,
        observation: {
          observe: () => {
            throw new Error("no scene");
          },
          marks: (request, context) =>
            new PostgreSqlFlashbackMarksReader(client).read(request, context),
        },
      });
      const post = (path: string, fields: object) =>
        worker.fetch(
          new Request(`http://local.test/v1/runtime/${path}`, {
            method: "POST",
            headers: { authorization: "Bearer hall-inspect", "content-type": "application/json" },
            body: JSON.stringify({ version: 1, ...auth.scope, ...fields }),
          }),
        );
      const marks = async (fields: object): Promise<FlashbackMarks> => {
        const response = await post("flashback/marks", fields);
        expect(response.status).toBe(200);
        return decodeFlashbackMarks(await response.json());
      };
      const canonical =
        "SELECT jsonb_build_object('state',(SELECT jsonb_agg(to_jsonb(s) ORDER BY partition_id) FROM clockgrove.partition_states s),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM clockgrove.command_receipts r),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM clockgrove.events e),'schedules',(SELECT jsonb_agg(to_jsonb(q) ORDER BY schedule_id,idempotency_key) FROM clockgrove.partition_schedules q),'snapshots',(SELECT jsonb_agg(to_jsonb(n) ORDER BY snapshot_id) FROM clockgrove.snapshots n))::text";
      const before = await truth(canonical);

      // The journal's own rows for the zone, newest first.
      const rows = (
        await truth(
          "SELECT string_agg(event_id || ',' || event_type || ',' || command_id, ';' ORDER BY partition_sequence DESC) FROM clockgrove.events WHERE event_type LIKE 'surface.%' AND payload::text LIKE '%\"cedar-bark\"%'",
        )
      )
        .split(";")
        .map((row) => row.split(","));
      const kinds = {
        "surface.interacted": "interacted",
        "surface.band-crossed": "band-crossed",
        "surface.repaired": "repaired",
      } as const;
      const expected = rows.map(([eventId, type, commandId]) => ({
        eventId,
        kind: kinds[type as keyof typeof kinds],
        actorId: type === "surface.interacted" ? scratcher.get(commandId!)! : null,
        leftMark: type === "surface.interacted",
      }));
      expect(expected.filter((moment) => moment.kind === "interacted")).toHaveLength(18);
      expect(expected.some((moment) => moment.kind === "band-crossed")).toBe(true);

      const read = await marks({ objectId: "fixture.cedar" });
      expect(read).toMatchObject({
        status: "read",
        reachesStart: true,
        target: { objectId: "fixture.cedar" },
        scanned: {
          from: "1",
          to: await truth("SELECT max(partition_sequence) FROM clockgrove.events"),
        },
      });
      expect(read.zones).toHaveLength(1);
      const [zone] = read.zones;
      expect(zone).toMatchObject({
        zoneId: "cedar-bark",
        host: { kind: "object", objectId: "fixture.cedar" },
        marks: 4,
        more: expected.length - 16,
      });
      expect(
        zone!.moments.map(({ eventId, kind, actorId, leftMark }) => ({
          eventId,
          kind,
          actorId,
          leftMark,
        })),
      ).toEqual(expected.slice(0, 16));
      expect(
        zone!.moments
          .filter((moment) => moment.kind === "interacted")
          .every((moment) => moment.interactionId === "scratch"),
      ).toBe(true);

      // A region host is listed with its traffic (worn) and its repair, from the journaled payloads.
      const keeperEntered = (
        await truth(
          "SELECT string_agg(event_id, ',' ORDER BY partition_sequence DESC) FROM clockgrove.events WHERE event_type = 'movement.region-entered' AND payload::text LIKE '%\"den-floor\"%' AND payload::text LIKE '%\"fixture.keeper\"%'",
        )
      ).split(",");
      expect(keeperEntered).toHaveLength(1);
      const swept = await truth(
        "SELECT event_id FROM clockgrove.events WHERE event_type = 'surface.repaired' AND command_id = 'sweep-den'",
      );
      const den = await marks({ regionId: "den" });
      expect(den.zones.map(({ zoneId, host, marks: count }) => [zoneId, host, count])).toEqual([
        ["den-floor", { kind: "region", regionId: "den" }, 0],
      ]);
      const denMoments = den.zones[0]!.moments;
      expect(denMoments[0]).toMatchObject({
        eventId: swept,
        commandId: "sweep-den",
        kind: "repaired",
        actorId: null,
        interactionId: null,
        leftMark: false,
      });
      expect(denMoments.filter((moment) => moment.eventId === keeperEntered[0])).toEqual([
        expect.objectContaining({
          kind: "worn",
          actorId: "fixture.keeper",
          interactionId: "tread",
          leftMark: false,
        }),
      ]);
      expect(denMoments.filter((moment) => moment.kind === "worn").length).toBeGreaterThan(0);
      expect(
        denMoments.every(
          (moment, index) =>
            index === 0 ||
            BigInt(denMoments[index - 1]!.partitionSequence) > BigInt(moment.partitionSequence),
        ),
      ).toBe(true);
      // An object-hosted zone whose host is outside the observed space lists nothing, by object or zone.
      for (const target of [{ objectId: "fixture.household-food" }, { zoneId: "pantry-shelf" }])
        expect(await marks(target)).toMatchObject({ zones: [], scanned: null, reachesStart: true });
      // An unknown or zoneless object lists nothing.
      expect((await marks({ zoneId: "cedar-bark" })).zones.map((item) => item.zoneId)).toEqual([
        "cedar-bark",
      ]);
      for (const target of [
        { objectId: "fixture.herb" },
        { objectId: "no-such-object" },
        { zoneId: "no-such-zone" },
      ])
        expect(await marks(target)).toMatchObject({ zones: [], scanned: null, reachesStart: true });
      expect((await post("flashback/marks", { objectId: "a", zoneId: "b" })).status).toBe(400);

      // A listed moment plays as a flashback of the scratching actor.
      const newest = zone!.moments.find((moment) => moment.kind === "interacted")!;
      const response = await post("flashback", { eventId: newest.eventId });
      expect(response.status).toBe(200);
      const flashback = decodeFlashback(await response.json());
      expect(flashback.moment.objectId).toBe(newest.actorId);
      const label = flashback.context!.present.find(
        (item) => item.objectId === newest.actorId,
      )!.label;
      expect(flashback.summary[0]).toEqual({
        kind: "context",
        text: `${label} scratch on cedar-bark, leaving a mark.`,
        cites: [`event:${newest.eventId}`],
      });

      expect(await truth(canonical)).toBe(before);
      // An event in the scanned range above the observer's ceiling leaves a gap: no moment is listed.
      await truth(
        `UPDATE clockgrove.events SET privacy_class = 'private_cognition' WHERE event_id = '${newest.eventId}'`,
      );
      expect(await marks({ objectId: "fixture.cedar" })).toMatchObject({
        status: "not-visible",
        zones: [{ zoneId: "cedar-bark", marks: 4, moments: [], more: 0 }],
      });
      auth.revoke();
      const refused = await post("flashback/marks", { objectId: "fixture.cedar" });
      expect([refused.status, await refused.json()]).toEqual([
        403,
        { error: "authorization_refused" },
      ]);
    });
  });
}, 300_000);
