import {
  AuthorizationRefusedError,
  type CausalCommandView,
  encodeCanonicalNode,
  executeWorldCommand,
  InspectionIntegrityError,
  InspectorRateLimitedError,
} from "@clockgrove/application";
import {
  ContractDecodeError,
  decodeEntitySelection,
  decodeEntitySelectionRequest,
  decodeLivingScene,
  decodeOpaqueId,
  decodePrivacyCeiling,
  decodeRecordedWhy,
} from "@clockgrove/contracts";
import { PostgreSqlWorldCommandJournal, PostgreSqlWorldOwnerReader } from "@clockgrove/persistence";
import { expect, it, vi } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { sceneSession, selectionOf } from "../../web/test/scene-socket-fixture.js";
import { PostgreSqlCausalInspector, publicRecordedWhy } from "../src/inspector.js";
import {
  PostgreSqlEntitySelectionReader,
  PostgreSqlLivingSceneReader,
} from "../src/observation.js";
import { RuntimeWorker } from "../src/worker.js";
import { livingYardAuthentication } from "./living-yard-fixture.js";
import {
  advanceCommand,
  commandRequest,
  type DatabaseFixture,
  kernelModel,
  provisionTestWorld,
  pureStep,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

it("reads original routine receipts through the audited inspector, never mutates canonical state and isolates every superseded Why lifetime", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld("raccoons");
    const provisioned = await provisionTestWorld(fixture, world, "principal-recorded-why");
    const auth = livingYardAuthentication(provisioned);
    const truth = truthOf(fixture);
    await withClient(fixture.environment, async (client) => {
      const inspector = new PostgreSqlCausalInspector(client);
      const observer = new PostgreSqlLivingSceneReader(new PostgreSqlWorldOwnerReader(client));
      const selected = new PostgreSqlEntitySelectionReader(client);
      const worker = new RuntimeWorker(auth.authenticator, {
        getSpace: () => {
          throw new Error("observation cannot route a command");
        },
        inspector,
        observation: {
          observe: (scope, context) => observer.observe(scope, context),
          select: (input, context) => selected.select(input, context, 100n),
        },
      });
      const request = (endpoint: string, fields = {}, credential = "yard-inspect") =>
        new Request(`http://local.test/v1/runtime/${endpoint}`, {
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          body: JSON.stringify({ version: 1, ...auth.scope, ...fields }),
        });
      const originalCommand = advanceCommand(
        world,
        "why-original",
        world.birth.state.simulationTime + world.behavior.policy.decisionIntervalMs,
        null,
      );
      const command = {
        ...originalCommand,
        attribution: {
          ...originalCommand.attribution,
          immediateCauseId: "PRIVATE-CAUSAL-LINK-SENTINEL",
        },
      };
      const original = pureStep(world, kernelModel(world), command).decisionDrafts.filter(
        (draft) => draft.kind === "routine",
      );
      expect(
        (
          await executeWorldCommand(commandRequest(provisioned, command), {
            journal: new PostgreSqlWorldCommandJournal(client),
            behavior: provisioned.behavior,
          })
        ).outcome,
      ).toBe("committed");
      expect(
        JSON.parse(
          await truth(
            "SELECT result->'projectionDelta'->'decisionTraces'->'drafts' FROM clockgrove.command_receipts WHERE command_id = 'why-original'",
          ),
        ),
      ).toEqual(encodeCanonicalNode(original));
      const canonical =
        "SELECT jsonb_build_object('state',(SELECT jsonb_agg(to_jsonb(s) ORDER BY partition_id) FROM clockgrove.partition_states s),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM clockgrove.command_receipts r),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM clockgrove.events e),'schedules',(SELECT jsonb_agg(to_jsonb(q) ORDER BY schedule_id,idempotency_key) FROM clockgrove.partition_schedules q))::text";
      const provisioningParents = JSON.parse(
        await truth(
          "SELECT jsonb_agg(command_id ORDER BY command_id)::text FROM clockgrove.events WHERE event_type = 'WorldReady'",
        ),
      );
      const before = await truth(canonical);
      const response = await worker.fetch(request("why", { commandId: command.commandId }));
      expect(response.status).toBe(200);
      const why = decodeRecordedWhy(await response.json());
      expect([why.commandId, why.links]).toEqual([
        "why-original",
        { parents: provisioningParents, children: [] },
      ]);
      expect(why.traces.status).toBe("available");
      expect(
        why.traces.drafts.map((trace) => [
          trace.draftIndex,
          trace.inputRevision,
          trace.selectedAction,
        ]),
      ).toEqual(
        original.map(({ decision }, index) => [
          index,
          String(decision.inputRevision),
          {
            kind: decision.selectedAction.kind,
            targetObjectId: decision.selectedAction.targetObjectId ?? null,
          },
        ]),
      );
      expect(
        why.traces.drafts.map((trace) => [trace.objectId, trace.simulationTime]).sort(),
      ).toEqual([
        ["grove.gracie", "8640000000"],
        ["grove.gracie", "8726400000"],
        ["grove.kit", "8640000000"],
        ["grove.kit", "8726400000"],
        ["grove.stevie", "8640000000"],
        ["grove.stevie", "8726400000"],
      ]);
      for (const trace of why.traces.drafts) {
        expect(
          trace.candidates
            .filter((candidate) => candidate.action.kind === "stay")
            .map((candidate) => [candidate.score, candidate.excludedReason]),
        ).toEqual([["0", null]]);
      }
      const whyInput = { scope: auth.scope, commandId: command.commandId };
      // issue 977: an observation context never reads the operator view, whatever grant the caller
      // names or its ceiling, and the inspect grant alone needs an operator_evidence ceiling.
      const observeOnly = await auth.authenticator.authorize(
        await auth.authenticator.identify(request("why", { commandId: command.commandId })),
        undefined,
        "runtime:world-observe",
      );
      const inspectPublic = {
        ...observeOnly,
        grants: [decodeOpaqueId("runtime:world-inspect", "GrantRef")],
        privacyCeiling: decodePrivacyCeiling({ version: 1, allowedCategories: ["public_scene"] }),
      };
      for (const context of [observeOnly, inspectPublic])
        await expect(
          (inspector.inspect as (...args: unknown[]) => Promise<unknown>).call(
            inspector,
            whyInput,
            context,
            "runtime:world-observe",
          ),
        ).rejects.toBeInstanceOf(AuthorizationRefusedError);
      const retained = {
        receipt: { commandId: command.commandId, status: "committed" },
        schedules: [],
        links: { parents: [], children: [] },
      } as unknown as CausalCommandView;
      const traces = (decisionTraces?: CausalCommandView["decisionTraces"]) =>
        publicRecordedWhy(
          whyInput,
          decisionTraces === undefined ? retained : { ...retained, decisionTraces },
          async () => retained,
        );
      for (const [decisionTraces, status] of [
        [{ status: "available", drafts: encodeCanonicalNode([]) }, "available"],
        [{ status: "unavailable" }, "unavailable"],
        [undefined, "redacted"],
      ] as const)
        expect((await traces(decisionTraces)).traces).toEqual({ status, drafts: [] });
      await expect(
        traces({
          status: "available",
          drafts: encodeCanonicalNode([{ kind: "routine", decision: {} }]),
        }),
      ).rejects.toBeInstanceOf(InspectionIntegrityError);
      for (const [failure, status, body] of [
        [new InspectorRateLimitedError(), 429, { error: "inspection_rate_limited" }],
        [
          new ContractDecodeError("retained", "PRIVATE-INTERNAL-DEFECT"),
          500,
          { error: "inspection_failed" },
        ],
        [new SyntaxError("PRIVATE-INTERNAL-DEFECT"), 500, { error: "inspection_failed" }],
        [
          new InspectionIntegrityError(command.commandId, "traces"),
          500,
          { error: "inspection_failed" },
        ],
      ] as const) {
        const seam = vi.spyOn(inspector, "recordedWhy").mockRejectedValueOnce(failure);
        try {
          const failureResponse = await worker.fetch(
            request("why", { commandId: command.commandId }),
          );
          expect([failureResponse.status, await failureResponse.json()]).toEqual([status, body]);
        } finally {
          seam.mockRestore();
        }
      }
      const serialized = JSON.stringify(why);
      for (const secret of [
        "PRIVATE-CAUSAL-LINK-SENTINEL",
        "beliefRefs",
        "memoryRefs",
        "perceptionRefs",
        "randomDraws",
        "commandBytes",
        "privacyCeiling",
      ])
        expect(serialized.includes(secret)).toBe(false);
      expect(await truth(canonical)).toBe(before);
      expect(
        JSON.parse(
          await truth(
            "SELECT jsonb_object_agg(reason_code,n)::text FROM (SELECT reason_code,count(*) AS n FROM clockgrove.inspector_accesses GROUP BY reason_code) a",
          ),
        ),
      ).toEqual({ served: 2, "not-found": 1, "authority-mismatch": 2 });
      for (const [fields, credential, status, body] of [
        [{ commandId: "unknown" }, "yard-inspect", 404, { error: "command_not_found" }],
        [
          { commandId: command.commandId, spaceId: "foreign-space" },
          "yard-inspect",
          403,
          { error: "authorization_refused" },
        ],
        [{ commandId: command.commandId }, "invalid", 401, { error: "authentication_refused" }],
        [
          { commandId: command.commandId, payload: { type: "world.advance" } },
          "yard-inspect",
          400,
          { error: "invalid_inspection_request" },
        ],
      ] as const) {
        const refused = await worker.fetch(request("why", fields, credential));
        expect([refused.status, await refused.json()]).toEqual([status, body]);
      }
      expect(await truth(canonical)).toBe(before);
      const next = advanceCommand(
        world,
        "why-newer",
        world.birth.state.simulationTime + 2n * world.behavior.policy.decisionIntervalMs,
        null,
      );
      const newerCommand = {
        ...next,
        attribution: { ...next.attribution, immediateCauseId: command.commandId },
      };
      expect(
        (
          await executeWorldCommand(commandRequest(provisioned, newerCommand), {
            journal: new PostgreSqlWorldCommandJournal(client),
            behavior: provisioned.behavior,
          })
        ).outcome,
      ).toBe("committed");
      const after = await truth(canonical);
      const originalAfter = decodeRecordedWhy(
        await (await worker.fetch(request("why", { commandId: command.commandId }))).json(),
      );
      // Links and schedule rows are current rows, read again; the retained receipt is not.
      const { links: _originalLinks, schedules: _schedules, ...immutableWhy } = why;
      const { links: currentLinks, schedules: currentSchedules, ...immutableAfter } = originalAfter;
      expect(immutableAfter).toEqual(immutableWhy);
      expect(currentLinks).toEqual({
        parents: provisioningParents,
        children: ["why-newer"],
      });
      // The schedule rows are re-read: exactly the command's current rows in the journal.
      const order = (rows: readonly { scheduleId: string; idempotencyKey: string }[]) =>
        [...rows].sort((a, b) =>
          `${a.scheduleId}\n${a.idempotencyKey}` < `${b.scheduleId}\n${b.idempotencyKey}` ? -1 : 1,
        );
      expect(order(currentSchedules)).toEqual(
        order(
          JSON.parse(
            await truth(
              "SELECT coalesce(jsonb_agg(jsonb_build_object('scheduleId',schedule_id,'idempotencyKey',idempotency_key,'kind',kind,'dueAt',due_at::text,'status',status,'scheduledBy',scheduled_by_command_id,'completedBy',completed_by_command_id)),'[]')::text FROM clockgrove.partition_schedules WHERE 'why-original' IN (scheduled_by_command_id, completed_by_command_id)",
            ),
          ),
        ),
      );
      expect(JSON.stringify(originalAfter).includes("PRIVATE-CAUSAL-LINK-SENTINEL")).toBe(false);
      const newer = decodeRecordedWhy(
        await (await worker.fetch(request("why", { commandId: newerCommand.commandId }))).json(),
      );
      expect(newer.links).toEqual({ parents: ["why-original"], children: [] });
      const scene = decodeLivingScene(await (await worker.fetch(request("scene"))).json());
      const entity = decodeEntitySelection(
        await (await worker.fetch(request("entity", { objectId: "grove.gracie" }))).json(),
      );
      const otherEntity = decodeEntitySelection(
        await (await worker.fetch(request("entity", { objectId: "grove.stevie" }))).json(),
      );
      expect([...new Set(entity.history.actions.map((action) => action.commandId))]).toEqual([
        "why-newer",
        "why-original",
      ]);
      expect([
        scene.simulationTime,
        entity.derived.simulationTime,
        entity.derived.canonical,
      ]).toEqual(["8812800000", "8812800000", false]);
      expect(await truth(canonical)).toBe(after);
      // Exercise real session ownership with valid retained responses; obsolete transports ignore cancellation.
      vi.useFakeTimers();
      try {
        for (const transition of [
          "action",
          "entity",
          "scope",
          "reconnect",
          "sign-out",
          "denied",
          "socket-denied",
        ] as const) {
          for (const completion of ["result", "error", "denial"] as const) {
            const pending: {
              resolve: (response: Response) => void;
              reject: (error: Error) => void;
              signal: AbortSignal | null | undefined;
            }[] = [];
            vi.stubGlobal(
              "fetch",
              vi.fn((url: URL, options: RequestInit) => {
                if (url.pathname.endsWith("/entity"))
                  return Promise.resolve(
                    Response.json(
                      decodeEntitySelectionRequest(JSON.parse(String(options.body))).objectId ===
                        entity.objectId
                        ? entity
                        : otherEntity,
                    ),
                  );
                return new Promise<Response>((resolve, reject) => {
                  pending.push({ resolve, reject, signal: options.signal });
                });
              }),
            );
            const fixture = sceneSession();
            const { session, sockets } = fixture;
            try {
              session.replace("yard-inspect", auth.scope);
              await fixture.deliver(scene);
              session.select(entity.objectId);
              await vi.advanceTimersByTimeAsync(0);
              session.explain(command.commandId);
              expect(session.getWhySnapshot()).toEqual({
                commandId: command.commandId,
                status: "loading",
                value: undefined,
              });
              const obsolete = sockets[0];
              if (transition === "reconnect") {
                obsolete?.socket.onerror?.();
                session.replace("replacement", auth.scope);
                await fixture.deliver(scene);
                session.select(entity.objectId);
                await vi.advanceTimersByTimeAsync(0);
                session.explain(newerCommand.commandId);
                pending[1]?.resolve(Response.json(newer));
              } else if (transition === "socket-denied") {
                sockets[0]?.deny();
              } else if (transition === "action" || transition === "denied") {
                session.explain(newerCommand.commandId);
                pending[1]?.resolve(
                  transition === "denied"
                    ? Response.json({ error: "authorization_refused" }, { status: 403 })
                    : Response.json(newer),
                );
              } else if (transition === "entity")
                session.select(decodeOpaqueId("grove.stevie", "ObjectId"));
              else if (transition === "scope")
                session.replace("replacement", {
                  ...auth.scope,
                  spaceId: decodeOpaqueId("replacement-space", "SpaceId"),
                });
              else session.replace(undefined, undefined);
              await vi.advanceTimersByTimeAsync(0);
              expect(pending[0]?.signal?.aborted).toBe(true);
              const expectedWhy =
                transition === "action" || transition === "reconnect"
                  ? { commandId: newerCommand.commandId, status: "ready", value: newer }
                  : { commandId: undefined, status: "none", value: undefined };
              const expectedScope =
                transition === "sign-out" ||
                transition === "denied" ||
                transition === "socket-denied"
                  ? undefined
                  : transition === "scope"
                    ? { ...auth.scope, spaceId: decodeOpaqueId("replacement-space", "SpaceId") }
                    : auth.scope;
              if (completion === "result") pending[0]?.resolve(Response.json(why));
              else if (completion === "error")
                pending[0]?.reject(new Error("obsolete private sentinel"));
              else
                pending[0]?.resolve(
                  Response.json({ error: "authentication_refused" }, { status: 401 }),
                );
              await vi.advanceTimersByTimeAsync(0);
              if (transition === "reconnect") {
                obsolete?.receive({ ...scene, revision: "999999" });
                obsolete?.deny();
                obsolete?.socket.onerror?.();
                obsolete?.socket.onclose?.();
                await vi.advanceTimersByTimeAsync(0);
                expect(session.getSelectionSnapshot()).toEqual(selectionOf(entity));
                expect(session.getSnapshot().scene).toEqual(scene);
                expect(sockets.map(({ close }) => close.mock.calls.length)).toEqual([1, 0]);
              }
              if (transition === "denied" || transition === "socket-denied") {
                expect(session.getSnapshot().scene).toBe(undefined);
                expect(session.getSnapshot().status).toBe("Authorization lost");
                expect(session.getSelectionSnapshot()).toEqual(selectionOf());
                expect(sockets[0]?.close.mock.calls.length).toBe(1);
              }
              expect(session.getWhySnapshot()).toEqual(expectedWhy);
              expect(session.getSnapshot().scope).toEqual(expectedScope);
            } finally {
              session.replace(undefined, undefined);
            }
          }
        }
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
      auth.revoke();
      const denied = await worker.fetch(request("why", { commandId: command.commandId }));
      expect([denied.status, await denied.json()]).toEqual([
        403,
        { error: "authorization_refused" },
      ]);
      expect(await truth(canonical)).toBe(after);
    });
  });
}, 120_000);
