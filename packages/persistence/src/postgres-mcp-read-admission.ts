import type { AdmittedMcpRead } from "@clockgrove/application";
import type { EffectIntentMetadata, RecordedEffect } from "./postgres-effects.js";
import {
  type McpReadReservation,
  type McpReadSwitch,
  PostgreSqlMcpAdmission,
} from "./postgres-mcp-admission.js";
import type { PostgreSqlClient } from "./postgres-transaction.js";

export {
  MCP_READ_TURN_DEFAULTS,
  type McpReadReservation,
  type McpReadSwitch,
  type McpReadTurnPolicy,
} from "./postgres-mcp-admission.js";

/** Internal privileged read admission. A write reservation cannot enter the read adapter. */
export class PostgreSqlMcpReadAdmission {
  private readonly admission: PostgreSqlMcpAdmission;
  constructor(client: PostgreSqlClient, preflight?: (request: AdmittedMcpRead) => Promise<void>) {
    this.admission = new PostgreSqlMcpAdmission(
      client,
      "read",
      preflight ? (request) => preflight({ ...request, admittedReadOnly: true }) : undefined,
    );
  }
  setSwitch(target: McpReadSwitch, disabled: boolean): Promise<void> {
    return this.admission.setSwitch(target, disabled);
  }
  reserve(request: McpReadReservation): Promise<RecordedEffect> {
    return this.admission.reserve(request);
  }
  async admit(intent: EffectIntentMetadata, input: unknown): Promise<AdmittedMcpRead | null> {
    const request = await this.admission.admit(intent, input);
    return request ? { ...request, admittedReadOnly: true } : null;
  }
}
