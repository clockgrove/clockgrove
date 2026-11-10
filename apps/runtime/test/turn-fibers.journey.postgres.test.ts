import { decodeConversationSession, decodeTalkReceipt } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/turn-fibers.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const KEEPER = "fixture.keeper";
// Every §7.1 phase boundary a scripted turn crosses; `model_running:streaming` is mid-stream.
const BOUNDARIES = [
  "accepted",
  "context_pending",
  "context_ready",
  "model_running:streaming",
  "proposal_validating",
  "committing",
  "finalizing",
];

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      prepare: async (fixture) => {
        const { truthOf } = await import("./world-fixture.js");
        await truthOf(fixture)(
          `UPDATE clockgrove.world_memberships
              SET grants = array_append(grants, 'runtime:world-observe'),
                  privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation"]}'`,
        );
      },
    });
  },
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "recovers turns crashed at every phase boundary without duplicating a message, run commit or turn",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (path: string, fields: object) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, MEMBER);
      const agent = async (fields: object) => {
        const response = await fetch(new URL("/actor-agent", await owner.origin()), {
          method: "POST",
          headers: { authorization: `Bearer ${MEMBER}`, "x-correlation-id": "native-turns" },
          body: JSON.stringify({
            version: 1,
            ...owner.scope,
            scope: owner.scope,
            actorId: KEEPER,
            ...fields,
          }),
        });
        const text = await response.text();
        if (response.status !== 200) throw new Error(text);
        return JSON.parse(text);
      };
      const open = async () =>
        decodeConversationSession(
          (await post("/v1/runtime/conversations/create", { actorId: KEEPER })).body,
        ).sessionId;
      const talk = (sessionId: string, messageId: string) =>
        post("/v1/runtime/talk", { sessionId, messageId, text: `hello ${messageId}` });
      const rows = (query: string) => owner.sql(query);

      // A crash at each boundary interrupts the request; the same message then resumes or retries.
      const crashed = await open();
      for (const [index, phase] of BOUNDARIES.entries()) {
        const streaming = phase === "model_running:streaming";
        await agent({ op: "fault", phase: streaming ? `break:${phase}` : phase });
        const messageId = `m${index + 1}`;
        if (streaming) {
          // The browser saw a streamed token, then the stream broke: tokens are not the turn.
          const streamed = await fetch(new URL("/v1/runtime/talk", await owner.origin()), {
            method: "POST",
            headers: {
              accept: "application/x-ndjson",
              authorization: `Bearer ${MEMBER}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              version: 1,
              ...owner.scope,
              sessionId: crashed,
              messageId,
              text: `hello ${messageId}`,
            }),
          });
          // Read the token, release the held fault so the owner aborts, then read to the break.
          const reader = streamed.body!.pipeThrough(new TextDecoderStream()).getReader();
          let text = (await reader.read()).value ?? "";
          // The owner aborts as it releases, which can fail the release call too.
          await agent({ op: "release" }).catch((error: Error) =>
            expect(error.message).toContain("injected turn fault at model_running:streaming"),
          );
          for (;;) {
            const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
            if (chunk.done) break;
            text += chunk.value;
          }
          expect(text.startsWith('{"type":"delta","text":"Scripted "}')).toBe(true);
          expect(text).not.toContain('"receipt"');
        } else
          expect(await talk(crashed, messageId)).toEqual({
            status: 503,
            body: { error: "turn_interrupted" },
          });
        const retried = await talk(crashed, messageId);
        expect(retried.status).toBe(200);
        const receipt = decodeTalkReceipt(retried.body);
        expect([receipt.message.sequence, receipt.reply.sequence, receipt.reply.text]).toEqual([
          2 * index + 1,
          2 * index + 2,
          `Scripted fixture reply: you have said ${index + 1} ${index === 0 ? "thing" : "things"} to me in this conversation.`,
        ]);
      }
      await agent({ op: "fault", phase: null });
      expect(
        await rows(
          `SELECT string_agg(message_id || '/' || role, ',' ORDER BY sequence)
             FROM clockgrove.conversation_messages WHERE session_id = '${crashed}'`,
        ),
      ).toBe(BOUNDARIES.map((_, i) => `m${i + 1}/caretaker,m${i + 1}:reply/actor`).join(","));
      // Abandoned attempts are recorded; a crash after the commit only finalizes.
      expect(
        await rows(
          `SELECT string_agg(f.message_id || '=' || f.phase || '/' || f.attempt || ':' ||
                    (SELECT string_agg(r.status || coalesce('/' || r.outcome_code, ''), '+'
                                       ORDER BY r.started_at)
                       FROM clockgrove.agent_runs r
                      WHERE r.session_id = f.session_id AND r.input_message_id = f.message_id),
                  ',' ORDER BY f.message_id)
             FROM clockgrove.conversation_turn_fibers f WHERE f.session_id = '${crashed}'`,
        ),
      ).toBe(
        [
          "m1=completed/1:completed",
          "m2=completed/2:abandoned/owner_lost+completed",
          "m3=completed/2:abandoned/owner_lost+completed",
          "m4=completed/2:abandoned/owner_lost+completed",
          "m5=completed/2:abandoned/owner_lost+completed",
          "m6=completed/2:abandoned/owner_lost+completed",
          "m7=completed/2:completed",
        ].join(","),
      );

      // Duplicate activations of one message coalesce into one turn, one run and one inbox entry.
      const duplicated = await open();
      const [first, second] = await Promise.all([talk(duplicated, "d1"), talk(duplicated, "d1")]);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.body).toEqual(first.body);
      expect(await agent({ op: "perception", sessionId: duplicated, messageId: "d1" })).toEqual({
        admitted: false,
      });
      expect(
        await rows(
          `SELECT (SELECT count(*) FROM clockgrove.conversation_messages WHERE session_id = '${duplicated}')
                  || '/' || (SELECT count(*) FROM clockgrove.agent_runs WHERE session_id = '${duplicated}')
                  || '/' || (SELECT attempt FROM clockgrove.conversation_turn_fibers WHERE session_id = '${duplicated}')`,
        ),
      ).toBe("2/1/1");

      // A session's turns are ordered: while one runs, another message of it is refused busy, and
      // other sessions' turns run concurrently.
      const ordered = await open();
      await agent({ op: "fault", phase: "hold:context_ready" });
      const holding = talk(ordered, "o1");
      await expect
        .poll(
          async () =>
            (await post("/v1/runtime/turns/status", { sessionId: ordered, messageId: "o1" })).body,
        )
        .toMatchObject({ phase: "context_ready" });
      await agent({ op: "fault", phase: null });
      expect(await talk(ordered, "o2")).toEqual({
        status: 409,
        body: { error: "conversation_busy" },
      });
      const [left, right] = await Promise.all([talk(await open(), "c1"), talk(await open(), "c1")]);
      expect([left.status, right.status]).toEqual([200, 200]);
      await agent({ op: "release" });
      expect((await holding).status).toBe(200);
      // A message sent after a crashed turn waits for the owner to resume that turn, then follows it.
      await agent({ op: "fault", phase: "model_running:streaming" });
      expect((await talk(ordered, "o3")).status).toBe(503);
      await agent({ op: "fault", phase: null });
      const following = await talk(ordered, "o4");
      expect(following.status).toBe(200);
      expect(
        await rows(
          `SELECT string_agg(message_id || '@' || sequence, ',' ORDER BY sequence)
             FROM clockgrove.conversation_messages WHERE session_id = '${ordered}'`,
        ),
      ).toBe("o1@1,o1:reply@2,o3@3,o3:reply@4,o4@5,o4:reply@6");
      expect(
        (await post("/v1/runtime/turns/status", { sessionId: ordered, messageId: "o3" })).body,
      ).toMatchObject({ phase: "completed", attempt: 2 });

      // Cancel stops a running turn before it commits; a committed turn's status does not change.
      const cancelled = await open();
      await agent({ op: "fault", phase: "hold:proposal_validating" });
      const held = talk(cancelled, "x1");
      await expect
        .poll(
          async () =>
            (await post("/v1/runtime/turns/status", { sessionId: cancelled, messageId: "x1" }))
              .body,
        )
        .toMatchObject({ phase: "proposal_validating" });
      expect(
        await post("/v1/runtime/turns/cancel", { sessionId: cancelled, messageId: "x1" }),
      ).toEqual({
        status: 200,
        body: {
          sessionId: cancelled,
          messageId: "x1",
          phase: "cancelled",
          attempt: 1,
          outcomeCode: "cancel_requested",
        },
      });
      await agent({ op: "fault", phase: null });
      await agent({ op: "release" });
      expect(await held).toEqual({ status: 409, body: { error: "turn_cancelled" } });
      expect(await talk(cancelled, "x1")).toEqual({
        status: 409,
        body: { error: "turn_cancelled" },
      });
      expect(
        (await post("/v1/runtime/turns/cancel", { sessionId: ordered, messageId: "o1" })).body,
      ).toMatchObject({ phase: "completed" });
      expect(
        await post("/v1/runtime/turns/status", { sessionId: cancelled, messageId: "nope" }),
      ).toEqual({ status: 404, body: { error: "turn_not_found" } });
      expect(
        await rows(
          `SELECT string_agg(status || '/' || outcome_code, ',') FROM clockgrove.agent_runs
            WHERE session_id = '${cancelled}'`,
        ),
      ).toBe("cancelled/cancel_requested");

      // An owner that lost its local storage (and so the SDK's fiber rows) resumes from PostgreSQL.
      const lost = await open();
      await agent({ op: "fault", phase: "context_ready" });
      expect((await talk(lost, "l1")).status).toBe(503);
      await owner.replace(true);
      await expect
        .poll(
          async () =>
            (await post("/v1/runtime/turns/status", { sessionId: lost, messageId: "l1" })).body,
        )
        .toMatchObject({ phase: "completed", attempt: 2 });

      // The capability revision hook only moves forward; the next claim records it.
      expect(await agent({ op: "capabilities", revision: 3 })).toMatchObject({
        capabilityRevision: 3,
      });
      expect(await agent({ op: "capabilities", revision: 2 })).toMatchObject({
        capabilityRevision: 3,
      });
      const revised = await open();
      expect((await talk(revised, "r1")).status).toBe(200);
      expect(
        await rows(
          `SELECT capability_revision FROM clockgrove.conversation_turn_fibers WHERE session_id = '${revised}'`,
        ),
      ).toBe("3");
      expect(await agent({ op: "inspect" })).toMatchObject({
        recovery: { schemaVersion: 1, capabilityRevision: 3 },
        running: 0,
      });

      // ActorProcess: a stable process ID across bounded segments, checkpoints and lease epochs.
      const advance = () => agent({ op: "process", processId: "tally-1", target: 10, steps: 4 });
      expect(await advance()).toMatchObject({ processId: "tally-1", checkpoint: 4, leaseEpoch: 1 });
      await owner.replace();
      expect(await advance()).toMatchObject({ processId: "tally-1", checkpoint: 8, leaseEpoch: 2 });
      await expect(
        rows(
          `INSERT INTO clockgrove.actor_process_segments (tenant_id, process_id, segment, lease_epoch,
             lease_holder, from_checkpoint, to_checkpoint)
           SELECT tenant_id, process_id, 3, 1, 'superseded', 8, 9 FROM clockgrove.actor_processes`,
        ),
      ).rejects.toThrow(/stale process lease/);
      expect(await advance()).toMatchObject({
        processId: "tally-1",
        actorId: KEEPER,
        objective: "fixture-tally",
        target: 10,
        checkpoint: 10,
        state: "completed",
        leaseEpoch: 3,
        segments: [
          { segment: 1, leaseEpoch: 1, fromCheckpoint: 0, toCheckpoint: 4 },
          { segment: 2, leaseEpoch: 2, fromCheckpoint: 4, toCheckpoint: 8 },
          { segment: 3, leaseEpoch: 3, fromCheckpoint: 8, toCheckpoint: 10 },
        ],
      });
      expect(await advance()).toMatchObject({ checkpoint: 10, leaseEpoch: 3 });
    });
  },
  240_000,
);
