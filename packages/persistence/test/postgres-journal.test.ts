import type { JournalExecuteRequest } from "@clockgrove/application";
import { CommandIdempotencyInvariantError } from "@clockgrove/contracts";
import { describe, expect, it, vi } from "vitest";

import { type PostgreSqlClient, PostgreSqlJournal } from "../src/index.js";

describe("PostgreSQL journal adapter", () => {
  it("commits before best-effort notification and ignores notification failure", async () => {
    const calls: string[] = [];
    const client: PostgreSqlClient = {
      async query(text) {
        calls.push(text);
        if (text.includes("execute_journal")) {
          return { rows: [{ result: { value: { ok: true }, events: [], projectionDelta: null } }] };
        }
        return { rows: [] };
      },
    };
    const notify = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const result = await new PostgreSqlJournal(client, { notify }).execute(request());
    expect(result.value).toEqual({ ok: true });
    expect(calls.at(-1)).toBe("COMMIT");
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not roll back a simulated lost response after commit", async () => {
    const calls: string[] = [];
    const client: PostgreSqlClient = {
      async query(text) {
        calls.push(text);
        return text.includes("execute_journal")
          ? { rows: [{ result: { value: { ok: true }, events: [], projectionDelta: null } }] }
          : { rows: [] };
      },
    };
    const journal = new PostgreSqlJournal(client, undefined, {
      afterCommit: () => Promise.reject(new Error("response lost")),
    });
    await expect(journal.execute(request())).rejects.toThrow("response lost");
    expect(calls).toContain("COMMIT");
    expect(calls).not.toContain("ROLLBACK");
  });

  it("maps the database byte mismatch to the accepted invariant error", async () => {
    const client: PostgreSqlClient = {
      async query(text) {
        if (text.includes("execute_journal")) {
          throw Object.assign(new Error("mismatch"), { code: "CG001" });
        }
        return { rows: [] };
      },
    };
    await expect(new PostgreSqlJournal(client).execute(request())).rejects.toBeInstanceOf(
      CommandIdempotencyInvariantError,
    );
  });
});

function request(): JournalExecuteRequest<string, unknown, { readonly ok: boolean }> {
  return {
    authorization: {
      tenantId: "tenant-a",
      principalId: "principal-a",
      privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
    },
    command: {
      schemaVersion: 2,
      commandId: "command-a",
      type: "Fixture",
      target: {
        version: 1,
        tenantId: "tenant-a",
        worldId: "world-a",
        timelineId: "timeline-a",
        kind: "world",
        id: "world-a",
      },
      expected: {},
      issuedAt: "2026-09-29T00:00:00.000Z",
      context: { version: 1, contextId: "context-a" },
      attribution: {
        effectiveActorId: "world-a",
        causalRootActionId: "action-a",
      },
      payload: {},
    },
    commandBytes: new TextEncoder().encode("command"),
    route: { partitionId: "partition-a", spaceId: "space-a", streamId: "stream-a" },
    events: [],
    dispatches: [],
    stableResult: { ok: true },
    projectionDelta: null,
  } as unknown as JournalExecuteRequest<string, unknown, { readonly ok: boolean }>;
}
