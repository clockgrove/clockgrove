import { createHash } from "node:crypto";
import {
  type ContextInspection,
  type DocumentVersionView,
  decodeConversationSession,
  type RunWalk,
} from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/context.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const OPERATOR = "outsider-session-token";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const IDENTITY = "# Keeper\nA careful resident.\n";
const POLICY = "Keep each conversation private. ".repeat(256);
const GOALS = "Find acorns before winter.";
const LEDGER = "Acorn ledger. ".repeat(585);
const REPLY = "Scripted fixture reply: you have said 1 thing to me in this conversation.";
const REFUSED = "fixture:propose policy.md\nShare everything.";

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      // The member talks; the operator governs Keeper's documents and inspects, but talks to no one.
      prepare: async (fixture) => {
        const { truthOf } = await import("./world-fixture.js");
        await truthOf(fixture)(
          `UPDATE clockgrove.world_memberships
              SET grants = array_append(grants, 'runtime:world-observe'),
                  privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation"]}';
           INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
             SELECT DISTINCT tenant_id, 'principal-outsider' FROM clockgrove.world_memberships;
           INSERT INTO clockgrove.world_memberships (
             tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id,
             roles, grants, privacy_ceiling, committed_at
           ) SELECT tenant_id, world_id, timeline_id, space_id, 'principal-outsider',
                    'membership-outsider', 'persona-outsider', roles,
                    grants || ARRAY['runtime:world-inspect', 'runtime:actor-govern'],
                    '{"version":1,"allowedCategories":["public_scene","private_cognition","operator_evidence"]}',
                    now()
               FROM clockgrove.world_memberships WHERE principal_id = 'principal-runtime'`,
        );
      },
    });
  },
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "assembles each turn's context authorization-first, reproducibly, with governed documents",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (path: string, fields: object, credential = MEMBER) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, credential);
      const change = (changeSetId: string, operations: object[], credential = OPERATOR) =>
        post(
          "/v1/runtime/actor-documents/change",
          { actorId: "fixture.keeper", changeSetId, operations },
          credential,
        );
      const read = async (path: string) =>
        (
          await post(
            "/v1/runtime/actor-documents/read",
            { actorId: "fixture.keeper", path },
            OPERATOR,
          )
        ).body as DocumentVersionView;

      // An operator writes Keeper's documents in one change set; each version's hash is its text's.
      const created = await change("cs-1", [
        { op: "create", path: "identity.md", content: IDENTITY },
        { op: "create", path: "policy.md", content: POLICY },
        { op: "create", path: "goals.md", content: GOALS },
        { op: "create", path: "working-context.md", content: LEDGER },
      ]);
      expect(created.status).toBe(200);
      const body = created.body as {
        documents: { path: string; version: number; sourceHash: string }[];
      };
      expect(body.documents.map((d) => [d.path, d.version, d.sourceHash])).toEqual([
        ["identity.md", 1, sha(IDENTITY)],
        ["policy.md", 1, sha(POLICY)],
        ["goals.md", 1, sha(GOALS)],
        ["working-context.md", 1, sha(LEDGER)],
      ]);

      // All or nothing: a stale expected version refuses the whole set, so identity.md is unchanged.
      expect(
        await change("cs-2", [
          { op: "patch", path: "identity.md", expectedVersion: 1, content: "# Someone else" },
          { op: "patch", path: "goals.md", expectedVersion: 2, content: "Other goals." },
        ]),
      ).toEqual({
        status: 409,
        body: { error: "version_conflict", changeSetId: "cs-2", operation: 2 },
      });
      expect([(await read("identity.md")).version, (await read("identity.md")).content]).toEqual([
        1,
        IDENTITY,
      ]);
      // The talking member holds no governing grant.
      expect(
        await change("cs-x", [{ op: "create", path: "goals.md", content: "x" }], MEMBER),
      ).toEqual({ status: 403, body: { error: "authorization_refused" } });
      expect(
        (await change("cs-3", [{ op: "archive", path: "goals.md", expectedVersion: 1 }])).status,
      ).toBe(200);

      // Two sessions. A model proposal writes its own session's summary; one naming the protected
      // policy is refused with evidence while its turn still answers.
      const open = async () =>
        decodeConversationSession(
          (await post("/v1/runtime/conversations/create", { actorId: "fixture.keeper" })).body,
        ).sessionId;
      const a = await open();
      const b = await open();
      const talk = async (sessionId: string, messageId: string, text: string) => {
        const answer = await post("/v1/runtime/talk", { sessionId, messageId, text });
        expect(answer.status).toBe(200);
      };
      await talk(b, "b1", `fixture:propose sessions/${b}/summary.md\nB is about snacks.`);
      await talk(a, "a1", REFUSED);
      await talk(a, "a2", "How many acorns?");
      const summary = await read(`sessions/${b}/summary.md`);
      expect([summary.version, summary.proposer, summary.writeClass, summary.content]).toEqual([
        1,
        "model",
        "actor_writable",
        "B is about snacks.",
      ]);
      expect([(await read("policy.md")).version, (await read("policy.md")).content]).toEqual([
        1,
        POLICY,
      ]);
      expect(
        (
          await owner.sql(
            `SELECT string_agg(change_set_id || ':' || proposer || ':' || status || ':' ||
                      coalesce(refusal_code, '-') || ':' || coalesce(refused_operation::text, '-'),
                      ' ' ORDER BY created_at)
               FROM clockgrove.document_change_sets
              WHERE proposer = 'model' OR change_set_id LIKE 'cs-%'`,
          )
        )
          .trim()
          .replace(/run-[0-9a-f-]+/g, "run"),
      ).toBe(
        [
          "cs-1:operator:committed:-:-",
          "cs-2:operator:refused:version_conflict:2",
          "cs-3:operator:committed:-:-",
          "run:documents:model:committed:-:-",
          "run:documents:model:refused:write_class_refused:1",
        ].join(" "),
      );

      // The inspector opens turn 2 of session A: every candidate, its version, trust and decision.
      const inspect = async (credential: string) => {
        const answer = await post(
          "/v1/runtime/context/inspect",
          { sessionId: a, turn: 2 },
          credential,
        );
        expect(answer.status).toBe(200);
        return answer.body as ContextInspection;
      };
      const { manifest, reassembledHash } = await inspect(OPERATOR);
      const doc = (path: string, version: number, writeClass: string, hash: string) => ({
        source: "document",
        sourceId: expect.stringMatching(/^document-/),
        version,
        label: path,
        scope: path.startsWith("sessions/") ? "session" : "actor",
        writeClass,
        sessionId: path.startsWith("sessions/") ? b : null,
        sourceHash: hash,
        trust: writeClass === "actor_writable" ? "untrusted" : "trusted",
      });
      const said = (source: string, id: string, version: number, label: string, text: string) => ({
        source,
        sourceId: id,
        version,
        label,
        scope: "session",
        writeClass: null,
        sessionId: a,
        state: "active",
        sourceHash: sha(text),
        tokens: Math.ceil(Buffer.byteLength(text) / 4),
        trust: "untrusted",
      });
      const included = (section: string, promptOrder: number) => ({
        decision: "included",
        rule: null,
        section,
        promptOrder,
      });
      const excluded = (rule: string) => ({
        decision: "excluded",
        rule,
        section: null,
        promptOrder: null,
      });
      expect([manifest.inputRevision, manifest.tokenBudget, manifest.tokensUsed]).toEqual([
        2, 4096, 2090,
      ]);
      expect(manifest.entries).toEqual([
        {
          ...doc("identity.md", 1, "protected", sha(IDENTITY)),
          state: "active",
          tokens: 8,
          ...included("protected", 1),
        },
        {
          ...doc("policy.md", 1, "protected", sha(POLICY)),
          state: "active",
          tokens: 2048,
          ...included("protected", 2),
        },
        // Never read: its exclusion and hash come from metadata alone.
        {
          ...doc("goals.md", 2, "governed", sha(GOALS)),
          state: "archived",
          tokens: 0,
          ...excluded("document_archived"),
        },
        {
          ...doc("working-context.md", 1, "actor_writable", sha(LEDGER)),
          state: "active",
          tokens: 2048,
          ...excluded("token_budget"),
        },
        // Redacted: session B's ID, hash and size never reach session A's manifest.
        {
          ...doc("sessions/*/summary.md", 1, "actor_writable", sha("B is about snacks.")),
          sessionId: null,
          sourceHash: null,
          state: "active",
          tokens: 0,
          ...excluded("other_session_private"),
        },
        { ...said("message", "a1:reply", 2, "actor", REPLY), ...included("untrusted", 4) },
        { ...said("message", "a1", 1, "caretaker", REFUSED), ...included("untrusted", 3) },
        { ...said("input", "a2", 3, "caretaker", "How many acorns?"), ...included("untrusted", 5) },
      ]);
      // Only a participant who may read the session's text gets the context assembled again.
      expect(reassembledHash).toBeNull();

      // Later writes and turns change nothing recorded: the same revision assembles the same context.
      await change("cs-4", [
        { op: "patch", path: "working-context.md", expectedVersion: 1, content: "Short ledger." },
      ]);
      await talk(a, "a3", "And tomorrow?");
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET privacy_ceiling =
           '{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}',
           grants = array_append(grants, 'runtime:world-inspect')
          WHERE principal_id = 'principal-runtime'`,
      );
      const first = await inspect(MEMBER);
      const second = await inspect(MEMBER);
      expect([first.reassembledHash, second.reassembledHash, first.manifest]).toEqual([
        manifest.manifestHash,
        manifest.manifestHash,
        manifest,
      ]);

      // The prompt includes Keeper's documents, so it is private cognition: a conversation-only
      // inspector sees its manifest above and its class here, never its text.
      const walkOf = async () =>
        (await post("/v1/runtime/runs/inspect", { runId: manifest.runId }, MEMBER)).body as RunWalk;
      const hidden = await walkOf();
      expect([
        hidden.runs[0]?.prompt,
        hidden.runs[0]?.steps.find((s) => s.kind === "model_attempt")?.input,
      ]).toEqual([
        {
          artifactId: `${a}:prompt:${manifest.runId}`,
          privacyClass: "private_cognition",
          text: null,
        },
        {
          artifactId: `${a}:prompt:${manifest.runId}`,
          privacyClass: "private_cognition",
          text: null,
        },
      ]);
      expect(JSON.stringify(hidden).includes("careful resident")).toBe(false);

      // With `private_cognition` too, the participant reads the exact prompt: protected policy only
      // in the protected section, untrusted parts labelled.
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET privacy_ceiling =
           '{"version":1,"allowedCategories":["public_scene","conversation","private_cognition","operator_evidence"]}'
          WHERE principal_id = 'principal-runtime'`,
      );
      const walk = await walkOf();
      expect(walk.runs[0]?.prompt?.privacyClass).toBe("private_cognition");
      const prompt = JSON.parse(walk.runs[0]?.prompt?.text ?? "{}");
      expect([prompt.protected, prompt.governed, prompt.untrusted]).toEqual([
        [
          { source: "identity.md", version: 1, text: IDENTITY },
          { source: "policy.md", version: 1, text: POLICY },
        ],
        [],
        [
          { trust: "untrusted", source: "caretaker", version: 1, text: REFUSED },
          { trust: "untrusted", source: "actor", version: 2, text: REPLY },
          { trust: "untrusted", source: "caretaker", version: 3, text: "How many acorns?" },
        ],
      ]);
      expect(walk.runs[0]?.steps.map((s) => [s.step, s.kind, s.status])).toEqual([
        [1, "context_retrieval", "succeeded"],
        [2, "model_attempt", "succeeded"],
        [3, "commit", "succeeded"],
      ]);

      // Private cognition never enters scene state or the journal.
      const scene = await post("/v1/runtime/scene", {});
      const journal = await owner.sql(
        "SELECT count(*) FROM clockgrove.events WHERE payload::text LIKE '%careful resident%' OR payload::text LIKE '%snacks%'",
      );
      expect([
        scene.status,
        JSON.stringify(scene.body).includes("careful resident"),
        JSON.stringify(scene.body).includes("Acorn ledger"),
        journal.trim(),
      ]).toEqual([200, false, false, "0"]);
    });
  },
  180_000,
);
