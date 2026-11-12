import { type PrincipalId } from "@clockgrove/contracts";
import {
  AuthenticationRefusedError,
  type AuthProviderPort,
  type PrincipalMappingPort,
  resolveRuntimePrincipal,
} from "./authentication.js";

/** Atomic, durable reservation across every credential and scope belonging to a principal. */
export interface WorldMcpAdmissionStore {
  reserve(
    principalId: PrincipalId,
    phase: "exchange" | "body",
    workUnits: number,
  ): Promise<boolean>;
}

export class WorldMcpAdmissionRefusedError extends Error {
  override readonly name = "WorldMcpAdmissionRefusedError";
  constructor(readonly code: "mcp_rate_limited" | "mcp_admission_unavailable") {
    super(code);
  }
}

export class WorldMcpAdmission {
  constructor(
    private readonly ports: {
      readonly provider: AuthProviderPort;
      readonly mapping: PrincipalMappingPort;
      readonly store: WorldMcpAdmissionStore;
    },
  ) {}

  private async authenticate(credential: string): Promise<PrincipalId> {
    try {
      if (!/^\S+$/u.test(credential)) throw new Error("invalid credential");
      return await resolveRuntimePrincipal(
        await this.ports.provider.authenticate(credential),
        this.ports.mapping,
      );
    } catch {
      throw new AuthenticationRefusedError("authentication refused");
    }
  }

  async begin(credential: string): Promise<PrincipalId> {
    const principalId = await this.authenticate(credential);
    await this.reserve(principalId, "exchange", 1);
    return principalId;
  }

  async chargeBody(principalId: PrincipalId, requestBytes: number): Promise<void> {
    // Decision: charge each started 4 KiB, including refused inputs. This bounds local input
    // work, not monetary model spend; current internal tools invoke no models.
    if (!Number.isSafeInteger(requestBytes) || requestBytes < 0 || requestBytes > 128 * 1024)
      throw new WorldMcpAdmissionRefusedError("mcp_admission_unavailable");
    await this.reserve(principalId, "body", Math.ceil(requestBytes / 4096));
  }

  private async reserve(
    principalId: PrincipalId,
    phase: "exchange" | "body",
    workUnits: number,
  ): Promise<void> {
    let admitted: boolean;
    try {
      admitted = await this.ports.store.reserve(principalId, phase, workUnits);
    } catch {
      throw new WorldMcpAdmissionRefusedError("mcp_admission_unavailable");
    }
    if (!admitted) throw new WorldMcpAdmissionRefusedError("mcp_rate_limited");
  }
}
