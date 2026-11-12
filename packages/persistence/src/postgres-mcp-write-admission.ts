import type { EffectApprovalBinding } from "./postgres-effect-approvals.js";
import type { EffectIntentMetadata, RecordedEffect } from "./postgres-effects.js";
import {
  type AdmittedMcpCall,
  type McpReadReservation,
  PostgreSqlMcpAdmission,
} from "./postgres-mcp-admission.js";
import type { PostgreSqlClient } from "./postgres-transaction.js";
export interface McpWriteReservation extends McpReadReservation {
  readonly approval: EffectApprovalBinding;
}
export type AdmittedMcpWrite = AdmittedMcpCall;

/** Privileged session-person write admission only. Human decisions come from trusted composition;
 * no write transport or model tool is installed by this port. */
export class PostgreSqlMcpWriteAdmission {
  private readonly admission: PostgreSqlMcpAdmission;
  constructor(client: PostgreSqlClient, preflight?: (request: AdmittedMcpWrite) => Promise<void>) {
    this.admission = new PostgreSqlMcpAdmission(client, "write", preflight);
  }
  reserve(request: McpWriteReservation): Promise<RecordedEffect> {
    return this.admission.reserve({ ...request, admissionKind: "write" });
  }
  admit(intent: EffectIntentMetadata, input: unknown): Promise<AdmittedMcpWrite | null> {
    return this.admission.admit(intent, input);
  }
}
