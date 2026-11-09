import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  advanceCommand,
  provisionTestWorld,
  truthOf,
} from "../../../apps/runtime/test/world-fixture.ts";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../../../apps/runtime/test/world-owner/native-harness.ts";
import {
  encodeSceneConnectionControl,
  SCENE_CREDENTIAL_PREFIX,
  SCENE_PROTOCOL,
} from "../../../packages/contracts/src/index.ts";

const FILE = "tests/load/realtime/fanout.journey.browser.test.mjs";
/**
 * Decision: 16 observers with the per-principal maximum of 4 sockets each
 * (SCENE_SOCKET_BOUNDS.perPrincipal) is 64 sockets, a quarter of one space's 256
 * (SCENE_SOCKET_BOUNDS.perSpace), small enough for CI's 2-core runner and large enough that a
 * per-socket metric point would show as 64 points.
 */
const PRINCIPALS = 16;
const PER_PRINCIPAL = 4;
const SOCKETS = PRINCIPALS * PER_PRINCIPAL;

const sum = (points) => points.reduce((total, point) => total + point.value, 0);

// issue 814 (Wave 4 §15.1 test:realtime:load, §17): one committed change fans out to every scene socket
// of a space, and the server's scene measurements agree with what the sockets themselves received.
it("fans one committed change out to every scene socket and measures it per turn", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      vitestConfig: "tests/ci/vitest.browser.config.ts",
      timeoutMs: 150_000,
      inheritOutput: true,
      prepare: (fixture) =>
        truthOf(fixture)(
          `INSERT INTO clockgrove_auth."user" (id,name,email,"emailVerified","createdAt","updatedAt")
            SELECT 'load-subject-'||n,'Load '||n,'load'||n||'@example.test',true,now(),now() FROM generate_series(1,${PRINCIPALS}) n;
          INSERT INTO clockgrove_auth.session (id,token,"userId","expiresAt","createdAt","updatedAt")
            SELECT 'load-session-'||n,'load-token-'||n,'load-subject-'||n,now()+interval '1 hour',now(),now() FROM generate_series(1,${PRINCIPALS}) n;
          INSERT INTO clockgrove_management.principals SELECT 'principal-load-'||n, NULL FROM generate_series(1,${PRINCIPALS}) n;
          INSERT INTO clockgrove_management.identity_links
            SELECT 'local','load-subject-'||n,'identity-load-'||n,'principal-load-'||n,NULL FROM generate_series(1,${PRINCIPALS}) n;
          INSERT INTO clockgrove.tenant_principals (tenant_id,principal_id)
            SELECT DISTINCT tenant_id,'principal-load-'||n FROM clockgrove.world_memberships, generate_series(1,${PRINCIPALS}) n;
          INSERT INTO clockgrove.world_memberships
            (tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
            SELECT tenant_id,world_id,timeline_id,space_id,'principal-load-'||n,'membership-load-'||n,'persona-load-'||n,roles,
            ARRAY['runtime:world-observe'],privacy_ceiling,committed_at
            FROM clockgrove.world_memberships, generate_series(1,${PRINCIPALS}) n WHERE principal_id='principal-runtime';
          UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe','runtime:world-command'] WHERE principal_id='principal-runtime';
          UPDATE clockgrove_auth.session SET token='hall-inspect' WHERE token='local-reader-session'`,
        ),
    });
    return;
  }
  await withNativeWorldOwner(async (native) => {
    const { fixture, world } = native;
    const provisioned = await provisionTestWorld(fixture, world, "principal-runtime");
    const scope = { ...provisioned.partition.target, spaceId: provisioned.partition.route.spaceId };
    const revision = async () =>
      truthOf(fixture)(
        `SELECT revision FROM clockgrove.partition_states WHERE partition_id = '${provisioned.partition.route.partitionId}'`,
      );
    const drain = async () =>
      ((await native.request("/owner-metrics", { scope })).body ?? []).filter(({ name }) =>
        name.startsWith("scene_"),
      );
    const of = (points, name, label) =>
      points.filter((point) => point.name === name && point.label === label);
    const url = new URL("/v1/projection", (await native.origin()).replace(/^http/u, "ws"));
    for (const key of ["tenantId", "worldId", "timelineId", "spaceId"])
      url.searchParams.set(key, scope[key]);
    await drain();

    // Each socket resumes from nothing, then acknowledges every frame it applies, as the web does.
    const sockets = [];
    for (let n = 1; n <= PRINCIPALS; n += 1)
      for (let k = 0; k < PER_PRINCIPAL; k += 1) {
        const socket = new WebSocket(url, [
          SCENE_PROTOCOL,
          `${SCENE_CREDENTIAL_PREFIX}load-token-${n}`,
        ]);
        const frames = [];
        socket.addEventListener("open", () =>
          socket.send(
            encodeSceneConnectionControl({
              protocolVersion: 1,
              type: "resume",
              lastAppliedRevision: null,
              assetManifestVersion: 1,
            }),
          ),
        );
        socket.addEventListener("message", ({ data }) => {
          const message = JSON.parse(data);
          if (message.type !== "snapshot" && message.type !== "patch") return;
          frames.push({
            type: message.type,
            revision: message.projectionRevision,
            bytes: data.length,
            at: performance.now(),
          });
          socket.send(
            encodeSceneConnectionControl({
              protocolVersion: 1,
              type: "ack",
              revision: BigInt(message.projectionRevision),
              connectionVersion: 1,
            }),
          );
        });
        sockets.push({ socket, frames });
        // Sockets join one at a time: each upgrade's authentication holds its own PostgreSQL
        // connection, and the harness allows 16 (native-harness.ts), so a burst would be refused.
        await expect.poll(() => frames.length).toBeGreaterThan(0);
      }
    try {
      const joined = await revision();
      await expect
        .poll(
          () => sockets.filter(({ frames }) => frames.some((f) => f.revision === joined)).length,
        )
        .toBe(SOCKETS);
      const admitted = await drain();
      expect([
        sum(of(admitted, "scene_admissions", "admitted")),
        of(admitted, "scene_handshake_ms", "snapshot").length,
        sum(of(admitted, "scene_audience_decisions", "public_scene")),
        sum(of(admitted, "scene_patch_bytes", "snapshot")),
      ]).toEqual([
        SOCKETS,
        SOCKETS,
        SOCKETS,
        sockets.reduce((total, { frames }) => total + frames[0].bytes, 0),
      ]);

      const committedAt = performance.now();
      const { status, body } = await native.submit(
        {
          ...advanceCommand(world, "load-rain", 0n, BigInt(joined)),
          type: "world.weather.set",
          payload: { schemaVersion: 2, rainIntensity: 7000 },
        },
        {},
        "hall-inspect",
      );
      expect(status, JSON.stringify(body)).toBe(200);
      const changed = await revision();
      await expect
        .poll(() => sockets.filter(({ frames }) => frames.at(-1)?.revision === changed).length)
        .toBe(SOCKETS);
      const patches = sockets.map(({ frames }) => frames.at(-1));
      expect(new Set(patches.map(({ type }) => type))).toEqual(new Set(["patch"]));
      // Every acknowledgement of the change is in before the turn's points are read.
      const fanout = [];
      await expect
        .poll(async () => {
          fanout.push(...(await drain()));
          return of(fanout, "scene_revision", "acknowledged").filter(
            ({ value }) => value === Number(changed),
          ).length;
        })
        .toBe(SOCKETS);
      expect([
        sum(of(fanout, "scene_fanout_recipients", "projection")),
        sum(of(fanout, "scene_patch_bytes", "patch")),
        of(fanout, "scene_patch_bytes", "patch").reduce((total, point) => total + point.count, 0),
        Math.max(...of(fanout, "scene_revision", "current").map(({ value }) => value)),
      ]).toEqual([
        SOCKETS,
        patches.reduce((total, { bytes }) => total + bytes, 0),
        SOCKETS,
        Number(changed),
      ]);
      // Opaque IDs and categories only: no principal, credential, payload or text reaches a point.
      for (const point of [...admitted, ...fanout]) {
        expect(Object.keys(point).sort()).toEqual(
          [
            "label",
            "name",
            "tenantId",
            "value",
            "worldId",
            ...("count" in point ? ["count"] : []),
          ].sort(),
        );
        expect([point.tenantId, point.worldId]).toEqual([scope.tenantId, scope.worldId]);
      }
      const evidence = process.env.CLOCKGROVE_WAVE4_EVIDENCE;
      if (evidence)
        await writeFile(
          path.join(evidence, "realtime-load.json"),
          `${JSON.stringify(
            {
              sockets: SOCKETS,
              principals: PRINCIPALS,
              fanoutTurnPoints: of(fanout, "scene_fanout_recipients", "projection").length,
              patchBytes: patches.reduce((total, { bytes }) => total + bytes, 0),
              lastPatchAfterCommitMs: Math.max(...patches.map(({ at }) => at)) - committedAt,
            },
            null,
            2,
          )}\n`,
        );
    } finally {
      for (const { socket } of sockets) socket.close();
    }
  });
}, 180_000);
