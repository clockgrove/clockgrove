import { createHash } from "node:crypto";
import {
  decodeObserverSceneMessage,
  decodeOpaqueId,
  decodeOperatorSceneMessage,
  decodeSceneConnectionAttachment,
  encodeSceneConnectionControl,
  SCENE_CREDENTIAL_PREFIX,
  SCENE_PROTOCOL,
  type ScenePatchOperation,
  type SceneRecoveryReason,
} from "@clockgrove/contracts";
import { canonicalBytes } from "@clockgrove/kernel";
import type { HydratedWorldOwner } from "@clockgrove/persistence";
import { describe, expect, it } from "vitest";
import { advanceCommand, truthOf } from "./world-fixture.js";
import {
  inspectNativeWorldOwner,
  isNativeWorldOwnerChild,
  type NativeSocket,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

/** One ordered inbox observes control notices and RW-0401 envelopes on the real socket. */
function inbox(socket: NativeSocket) {
  const frames: string[] = [];
  let pending: ((wire: string) => void) | undefined;
  socket.addEventListener("message", ({ data }) => {
    if (typeof data !== "string") throw new Error("expected text scene frame");
    if (pending === undefined) frames.push(data);
    else {
      const resolve = pending;
      pending = undefined;
      resolve(data);
    }
  });
  const next = () => {
    const wire = frames.shift();
    if (wire !== undefined) return Promise.resolve(wire);
    return new Promise<string>((resolve) => {
      pending = resolve;
    });
  };
  const recovery = async (reason: SceneRecoveryReason) => {
    expect(await next()).toBe(JSON.stringify({ protocolVersion: 1, type: "recovery", reason }));
  };
  return {
    frames,
    next,
    recovery,
    closed: () =>
      new Promise<{ code: number | undefined; reason: string | undefined }>((resolve) => {
        socket.addEventListener("close", ({ code, reason }) => resolve({ code, reason }), {
          once: true,
        });
      }),
    snapshot: async () => {
      await recovery("snapshot_required");
      const message = decodeObserverSceneMessage(JSON.parse(await next()));
      expect(message.type).toBe("snapshot");
      if (message.type !== "snapshot") throw new Error("expected snapshot");
      return message;
    },
  };
}

/** Independent oracle: raw PostgreSQL state, not either production projection builder. */
function expectedOperations(canonical: HydratedWorldOwner): ScenePatchOperation[] {
  const state = canonical.document.state;
  return [
    ...state.spatialFrames.map((frame): ScenePatchOperation => {
      const { parentTransform, ...base } = frame;
      return {
        op: "upsert_frame",
        frame: {
          ...base,
          origin: frame.origin.map(String),
          gravity: { ...frame.gravity, vector: frame.gravity.vector.map(String) },
          ...(parentTransform === undefined
            ? {}
            : {
                parentTransform: {
                  ...parentTransform,
                  translation: parentTransform.translation.map(String),
                  basis: parentTransform.basis.map((row) => row.map(String)),
                },
              }),
        },
      };
    }),
    ...state.entities
      .filter((entity) => entity.spaceId === canonical.spaceId)
      .map(
        (entity): ScenePatchOperation => ({
          op: "upsert_entity",
          entity: {
            objectId: entity.objectId,
            archetypeId: entity.archetypeId,
            pose: {
              frameId: entity.pose.frameId,
              frameVersion: entity.pose.frameVersion,
              coordinates: entity.pose.coordinates.map(String),
            },
            presentation: { kind: "placeholder", label: entity.objectId },
          },
        }),
      ),
    { op: "upsert_space", space: { spaceId: canonical.spaceId, label: canonical.spaceId } },
    // The fixture's one declared region nests under the space it is projected in.
    {
      op: "upsert_space",
      space: {
        spaceId: decodeOpaqueId("hall", "SpaceId"),
        label: "hall",
        parentSpaceId: canonical.spaceId,
      },
    },
    // The server's interaction policy for this observer: command grant, no conversation.
    {
      op: "upsert_interaction",
      interaction: {
        entityId: decodeOpaqueId("beacon.cistern", "ObjectId"),
        mode: "reactive",
        actions: [
          { kind: "inspect", availability: "enabled" },
          { kind: "history", availability: "enabled" },
          { kind: "influence", availability: "enabled" },
        ],
      },
    },
    {
      op: "upsert_interaction",
      interaction: {
        entityId: decodeOpaqueId("beacon.lamp", "ObjectId"),
        mode: "inspectable",
        actions: [
          { kind: "inspect", availability: "enabled" },
          { kind: "history", availability: "enabled" },
        ],
      },
    },
    {
      op: "upsert_interaction",
      interaction: {
        entityId: decodeOpaqueId("beacon.larder", "ObjectId"),
        mode: "reactive",
        actions: [
          { kind: "inspect", availability: "enabled" },
          { kind: "history", availability: "enabled" },
          { kind: "influence", availability: "enabled" },
        ],
      },
    },
    {
      op: "upsert_interaction",
      interaction: {
        entityId: decodeOpaqueId("beacon.master", "ObjectId"),
        mode: "reactive",
        actions: [
          { kind: "inspect", availability: "enabled" },
          { kind: "history", availability: "enabled" },
          { kind: "why", availability: "enabled" },
          { kind: "talk", availability: "disabled", reason: "conversation_not_permitted" },
        ],
      },
    },
    { op: "set_clock", simulationTime: state.simulationTime },
    { op: "set_weather", weather: state.weather },
    { op: "set_feed_cursor", feedCursor: canonical.coveredHeadSequence.toString() },
    {
      op: "set_compatibility",
      compatibility: { projectionVersion: 1, assetManifestVersion: 1, clientVersion: 1 },
    },
  ];
}

describe("native recoverable bounded scene delivery", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns PostgreSQL and the native socket process",
    async () => {
      await runNativeWorldOwnerProcess(
        "apps/runtime/test/scene-delivery.postgres.test.ts",
        "fixture",
        {
          prepare: async (fixture) => {
            await truthOf(fixture)(
              "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe')",
            );
          },
        },
      );
    },
    180_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "recovers from Journal and fences acknowledgement, pressure and audience changes",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const query = new URLSearchParams(owner.scope);
        const route = `/v1/projection?${query}`;
        const carrier = {
          "sec-websocket-protocol": `${SCENE_PROTOCOL}, ${SCENE_CREDENTIAL_PREFIX}local-reader-session`,
        };
        const attachments = async () => {
          const rows: unknown = await (await owner.upgrade(`/scene/attachments?${query}`)).json();
          if (!Array.isArray(rows)) throw new Error("expected native attachment list");
          return rows
            .map((row: unknown) => decodeSceneConnectionAttachment(row))
            .sort((left, right) =>
              String(left.acknowledgedRevision).localeCompare(String(right.acknowledgedRevision)),
            )
            .map(({ acknowledgedAudienceHash: _audience, ...attachment }) => ({
              ...attachment,
              acknowledgedRevision: attachment.acknowledgedRevision?.toString() ?? null,
            }));
        };
        const revision = async () =>
          BigInt(await owner.sql("SELECT revision::text FROM clockgrove.partition_states"));
        const time = async () =>
          BigInt(await owner.sql("SELECT simulation_time::text FROM clockgrove.partition_states"));
        const commit = async (id: string) => {
          expect(
            (await owner.submit(advanceCommand(owner.world, id, (await time()) + 120_000n, null)))
              .status,
          ).toBe(200);
        };
        const connect = async () => {
          const upgraded = await owner.upgrade(route, carrier);
          expect(upgraded.status).toBe(101);
          const socket = upgraded.webSocket;
          if (socket === null) throw new Error("native scene socket missing");
          const received = inbox(socket);
          socket.accept();
          return { socket, received };
        };
        const originalGrants = await owner.sql(
          "SELECT grants::text FROM clockgrove.world_memberships",
        );
        // Observation and the command grant the cards' Influence needs: restoring the original
        // grants below then changes no audience.
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe','runtime:world-command']",
        );
        let first = await connect();
        const other = await connect();
        const expectedAudience = createHash("sha256")
          .update(
            canonicalBytes({
              scope: owner.scope,
              privacyCategories: ["public_scene"],
              interest: { selection: null, conversation: false, operator: false },
              actions: { talk: false, influence: true },
            }),
          )
          .digest("hex");
        const base = await revision();
        const baseHead = BigInt(
          await owner.sql("SELECT covered_head_sequence::text FROM clockgrove.partition_states"),
        );
        const resume = (socket: NativeSocket, lastAppliedRevision: bigint | null) =>
          socket.send(
            encodeSceneConnectionControl({
              protocolVersion: 1,
              type: "resume",
              lastAppliedRevision,
              assetManifestVersion: 1,
            }),
          );
        const ack = (socket: NativeSocket, at: bigint, connectionVersion: number) =>
          socket.send(
            encodeSceneConnectionControl({
              protocolVersion: 1,
              type: "ack",
              revision: at,
              connectionVersion,
            }),
          );
        first.socket.send(
          JSON.stringify({
            protocolVersion: 1,
            type: "resume",
            lastAppliedRevision: null,
            assetManifestVersion: 2,
          }),
        );
        await first.received.recovery("asset_manifest_changed");
        resume(first.socket, null);
        const snapshot = await first.received.snapshot();
        expect([snapshot.lane, snapshot.type, snapshot.projectionRevision]).toEqual([
          "projection",
          "snapshot",
          base,
        ]);
        expect(snapshot.payload.audienceHash).toBe(expectedAudience);
        expect(snapshot.payload.compatibility).toEqual({
          projectionVersion: 1,
          assetManifestVersion: 1,
          clientVersion: 1,
        });
        expect([
          snapshot.payload.privacyClass,
          snapshot.payload.revision,
          snapshot.payload.simulationTime,
        ]).toEqual(["public_scene", base, await time()]);
        const initialAttachment = {
          principalId: "principal-runtime",
          audience: {
            ...owner.scope,
            privacyClass: "public_scene",
            interest: { selection: null, conversation: false, operator: false },
          },
          acknowledgedRevision: null,
          connectionVersion: 1,
        };
        expect(await attachments()).toEqual([
          initialAttachment,
          { ...initialAttachment, connectionVersion: 1 },
        ]);
        ack(first.socket, base + 1n, 1);
        await first.received.recovery("revision_unavailable");
        expect(await attachments()).toEqual([
          initialAttachment,
          { ...initialAttachment, connectionVersion: 1 },
        ]);
        ack(first.socket, base, 1);
        const acknowledged = { ...initialAttachment, acknowledgedRevision: base.toString() };
        await expect
          .poll(attachments)
          .toEqual([acknowledged, { ...initialAttachment, connectionVersion: 1 }]);
        ack(first.socket, base, 1);
        ack(first.socket, base, 0);
        await first.received.recovery("revision_unavailable");
        await first.received.recovery("revision_unavailable");
        expect(await attachments()).toEqual([
          acknowledged,
          { ...initialAttachment, connectionVersion: 1 },
        ]);

        await owner.sql(`UPDATE clockgrove.world_memberships SET grants='${originalGrants}'`);
        await commit("scene-committed");
        const head = await revision();
        const patch = decodeObserverSceneMessage(JSON.parse(await first.received.next()));
        expect([
          patch.protocolVersion,
          patch.lane,
          patch.type,
          patch.projectionRevision,
          patch.worldId,
          patch.timelineId,
          patch.spaceId,
        ]).toEqual([
          1,
          "projection",
          "patch",
          head,
          owner.scope.worldId,
          owner.scope.timelineId,
          owner.scope.spaceId,
        ]);
        if (patch.type !== "patch") throw new Error("expected committed patch");
        expect([
          patch.payload.fromRevision,
          patch.payload.toRevision,
          patch.payload.audienceHash,
        ]).toEqual([base, head, snapshot.payload.audienceHash]);
        const canonical = (await inspectNativeWorldOwner(owner)).partition;
        const operations = expectedOperations(canonical);
        const expectedPatch = {
          fromRevision: base,
          toRevision: head,
          audienceHash: expectedAudience,
          operations,
          sourceEventIds: (
            await owner.sql(
              `SELECT event_id FROM clockgrove.events WHERE partition_sequence > ${baseHead} AND partition_sequence <= ${canonical.coveredHeadSequence} ORDER BY partition_sequence`,
            )
          ).split("\n"),
        };
        expect(
          patch.payload,
          await owner.sql(
            "SELECT event_type || ':' || privacy_class || ':' || count(*) FROM clockgrove.events WHERE command_id='scene-committed' GROUP BY event_type,privacy_class ORDER BY event_type",
          ),
        ).toEqual(expectedPatch);
        expect(other.received.frames).toEqual([]);
        other.socket.close(1000, "metadata and resume independence checked");
        await expect.poll(attachments).toEqual([acknowledged]);
        const beforeReject = await owner.sql(
          "SELECT revision::text || '|' || state_hash FROM clockgrove.partition_states",
        );
        const rejected = await owner.submit(
          advanceCommand(owner.world, "scene-rejected", (await time()) + 120_000n, head + 1n),
        );
        expect(rejected.status).toBe(409);
        expect(
          await owner.sql(
            "SELECT revision::text || '|' || state_hash FROM clockgrove.partition_states",
          ),
        ).toBe(beforeReject);
        expect(first.received.frames).toEqual([]);
        await owner.sql(
          "CREATE FUNCTION clockgrove.scene_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='scene rollback'; END $$; CREATE TRIGGER scene_rollback BEFORE UPDATE ON clockgrove.partition_states FOR EACH ROW EXECUTE FUNCTION clockgrove.scene_rollback()",
        );
        try {
          expect(
            (
              await owner.submit(
                advanceCommand(owner.world, "scene-rollback", (await time()) + 120_000n, null),
              )
            ).status,
          ).toBe(500);
          expect(
            await owner.sql(
              "SELECT revision::text || '|' || state_hash FROM clockgrove.partition_states",
            ),
          ).toBe(beforeReject);
          expect(
            await owner.sql(
              "SELECT count(*) FROM clockgrove.events WHERE command_id='scene-rollback'",
            ),
          ).toBe("0");
          expect(first.received.frames).toEqual([]);
        } finally {
          await owner.sql(
            "DROP TRIGGER scene_rollback ON clockgrove.partition_states; DROP FUNCTION clockgrove.scene_rollback()",
          );
        }

        // An explicit new intent advances the connection version before owner replacement.
        resume(first.socket, base);
        const rejoined = decodeObserverSceneMessage(JSON.parse(await first.received.next()));
        expect(rejoined.payload).toEqual(expectedPatch);
        expect(await attachments()).toEqual([{ ...acknowledged, connectionVersion: 2 }]);
        // This drops the production stream service, retaining only workerd socket attachments.
        expect(await owner.request(`/scene/reset?${query}`, null)).toEqual({
          status: 200,
          body: { reset: true },
        });
        resume(first.socket, base);
        const recovered = decodeObserverSceneMessage(JSON.parse(await first.received.next()));
        expect(recovered.type).toBe("patch");
        expect(recovered.payload).toEqual(expectedPatch);
        expect(await attachments()).toEqual([{ ...acknowledged, connectionVersion: 2 }]);
        ack(first.socket, head, 1);
        await first.received.recovery("revision_unavailable");
        expect(await attachments()).toEqual([{ ...acknowledged, connectionVersion: 2 }]);
        ack(first.socket, head, 2);
        await expect
          .poll(attachments)
          .toEqual([
            { ...acknowledged, acknowledgedRevision: head.toString(), connectionVersion: 2 },
          ]);
        ack(first.socket, base, 2);
        await first.received.recovery("revision_unavailable");
        expect(await attachments()).toEqual([
          { ...acknowledged, acknowledgedRevision: head.toString(), connectionVersion: 2 },
        ]);

        // Hide one committed event from this audience: the authorized history now has a real gap.
        await owner.sql(
          `UPDATE clockgrove.events SET privacy_class='private_cognition', actor_id='private-scene-sentinel' WHERE partition_sequence=${baseHead + 1n}`,
        );
        const gap = await connect();
        resume(gap.socket, base);
        const fallback = await gap.received.snapshot();
        expect([
          fallback.payload.revision,
          fallback.payload.simulationTime,
          fallback.payload.audienceHash,
        ]).toEqual([await revision(), await time(), snapshot.payload.audienceHash]);
        expect([
          fallback.payload.entities,
          fallback.payload.frames,
          fallback.payload.weather,
          fallback.payload.feedCursor,
        ]).toEqual([
          operations.flatMap((operation) =>
            operation.op === "upsert_entity" ? [operation.entity] : [],
          ),
          operations.flatMap((operation) =>
            operation.op === "upsert_frame" ? [operation.frame] : [],
          ),
          canonical.document.state.weather,
          canonical.coveredHeadSequence.toString(),
        ]);
        expect(
          JSON.stringify(fallback, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          ),
        ).not.toContain("private-scene-sentinel");
        gap.socket.close(1000, "finished");

        const object = snapshot.payload.entities[0];
        if (object === undefined) throw new Error("fixture requires a public object");
        const cue = {
          kind: "footstep",
          objectId: object.objectId,
          reference: "scene-footstep",
          expiresAt: new Date(Date.now() - 1).toISOString(),
          dedupeKey: "expired-footstep",
        };
        expect(await owner.request(`/scene/cue?${query}`, cue)).toEqual({
          status: 200,
          body: { emitted: true },
        });
        expect(first.received.frames).toEqual([]);
        const liveCue = {
          ...cue,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          dedupeKey: "live-footstep",
        };
        expect(await owner.request(`/scene/cue?${query}`, liveCue)).toEqual({
          status: 200,
          body: { emitted: true },
        });
        const transient = decodeObserverSceneMessage(JSON.parse(await first.received.next()));
        expect([transient.lane, transient.type, transient.payload]).toEqual([
          "transient",
          "cue",
          liveCue,
        ]);

        expect(
          await owner.request(`/scene/cue?${query}`, {
            ...liveCue,
            objectId: "hidden-scene-object",
            reference: "private-scene-sentinel",
          }),
        ).toEqual({ status: 200, body: { emitted: true } });
        expect(first.received.frames).toEqual([]);

        const narrowed = await connect();
        await owner.sql(
          'UPDATE clockgrove.world_memberships SET privacy_ceiling=\'{"version":1,"allowedCategories":["operator_evidence"]}\'',
        );
        resume(narrowed.socket, null);
        expect(await narrowed.received.next()).toBe(
          '{"protocolVersion":1,"type":"disconnect","reason":"unauthorized"}',
        );
        expect(narrowed.received.frames).toEqual([]);
        await owner.sql(
          'UPDATE clockgrove.world_memberships SET privacy_ceiling=\'{"version":1,"allowedCategories":["public_scene","operator_evidence"]}\'',
        );

        // Both an obsolete completion and its error lose ownership before a new resume.
        for (const fail of [false, true]) {
          const fenced = await connect();
          let closed = false;
          fenced.socket.addEventListener("close", () => {
            closed = true;
          });
          expect((await owner.request(`/scene/hold?${query}&fail=${fail}`, null)).body).toEqual({
            held: false,
          });
          resume(fenced.socket, null);
          await expect
            .poll(async () => (await owner.request(`/scene/held?${query}`, null)).body)
            .toEqual({ held: true });
          expect((await owner.request(`/scene/reset?${query}`, null)).body).toEqual({
            reset: true,
          });
          resume(fenced.socket, null);
          expect((await owner.request(`/scene/release?${query}`, null)).body).toEqual({
            released: true,
          });
          const newest = await fenced.received.snapshot();
          expect([newest.type, newest.projectionRevision]).toEqual(["snapshot", await revision()]);
          expect([closed, fenced.received.frames]).toEqual([false, []]);
          fenced.socket.close(1000, "finished");
        }

        // Replace the entire local workerd runtime, then model the platform restoring its attachment.
        const savedAttachment = {
          ...acknowledged,
          acknowledgedRevision: head.toString(),
          connectionVersion: 2,
        };
        await expect.poll(attachments).toEqual([savedAttachment]);
        first.socket.close(1000, "local redeploy");
        await expect.poll(attachments).toEqual([]);
        await commit("scene-before-redeploy");
        const redeployHead = await revision();
        const redeployTime = await time();
        await owner.replace();
        first = await connect();
        expect(await owner.request(`/scene/restore?${query}`, savedAttachment)).toEqual({
          status: 200,
          body: savedAttachment,
        });
        resume(first.socket, null);
        const redeployed = decodeObserverSceneMessage(JSON.parse(await first.received.next()));
        if (redeployed.type !== "patch")
          throw new Error("expected attachment-backed redeploy patch");
        expect([
          redeployed.payload.fromRevision,
          redeployed.payload.toRevision,
          redeployed.projectionRevision,
        ]).toEqual([head, redeployHead, redeployHead]);
        expect(redeployed.payload.operations.filter(({ op }) => op === "set_clock")).toEqual([
          { op: "set_clock", simulationTime: redeployTime },
        ]);
        expect(await attachments()).toEqual([savedAttachment]);

        // A recipient's stored grant cannot authorize serialization after membership revocation.
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_remove(grants,'runtime:world-observe')",
        );
        await commit("scene-revoked");
        expect(await first.received.next()).toBe(
          '{"protocolVersion":1,"type":"disconnect","reason":"unauthorized"}',
        );
        expect(first.received.frames).toEqual([]);
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe')",
        );
        const lagging = await connect();
        resume(lagging.socket, null);
        await lagging.received.snapshot();
        // Fill the bounded ledger, then coalesce two committed revisions until an ack frees it.
        for (let index = 0; index < 5; index++) await commit(`scene-coalesce-${index}`);
        const delivered = [];
        for (let index = 0; index < 3; index++)
          delivered.push(decodeObserverSceneMessage(JSON.parse(await lagging.received.next())));
        expect(lagging.received.frames).toEqual([]);
        const latest = delivered.at(-1);
        if (latest?.type !== "patch") throw new Error("expected final bounded patch");
        // Make the undelivered range unavailable while retaining the authorized live baseline.
        await owner.sql(
          "UPDATE clockgrove.events SET privacy_class='private_cognition', actor_id='private-scene-sentinel' WHERE partition_sequence=(SELECT covered_head_sequence FROM clockgrove.partition_states)",
        );
        ack(lagging.socket, latest.payload.toRevision, 1);
        const coalesced = decodeObserverSceneMessage(JSON.parse(await lagging.received.next()));
        expect(coalesced.type).toBe("patch");
        if (coalesced.type !== "patch") throw new Error("expected coalesced patch");
        expect([
          coalesced.payload.fromRevision,
          coalesced.payload.toRevision,
          coalesced.payload.sourceEventIds,
        ]).toEqual([latest.payload.toRevision, await revision(), []]);
        const coalescedCanonical = (await inspectNativeWorldOwner(owner)).partition;
        expect(coalesced.payload.operations).toEqual(expectedOperations(coalescedCanonical));
        const closed = lagging.received.closed();
        for (let index = 0; index < 8; index++) await commit(`scene-pressure-${index}`);
        expect(await closed).toEqual({ code: 1013, reason: "backpressure" });
        expect(lagging.received.frames.map((wire) => JSON.parse(wire))).toContainEqual({
          protocolVersion: 1,
          type: "recovery",
          reason: "backpressure",
        });
        const storage = await owner.request(`/scene/storage?${query}`, null);
        expect(storage.status).toBe(200);
        expect(storage.body).toMatchObject({
          tables: ["_cf_KV", "_cf_METADATA"],
          placementFields: [
            "authorityEpoch",
            "fidelity",
            "routingEpoch",
            "runtimeCellId",
            "runtimeInstanceId",
            "spaceId",
            "timelineId",
            "worldId",
          ],
          localFields: [
            "owner",
            "partitionId",
            "placement",
            "primaryStreamId",
            "projectionRevision",
            "routeName",
            "schemaVersion",
          ],
        });
        const stored = storage.body;
        if (
          typeof stored !== "object" ||
          stored === null ||
          !("keys" in stored) ||
          !Array.isArray(stored.keys)
        )
          throw new Error("expected native storage keys");
        expect(
          stored.keys.filter(
            (key: unknown) =>
              ![
                "runtime-local-state",
                "clock-alarm-at",
                "clock-alarm-generation",
                "clock-alarm-scope",
                "clock-alarm-activation",
              ].includes(String(key)),
          ),
        ).toEqual([]);
        for (const mode of ["malformed", "resume"] as const) {
          const repeated = await connect();
          const closed = repeated.received.closed();
          for (let turn = 0; turn < 4; turn++) {
            resume(repeated.socket, null);
            expect((await repeated.received.snapshot()).projectionRevision).toBe(await revision());
          }
          if (mode === "malformed") {
            repeated.socket.send("{");
            expect(await repeated.received.next()).toBe(
              '{"protocolVersion":1,"type":"disconnect","reason":"malformed_control"}',
            );
            expect(await closed).toEqual({ code: 1008, reason: "malformed_control" });
          } else {
            resume(repeated.socket, null);
            await repeated.received.recovery("backpressure");
            expect(await closed).toEqual({ code: 1013, reason: "backpressure" });
          }
        }
        const liveRevision = await revision();
        const live = await connect();
        resume(live.socket, null);
        const baseline = await live.received.snapshot();
        expect(baseline.payload.revision).toBe(liveRevision);
        ack(live.socket, liveRevision, 1);
        // Five unchanged resumes exceed the four-frame bound unless their valid acks retire work.
        for (let version = 2; version <= 6; version++) {
          resume(live.socket, baseline.payload.revision);
          expect((await live.received.snapshot()).projectionRevision).toBe(
            baseline.payload.revision,
          );
          ack(live.socket, baseline.payload.revision, version);
          const expectedCursor = {
            ...initialAttachment,
            acknowledgedRevision: liveRevision.toString(),
            connectionVersion: version,
          };
          await expect.poll(attachments).toEqual([expectedCursor]);
        }
        live.socket.close(1000, "finished");

        // Memory loss between a delivery and its ack: a notice, then the late ack resumes.
        const restored = await connect();
        resume(restored.socket, null);
        const unacknowledged = (await restored.received.snapshot()).payload.revision;
        expect((await owner.request(`/scene/reset?${query}`, null)).body).toEqual({ reset: true });
        await commit("scene-restored");
        await restored.received.recovery("runtime_restarted");
        ack(restored.socket, unacknowledged, 1);
        const caught = decodeObserverSceneMessage(JSON.parse(await restored.received.next()));
        if (caught.type !== "patch") throw new Error("expected a patch after the restored ack");
        expect([caught.payload.fromRevision, caught.payload.toRevision]).toEqual([
          unacknowledged,
          await revision(),
        ]);
        await expect
          .poll(attachments)
          .toEqual([{ ...initialAttachment, acknowledgedRevision: unacknowledged.toString() }]);

        // Sockets with one audience and cursor share a commit's read; a fifth is refused.
        const peers = [restored, await connect(), await connect()];
        const shared = await revision();
        for (const peer of peers.slice(1)) {
          resume(peer.socket, null);
          expect((await peer.received.snapshot()).projectionRevision).toBe(shared);
        }
        for (const peer of peers) ack(peer.socket, shared, 1);
        const sharedCursor = { ...initialAttachment, acknowledgedRevision: shared.toString() };
        await expect.poll(attachments).toEqual([sharedCursor, sharedCursor, sharedCursor]);
        const reads = async () => {
          const { body } = await owner.request(`/scene/reads?${query}`, null);
          if (typeof body !== "object" || body === null || !("reads" in body))
            throw new Error("expected a scene read count");
          return Number(body.reads);
        };
        const before = await reads();
        await commit("scene-shared");
        for (const peer of peers) {
          const fanned = decodeObserverSceneMessage(JSON.parse(await peer.received.next()));
          expect([fanned.type, fanned.projectionRevision]).toEqual(["patch", await revision()]);
        }
        expect(await reads()).toBe(before + 1);
        await connect();
        const full = await owner.upgrade(route, carrier);
        expect([full.status, full.webSocket, await full.json()]).toEqual([
          503,
          null,
          { error: "scene_connections_full" },
        ]);
        // A changed authority epoch ends a socket admitted under the old one.
        await owner.sql("UPDATE clockgrove.timeline_partitions SET routing_epoch=routing_epoch+1");
        resume(restored.socket, null);
        expect(await restored.received.next()).toBe(
          '{"protocolVersion":1,"type":"disconnect","reason":"stale_authority_epoch"}',
        );

        // issue 810: audiences are decided on the server per principal's current authority.
        await owner.reset();
        const ceiling = (...categories: string[]) =>
          `'${JSON.stringify({ version: 1, allowedCategories: categories })}'`;
        await owner.sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling=${ceiling("public_scene", "private_cognition")}`,
        );
        await owner.sql(
          `INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) SELECT tenant_id, 'principal-outsider' FROM clockgrove.tenants; INSERT INTO clockgrove.world_memberships (tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id, roles, grants, privacy_ceiling, committed_at) SELECT tenant_id, world_id, timeline_id, space_id, 'principal-outsider', 'membership-outsider', 'persona-outsider', roles, ARRAY['runtime:world-observe','runtime:world-command'], ${ceiling("public_scene")}, now() FROM clockgrove.world_memberships`,
        );
        const audienceOf = (
          privacyCategories: string[],
          operator = false,
          selection: string | null = null,
        ) =>
          createHash("sha256")
            .update(
              canonicalBytes({
                scope: owner.scope,
                privacyCategories,
                interest: { selection, conversation: false, operator },
                // Every principal here holds the command grant and no conversation ceiling.
                actions: { talk: false, influence: true },
              }),
            )
            .digest("hex");
        const join = async (credential: string, interest = "") => {
          const upgraded = await owner.upgrade(`${route}${interest}`, {
            "sec-websocket-protocol": `${SCENE_PROTOCOL}, ${SCENE_CREDENTIAL_PREFIX}${credential}`,
          });
          return upgraded;
        };
        // An observer-only principal is refused the operator lane with a stable error.
        const refused = await join("outsider-session-token", "&operator=true");
        expect([refused.status, await refused.json()]).toEqual([
          403,
          { error: "operator_interest_refused" },
        ]);
        // So is a principal whose ceiling lacks `conversation`.
        const unconversed = await join("outsider-session-token", "&conversation=true");
        expect([unconversed.status, await unconversed.json()]).toEqual([
          403,
          { error: "conversation_interest_refused" },
        ]);
        const open = async (credential: string, interest = "") => {
          const upgraded = await join(credential, interest);
          expect(upgraded.status).toBe(101);
          const socket = upgraded.webSocket;
          if (socket === null) throw new Error("native scene socket missing");
          const received = inbox(socket);
          socket.accept();
          resume(socket, null);
          return { socket, received };
        };
        // A selection in the space enters the decided audience; one outside it is dropped.
        const resident = (await attachments()).length;
        for (const [selection, decided] of [
          ["beacon.master", "beacon.master"],
          ["beacon.elsewhere", null],
        ] as const) {
          const selecting = await open("outsider-session-token", `&selection=${selection}`);
          await selecting.received.recovery("snapshot_required");
          const view = decodeObserverSceneMessage(JSON.parse(await selecting.received.next()));
          expect(view.type === "snapshot" && view.payload.audienceHash).toBe(
            audienceOf(["public_scene"], false, decided),
          );
          selecting.socket.close(1000, "finished");
          await expect.poll(async () => (await attachments()).length).toBe(resident);
        }
        const memory = [
          {
            ref: "scripted:cistern-memory",
            kind: "memory",
            actorId: "beacon.master",
            targetObjectId: "beacon.cistern",
            value: 4000,
          },
        ];
        const kin = await open("local-reader-session");
        const twin = await open("local-reader-session");
        const stranger = await open("outsider-session-token");
        const kinView = (await kin.received.snapshot()).payload;
        await twin.received.snapshot();
        await stranger.received.recovery("snapshot_required");
        const strangerWire = await stranger.received.next();
        const strangerView = decodeObserverSceneMessage(JSON.parse(strangerWire));
        if (strangerView.type !== "snapshot") throw new Error("expected a snapshot");
        expect([kinView.audienceHash, kinView.privateCognition]).toEqual([
          audienceOf(["public_scene", "private_cognition"]),
          memory,
        ]);
        expect([
          strangerView.payload.audienceHash,
          "privateCognition" in strangerView.payload,
        ]).toEqual([audienceOf(["public_scene"]), false]);
        expect(strangerWire).not.toContain("cistern-memory");
        expect(strangerView.payload.entities).toEqual(kinView.entities);
        const fanned = async (peers: (typeof kin)[]) => {
          const wires = [];
          for (const peer of peers) {
            const wire = await peer.received.next();
            const message = decodeObserverSceneMessage(JSON.parse(wire));
            ack(peer.socket, message.projectionRevision ?? -1n, 1);
            wires.push(wire);
          }
          return wires;
        };
        for (const peer of [kin, twin, stranger]) ack(peer.socket, kinView.revision, 1);
        const split = await reads();
        await commit("audience-split");
        // One read and one encoded frame per distinct audience, whoever the principals are.
        const [kinPatch, twinPatch, strangerPatch] = await fanned([kin, twin, stranger]);
        expect([kinPatch === twinPatch, kinPatch === strangerPatch, await reads()]).toEqual([
          true,
          false,
          split + 2,
        ]);
        expect(strangerPatch).not.toContain("cistern-memory");
        // A narrowed ceiling forces a snapshot that keeps nothing of the prior audience.
        await owner.sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling=${ceiling("public_scene")}`,
        );
        await commit("audience-narrowed");
        for (const peer of [kin, twin]) {
          await peer.received.recovery("snapshot_required");
          const wire = await peer.received.next();
          const narrowed = decodeObserverSceneMessage(JSON.parse(wire));
          if (narrowed.type !== "snapshot") throw new Error("expected a forced snapshot");
          expect([narrowed.payload.audienceHash, wire.includes("cistern-memory")]).toEqual([
            audienceOf(["public_scene"]),
            false,
          ]);
          ack(peer.socket, narrowed.payload.revision, 1);
        }
        await fanned([stranger]);
        const sharedReads = await reads();
        await commit("audience-shared");
        const wires = await fanned([kin, twin, stranger]);
        expect([new Set(wires).size, await reads()]).toEqual([1, sharedReads + 1]);
        // Across memory loss the attachment's acknowledged audience still forces the snapshot.
        await owner.sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling=${ceiling("public_scene", "private_cognition")} WHERE principal_id='principal-runtime'`,
        );
        await commit("audience-widened");
        for (const peer of [kin, twin]) {
          await peer.received.recovery("snapshot_required");
          const widened = decodeObserverSceneMessage(JSON.parse(await peer.received.next()));
          if (widened.type !== "snapshot") throw new Error("expected a forced snapshot");
          expect(widened.payload.privateCognition).toEqual(memory);
          ack(peer.socket, widened.payload.revision, 1);
        }
        await fanned([stranger]);
        const hashes = async () => {
          const rows: unknown = await (await owner.upgrade(`/scene/attachments?${query}`)).json();
          if (!Array.isArray(rows)) throw new Error("expected native attachment list");
          return rows
            .map((row: unknown) => decodeSceneConnectionAttachment(row).acknowledgedAudienceHash)
            .sort();
        };
        const kinHash = audienceOf(["public_scene", "private_cognition"]);
        const publicHash = audienceOf(["public_scene"]);
        await expect.poll(hashes).toEqual([kinHash, kinHash, publicHash].sort());
        expect((await owner.request(`/scene/reset?${query}`, null)).body).toEqual({ reset: true });
        await owner.sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling=${ceiling("public_scene")}`,
        );
        await commit("audience-restored");
        for (const peer of [kin, twin]) {
          await peer.received.recovery("snapshot_required");
          const wire = await peer.received.next();
          const restoredView = decodeObserverSceneMessage(JSON.parse(wire));
          if (restoredView.type !== "snapshot") throw new Error("expected a restored snapshot");
          expect([restoredView.payload.audienceHash, wire.includes("cistern-memory")]).toEqual([
            publicHash,
            false,
          ]);
          ack(peer.socket, restoredView.payload.revision, 1);
        }
        // An unchanged audience still resumes from its acknowledged revision with a patch.
        const unchanged = decodeObserverSceneMessage(
          JSON.parse((await fanned([stranger]))[0] ?? ""),
        );
        expect(unchanged.type).toBe("patch");
        // Operator-lane messages reach only an audience with the inspection grant.
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-inspect') WHERE principal_id='principal-runtime'",
        );
        const inspector = await open("local-reader-session", "&operator=true");
        const inspected = (await inspector.received.snapshot()).payload;
        expect(inspected.audienceHash).toBe(audienceOf(["public_scene"], true));
        ack(inspector.socket, inspected.revision, 1);
        await commit("audience-operator");
        await fanned([kin, twin, stranger, inspector]);
        const diagnostic = decodeOperatorSceneMessage(JSON.parse(await inspector.received.next()));
        expect([diagnostic.lane, diagnostic.type, diagnostic.payload.connections.length]).toEqual([
          "operator",
          "connections",
          4,
        ]);
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_remove(grants,'runtime:world-inspect')",
        );
        await commit("audience-unoperated");
        // Observers received only projection frames; the revoked inspector is forced to a snapshot.
        await fanned([kin, twin, stranger]);
        await inspector.received.recovery("snapshot_required");
        const demoted = decodeObserverSceneMessage(JSON.parse(await inspector.received.next()));
        expect([demoted.type, demoted.type === "snapshot" && demoted.payload.audienceHash]).toEqual(
          ["snapshot", audienceOf(["public_scene"])],
        );
        expect(inspector.received.frames).toEqual([]);
        // The card's authority is audience: losing the command grant splits the stranger off with
        // a forced snapshot whose Influence is disabled, while its former peers keep patching.
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_remove(grants,'runtime:world-command') WHERE principal_id='principal-outsider'",
        );
        await commit("audience-uncommanded");
        expect(new Set(await fanned([kin, twin])).size).toBe(1);
        await stranger.received.recovery("snapshot_required");
        const observerOnly = decodeObserverSceneMessage(JSON.parse(await stranger.received.next()));
        if (observerOnly.type !== "snapshot") throw new Error("expected a forced snapshot");
        expect([
          observerOnly.payload.audienceHash,
          observerOnly.payload.interactions.find((card) => card.entityId === "beacon.cistern")
            ?.actions,
        ]).toEqual([
          createHash("sha256")
            .update(
              canonicalBytes({
                scope: owner.scope,
                privacyCategories: ["public_scene"],
                interest: { selection: null, conversation: false, operator: false },
              }),
            )
            .digest("hex"),
          [
            { kind: "inspect", availability: "enabled" },
            { kind: "history", availability: "enabled" },
            { kind: "influence", availability: "disabled", reason: "command_grant_required" },
          ],
        ]);
      });
    },
    120_000,
  );
});
