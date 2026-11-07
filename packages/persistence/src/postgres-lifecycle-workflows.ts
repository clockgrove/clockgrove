import {
  decodeLifecycleWorkflowEnvelope,
  decodeStoredProvisioningRequest,
  type LifecycleWorkflowEnvelope,
  type LifecycleWorkflowStatus,
  type LifecycleWorkflowStore,
  lifecycleRecord,
  MAX_STORED_PROVISIONING_SOURCE_BYTES,
  ProvisioningCaseConflictError,
  type ProvisionWorldRequest,
  provisioningRequestHash,
  storedProvisioningRequest,
  storedProvisioningRequestIdentity,
  WorldProvisioningRefusedError,
} from "@clockgrove/application";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";
import { PostgreSqlWorldProvisioningStore } from "./postgres-world-provisioning.js";

/** Durable links live on the canonical case, independent of provider execution history. */
export class PostgreSqlLifecycleWorkflowStore implements LifecycleWorkflowStore {
  constructor(private readonly client: PostgreSqlClient) {}

  async register(
    request: ProvisionWorldRequest,
    applicationRunId: string,
  ): Promise<LifecycleWorkflowEnvelope> {
    const envelope = decodeLifecycleWorkflowEnvelope({
      version: 1,
      tenantId: request.authorization.tenantId,
      caseId: request.caseId,
      applicationRunId,
    });
    const document = storedProvisioningRequest(request);
    if (document.sourceBytes.byteLength > MAX_STORED_PROVISIONING_SOURCE_BYTES) {
      throw new WorldProvisioningRefusedError(
        "LIMIT_EXCEEDED",
        "source.resources",
        `pack source bytes exceed the ${MAX_STORED_PROVISIONING_SOURCE_BYTES}-byte durable birth limit`,
      );
    }
    const identity = storedProvisioningRequestIdentity(document);
    // Decode once at the trust boundary, before a malformed request can create a case.
    decodeStoredProvisioningRequest(
      document.request,
      identity,
      document.source,
      document.sourceBytes,
    );
    await withClientTransaction(this.client, { authorization: request.authorization }, async () => {
      await this.client.query(
        `INSERT INTO clockgrove_birth.provisioning_cases
           (tenant_id, case_id, request_hash, pack_id, pack_version, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, case_id) DO NOTHING`,
        [
          envelope.tenantId,
          envelope.caseId,
          provisioningRequestHash(request),
          request.artifact.packId,
          request.artifact.version,
          request.artifact.contentHash,
        ],
      );
      const found = await this.client.query(
        `SELECT request_hash, workflow_run_id, workflow_request_hash FROM clockgrove_birth.provisioning_cases
          WHERE tenant_id = $1 AND case_id = $2 FOR UPDATE`,
        [envelope.tenantId, envelope.caseId],
      );
      const existing = lifecycleRecord(found.rows[0], "case");
      if (existing.request_hash !== provisioningRequestHash(request)) {
        throw new ProvisioningCaseConflictError(envelope.tenantId, envelope.caseId);
      }
      if (existing.workflow_run_id !== null) {
        if (
          existing.workflow_run_id !== applicationRunId ||
          existing.workflow_request_hash !== identity
        ) {
          throw new ProvisioningCaseConflictError(envelope.tenantId, envelope.caseId);
        }
        return;
      }
      try {
        await this.client.query(
          `UPDATE clockgrove_birth.provisioning_cases
              SET workflow_run_id = $3, workflow_request_hash = $4, workflow_request = $5::jsonb,
                  workflow_source = $6::jsonb, workflow_source_bytes = $7
            WHERE tenant_id = $1 AND case_id = $2`,
          [
            envelope.tenantId,
            envelope.caseId,
            applicationRunId,
            identity,
            JSON.stringify(document.request),
            JSON.stringify(document.source),
            document.sourceBytes,
          ],
        );
      } catch (error) {
        // This update changes only the launch fields; their only unique key is the run identity.
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505"
        ) {
          throw new ProvisioningCaseConflictError(envelope.tenantId, envelope.caseId);
        }
        throw error;
      }
    });
    return envelope;
  }

  /** Picks and stamps open registered cases not stopped by a genesis defect, least recently picked first. */
  async openCases(limit: number): Promise<readonly LifecycleWorkflowEnvelope[]> {
    return withClientTransaction(this.client, {}, async () => {
      const result = await this.client.query(
        `SELECT tenant_id, case_id, workflow_run_id FROM clockgrove_birth.open_workflow_cases($1)`,
        [limit],
      );
      return result.rows.map((value) => {
        const open = lifecycleRecord(value, "case");
        return decodeLifecycleWorkflowEnvelope({
          version: 1,
          tenantId: open.tenant_id,
          caseId: open.case_id,
          applicationRunId: open.workflow_run_id,
        });
      });
    });
  }

  async read(value: LifecycleWorkflowEnvelope): Promise<ProvisionWorldRequest> {
    const envelope = decodeLifecycleWorkflowEnvelope(value);
    const result = await this.client.query(
      `SELECT request, request_hash, source, source_bytes
         FROM clockgrove_birth.read_workflow_request($1, $2, $3)`,
      [envelope.tenantId, envelope.caseId, envelope.applicationRunId],
    );
    if (result.rows[0] === undefined)
      throw new ProvisioningCaseConflictError(envelope.tenantId, envelope.caseId);
    const stored = lifecycleRecord(result.rows[0], "workflow");
    return decodeStoredProvisioningRequest(
      stored.request,
      String(stored.request_hash),
      stored.source,
      stored.source_bytes,
    );
  }

  async status(envelope: LifecycleWorkflowEnvelope): Promise<LifecycleWorkflowStatus> {
    const request = await this.read(envelope);
    return withClientTransaction(
      this.client,
      { authorization: request.authorization },
      async () => {
        const result = await this.client.query(
          `SELECT status, world_id FROM clockgrove_birth.provisioning_cases WHERE tenant_id = $1 AND case_id = $2`,
          [envelope.tenantId, envelope.caseId],
        );
        const stored = lifecycleRecord(result.rows[0], "case");
        const status = stored.status;
        if (
          status !== "requested" &&
          status !== "seeding" &&
          status !== "verified" &&
          status !== "ready" &&
          status !== "failed"
        )
          throw new TypeError("Unknown provisioning status");
        if (typeof stored.world_id !== "string") return { status, receiptCommandIds: [] };
        const receipts = await this.client.query(
          `SELECT DISTINCT receipt.command_id
           FROM clockgrove.events AS event
           JOIN clockgrove.command_receipts AS receipt
             ON receipt.tenant_id = event.tenant_id AND receipt.command_id = event.command_id
          WHERE event.tenant_id = $1 AND event.world_id = $2
            AND event.event_type IN ('WorldGenesisCreated', 'WorldSeedCommandApplied',
              'WorldProjectionVerified', 'WorldReady') AND receipt.status = 'committed'
          ORDER BY receipt.command_id`,
          [envelope.tenantId, stored.world_id],
        );
        const receiptCommandIds = receipts.rows.map((value) => {
          const receipt = lifecycleRecord(value, "receipt");
          if (typeof receipt.command_id !== "string")
            throw new TypeError("Invalid receipt command identity");
          return receipt.command_id;
        });
        return { status, worldId: stored.world_id, receiptCommandIds };
      },
    );
  }

  async cancel(envelope: LifecycleWorkflowEnvelope): Promise<void> {
    const request = await this.read(envelope);
    await new PostgreSqlWorldProvisioningStore(this.client).recordFailure({
      authorization: request.authorization,
      caseId: request.caseId,
      refusal: {
        code: "PROVISIONING_CANCELLED",
        path: "workflow",
        message: "Trusted orchestration cancelled the provisioning case",
      },
    });
  }
}
