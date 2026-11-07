import {
  type DocumentCandidate,
  operationRefusal,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import {
  type BrowserScope,
  type ContextInspectRequest,
  type ContextManifest,
  type ContextManifestEntry,
  type DocumentChangeReceipt,
  type DocumentOperation,
  type DocumentRefusalCode,
  type DocumentVersionRef,
  type DocumentVersionView,
  MAX_CHANGE_SET_OPERATIONS,
  MAX_DOCUMENT_VERSIONS,
  resolveDocumentPath,
} from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;

const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;

/** Who proposes a change set: an operator, or the model of one run in its session. */
export type DocumentProposer =
  | { readonly kind: "operator" }
  | { readonly kind: "model"; readonly runId: string; readonly sessionId: string };

export interface DocumentChange {
  readonly tenantId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly actorId: string;
  readonly changeSetId: string;
  readonly principalId: string;
  readonly personaId: string | null;
  readonly proposer: DocumentProposer;
  readonly operations: readonly DocumentOperation[];
}

export type DocumentChangeOutcome =
  | DocumentChangeReceipt
  | {
      readonly changeSetId: string;
      readonly status: "refused";
      readonly code: DocumentRefusalCode;
      /** The operation (from 1) that caused the refusal, when one did. */
      readonly operation: number | null;
    };

class Refusal extends Error {
  constructor(
    readonly code: DocumentRefusalCode,
    readonly operation: number | null,
  ) {
    super(code);
  }
}

/** SQL refusals of 0037's guards, as change-set refusal codes. */
const GUARD_CODES: Readonly<Record<string, DocumentRefusalCode>> = {
  CG022: "document_limit_reached",
  CG023: "write_class_refused",
  CG024: "version_conflict",
};

/**
 * Governed actor documents over migration 0037. A change set is all or nothing: it runs in a
 * savepoint of the caller's transaction, and a refusal rolls its writes back and records the
 * refused change set as evidence instead. The guards in SQL hold write classes, version order and
 * limits for every writer; these checks name the refusal first.
 */
export class PostgreSqlActorDocuments {
  constructor(private readonly client: PostgreSqlClient) {}

  /** An operator change set in its own transaction. */
  change(
    authorization: RuntimeAuthorizationContext,
    change: DocumentChange,
  ): Promise<DocumentChangeOutcome> {
    return withClientTransaction(this.client, { authorization }, () => this.apply(change));
  }

  /** Applies a change set inside the caller's transaction, or records its refusal there. */
  async apply(change: DocumentChange): Promise<DocumentChangeOutcome> {
    await this.client.query("SAVEPOINT document_change_set");
    try {
      const documents = await this.write(change);
      await this.client.query("RELEASE SAVEPOINT document_change_set");
      return { changeSetId: change.changeSetId, status: "committed", documents };
    } catch (error) {
      await this.client.query("ROLLBACK TO SAVEPOINT document_change_set");
      const refusal = refusalOf(error);
      if (refusal === undefined) throw error;
      // A reused ID already names its own evidence; any other refusal is recorded.
      if (refusal.code !== "change_set_reused") await this.record(change, "refused", refusal);
      return {
        changeSetId: change.changeSetId,
        status: "refused",
        code: refusal.code,
        operation: refusal.operation,
      };
    }
  }

  /** Metadata of every document of the session's actor, before any text is read (0037). */
  async candidates(tenantId: string, sessionId: string): Promise<readonly DocumentCandidate[]> {
    const found = await this.client.query(
      `SELECT * FROM clockgrove.actor_context_candidates($1, $2)`,
      [tenantId, sessionId],
    );
    return (found.rows as Row[]).map((row) => ({
      documentId: String(row.document_id),
      path: String(row.path),
      kind: row.kind as DocumentCandidate["kind"],
      writeClass: row.write_class as DocumentCandidate["writeClass"],
      sessionId: row.session_id === null ? null : String(row.session_id),
      state: row.state as DocumentCandidate["state"],
      version: Number(row.version),
      sourceHash: String(row.source_hash),
    }));
  }

  /** One version's text, as RLS admits it to the caller; undefined when it is not visible. */
  async content(
    tenantId: string,
    documentId: string,
    version: number,
  ): Promise<string | undefined> {
    const found = await this.client.query(
      `SELECT content FROM clockgrove.actor_document_versions
        WHERE tenant_id = $1 AND document_id = $2 AND version = $3`,
      [tenantId, documentId, version],
    );
    const row = found.rows[0] as Row | undefined;
    return row === undefined ? undefined : String(row.content);
  }

  /** A document's version (its head when none is named) with its provenance. */
  async read(
    authorization: RuntimeAuthorizationContext,
    scope: BrowserScope,
    actorId: string,
    path: string,
    version?: number,
  ): Promise<DocumentVersionView | undefined> {
    return withClientTransaction(this.client, { authorization }, async () => {
      const found = await this.client.query(
        `SELECT document.document_id, document.path, document.kind, document.write_class,
                document.actor_id, version.version, version.state, version.source_hash,
                version.byte_length, version.content, version.change_set_id,
                change.proposer, change.principal_id, change.run_id, ${timestamp("version.created_at")}
           FROM clockgrove.actor_documents AS document
           JOIN clockgrove.actor_document_versions AS version
             ON version.tenant_id = document.tenant_id AND version.document_id = document.document_id
            AND version.version = coalesce($6::integer, document.current_version)
           JOIN clockgrove.document_change_sets AS change
             ON change.tenant_id = version.tenant_id AND change.change_set_id = version.change_set_id
          WHERE document.tenant_id = $1 AND document.world_id = $2 AND document.timeline_id = $3
            AND document.actor_id = $4 AND document.path = $5`,
        [scope.tenantId, scope.worldId, scope.timelineId, actorId, path, version ?? null],
      );
      const row = found.rows[0] as Row | undefined;
      if (row === undefined) return undefined;
      return {
        documentId: String(row.document_id),
        path: String(row.path),
        version: Number(row.version),
        state: row.state as "active" | "archived",
        sourceHash: String(row.source_hash),
        actorId: String(row.actor_id),
        kind: row.kind as DocumentVersionView["kind"],
        writeClass: row.write_class as DocumentVersionView["writeClass"],
        byteLength: Number(row.byte_length),
        content: String(row.content),
        changeSetId: String(row.change_set_id),
        proposer: row.proposer as "operator" | "model",
        principalId: String(row.principal_id),
        runId: row.run_id === null ? null : String(row.run_id),
        createdAt: String(row.created_at),
      };
    });
  }

  private async write(change: DocumentChange): Promise<readonly DocumentVersionRef[]> {
    if (change.operations.length > MAX_CHANGE_SET_OPERATIONS)
      throw new Refusal("change_set_too_large", null);
    const proposer =
      change.proposer.kind === "model"
        ? { kind: "model" as const, sessionId: change.proposer.sessionId }
        : { kind: "operator" as const };
    const paths = new Set<string>();
    change.operations.forEach((operation, index) => {
      const code = operationRefusal(operation, proposer);
      if (code !== undefined) throw new Refusal(code, index + 1);
      // Each document changes at most once a change set, so every expected version is the head's.
      if (paths.has(operation.path)) throw new Refusal("version_conflict", index + 1);
      paths.add(operation.path);
    });
    await this.record(change, "committed");
    const written: DocumentVersionRef[] = [];
    for (const [index, operation] of change.operations.entries()) {
      try {
        written.push(await this.operate(change, operation, index + 1));
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && GUARD_CODES[code] !== undefined)
          throw new Refusal(GUARD_CODES[code], index + 1);
        throw error;
      }
    }
    return written;
  }

  private async operate(
    change: DocumentChange,
    operation: DocumentOperation,
    position: number,
  ): Promise<DocumentVersionRef> {
    const target = resolveDocumentPath(operation.path);
    if (target === undefined) throw new Refusal("document_path_invalid", position);
    const found = await this.client.query(
      `SELECT document_id, state, current_version FROM clockgrove.actor_documents
        WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND actor_id = $4 AND path = $5
        FOR UPDATE`,
      [change.tenantId, change.worldId, change.timelineId, change.actorId, operation.path],
    );
    const existing = found.rows[0] as Row | undefined;
    let documentId: string;
    let next: number;
    let content: string;
    let state: "active" | "archived" = "active";
    if (operation.op === "create") {
      if (existing !== undefined) throw new Refusal("document_exists", position);
      documentId = `document-${crypto.randomUUID()}`;
      await this.client.query(
        `INSERT INTO clockgrove.actor_documents (
           tenant_id, document_id, world_id, timeline_id, actor_id, path, kind, write_class,
           session_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          change.tenantId,
          documentId,
          change.worldId,
          change.timelineId,
          change.actorId,
          target.path,
          target.kind,
          target.writeClass,
          target.sessionId,
        ],
      );
      next = 1;
      content = operation.content;
    } else {
      if (existing === undefined) throw new Refusal("document_not_found", position);
      if (existing.state === "archived") throw new Refusal("document_archived", position);
      const current = Number(existing.current_version);
      if (current !== operation.expectedVersion) throw new Refusal("version_conflict", position);
      if (current >= MAX_DOCUMENT_VERSIONS) throw new Refusal("version_limit_reached", position);
      documentId = String(existing.document_id);
      next = current + 1;
      if (operation.op === "patch") content = operation.content;
      else {
        // Archiving keeps the text: the archived version is the last one's content.
        content = (await this.content(change.tenantId, documentId, current)) ?? "";
        state = "archived";
      }
    }
    const inserted = await this.client.query(
      `INSERT INTO clockgrove.actor_document_versions (
         tenant_id, document_id, version, world_id, timeline_id, actor_id, session_id, state,
         content, byte_length, source_hash, change_set_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, octet_length($9),
                 encode(sha256(convert_to($9, 'UTF8')), 'hex'), $10)
       RETURNING source_hash`,
      [
        change.tenantId,
        documentId,
        next,
        change.worldId,
        change.timelineId,
        change.actorId,
        target.sessionId,
        state,
        content,
        change.changeSetId,
      ],
    );
    return {
      documentId,
      path: target.path,
      version: next,
      state,
      sourceHash: String((inserted.rows[0] as Row).source_hash),
    };
  }

  private async record(
    change: DocumentChange,
    status: "committed" | "refused",
    refusal?: Refusal,
  ): Promise<void> {
    const model = change.proposer.kind === "model" ? change.proposer : undefined;
    try {
      await this.client.query(
        `INSERT INTO clockgrove.document_change_sets (
           tenant_id, change_set_id, world_id, timeline_id, actor_id, proposer, principal_id,
           persona_id, run_id, session_id, status, refusal_code, refused_operation,
           operation_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          change.tenantId,
          change.changeSetId,
          change.worldId,
          change.timelineId,
          change.actorId,
          change.proposer.kind,
          change.principalId,
          change.personaId,
          model?.runId ?? null,
          model?.sessionId ?? null,
          status,
          refusal?.code ?? null,
          refusal?.operation ?? null,
          change.operations.length,
        ],
      );
    } catch (error) {
      if ((error as { code?: unknown }).code === "23505")
        throw new Refusal("change_set_reused", null);
      throw error;
    }
  }
}

function refusalOf(error: unknown): Refusal | undefined {
  if (error instanceof Refusal) return error;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && GUARD_CODES[code] !== undefined)
    return new Refusal(GUARD_CODES[code], null);
  return undefined;
}

const MANIFEST_COLUMNS = `run_id, session_id, actor_id, input_message_id, input_revision,
  token_budget, tokens_used, manifest_hash, entries`;

/** Context manifests (0037): one immutable row per run, written with its context step. */
export class PostgreSqlContextManifests {
  constructor(private readonly client: PostgreSqlClient) {}

  async record(
    run: {
      readonly tenantId: string;
      readonly worldId: string;
      readonly timelineId: string;
      readonly spaceId: string;
    },
    manifest: ContextManifest,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO clockgrove.context_manifests (
         tenant_id, run_id, session_id, world_id, timeline_id, space_id, actor_id, input_message_id,
         input_revision, token_budget, tokens_used, manifest_hash, entries
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        run.tenantId,
        manifest.runId,
        manifest.sessionId,
        run.worldId,
        run.timelineId,
        run.spaceId,
        manifest.actorId,
        manifest.inputMessageId,
        manifest.inputRevision,
        manifest.tokenBudget,
        manifest.tokensUsed,
        manifest.manifestHash,
        JSON.stringify(manifest.entries),
      ],
    );
  }

  /** The manifest an entry names in the caller's scope, with whether the caller participates. */
  async find(
    scope: BrowserScope,
    entry: ContextInspectRequest["entry"],
  ): Promise<{ readonly manifest: ContextManifest; readonly participant: boolean } | undefined> {
    const [match, values] =
      "runId" in entry
        ? ["run_id = $5", [entry.runId]]
        : [
            `session_id = $5 AND run_id = (SELECT run_id FROM clockgrove.agent_runs
               WHERE tenant_id = $1 AND session_id = $5 AND turn = $6)`,
            [entry.sessionId, entry.turn],
          ];
    const found = await this.client.query(
      `SELECT ${MANIFEST_COLUMNS},
              clockgrove.runtime_conversation_participant(tenant_id, session_id) AS participant
         FROM clockgrove.context_manifests
        WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4 AND ${match}`,
      [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId, ...values],
    );
    const row = found.rows[0] as Row | undefined;
    if (row === undefined) return undefined;
    return {
      participant: row.participant === true,
      manifest: {
        runId: String(row.run_id),
        sessionId: String(row.session_id),
        actorId: String(row.actor_id),
        inputMessageId: String(row.input_message_id),
        inputRevision: Number(row.input_revision),
        tokenBudget: Number(row.token_budget),
        tokensUsed: Number(row.tokens_used),
        manifestHash: String(row.manifest_hash),
        entries: row.entries as ContextManifestEntry[],
      },
    };
  }
}
