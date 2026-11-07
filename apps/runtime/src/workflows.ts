import {
  type GenesisBirth,
  type ProvisionedWorld,
  type ProvisioningArtifact,
  type ProvisioningResourceKind,
  type ProvisionWorldRequest,
  provisionWorldToVerified,
  readyProvisionedWorld,
  type WorldGenesisPort,
  type WorldProvisioningPorts,
} from "@clockgrove/application";
import type { RunId } from "@clockgrove/contracts";
import { sha256Hex } from "@clockgrove/kernel";
import { createSimulatorPackPorts, seedGenesis } from "@clockgrove/simulator";
import { type ResourceEntry, validateWorldPack } from "@clockgrove/world-pack-sdk";

import { stableWorkflowInstanceId } from "./routing.js";

export interface WorkflowShellInput<TPayload = unknown> {
  readonly applicationRunId: RunId;
  readonly payload: TPayload;
}

export interface WorkflowShellResult {
  readonly instanceId: string;
  readonly disposition: "shell-only";
}

abstract class WorkflowShell {
  protected abstract readonly workflowName: string;

  async run(input: WorkflowShellInput): Promise<WorkflowShellResult> {
    return {
      instanceId: await stableWorkflowInstanceId(this.workflowName, input.applicationRunId),
      disposition: "shell-only",
    };
  }
}

export class WorldProvisioningWorkflow {
  run(request: ProvisionWorldRequest, ports: WorldProvisioningPorts): Promise<void> {
    return provisionWorldToVerified(request, ports);
  }
}

export class WorldReadinessWorkflow {
  run(request: ProvisionWorldRequest, ports: WorldProvisioningPorts): Promise<ProvisionedWorld> {
    return readyProvisionedWorld(request, ports);
  }
}
export class WorldPackUpgradeWorkflow extends WorkflowShell {
  protected override readonly workflowName = "WorldPackUpgradeWorkflow";
}
export class IngestionWorkflow extends WorkflowShell {
  protected override readonly workflowName = "IngestionWorkflow";
}
export class ConsolidationWorkflow extends WorkflowShell {
  protected override readonly workflowName = "ConsolidationWorkflow";
}
export class AuthoringWorkflow extends WorkflowShell {
  protected override readonly workflowName = "AuthoringWorkflow";
}
export class AgentJobWorkflow extends WorkflowShell {
  protected override readonly workflowName = "AgentJobWorkflow";
}
export class TransferRecoveryWorkflow extends WorkflowShell {
  protected override readonly workflowName = "TransferRecoveryWorkflow";
}

/** Seeds a pack's world birth, as the application's genesis port returns it. */
export async function seedProvisioningBirth(
  artifact: ProvisioningArtifact,
  source: unknown,
): ReturnType<WorldGenesisPort["seed"]> {
  const hashPorts = { sha256: async (bytes: Uint8Array) => sha256Hex(bytes) };
  const seeded = await seedGenesis({ artifact, source }, hashPorts);
  if (!seeded.ok) {
    const { code, path, message } = seeded.error;
    return {
      ok: false,
      refusal: { code, path, message },
      ...(seeded.defect === true ? { defect: true } : {}),
    };
  }
  const validated = await validateWorldPack(source, createSimulatorPackPorts(hashPorts));
  if (!validated.ok) throw new Error(`pack validation failed: ${validated.error.code}`);
  const pack = validated.value;
  // Both simulator and SDK validation have accepted this exact resource inventory.
  const { resources } = source as {
    readonly resources: Readonly<Record<string, Uint8Array>>;
  };
  const { bundle } = seeded.value;
  const kinds: readonly (readonly [ProvisioningResourceKind, readonly ResourceEntry[]])[] = [
    ["archetypes", pack.archetypes],
    ["traits", pack.traits],
    ["actors", pack.actors],
    ["policies", pack.policies],
    ["cognitiveSeeds", pack.cognitiveSeeds],
    ["spaces", pack.spaces],
    ["rules", pack.ruleEntries],
  ];
  const birth: GenesisBirth = {
    artifact,
    world: bundle.world,
    spaces: pack.spaces.map((space) => ({ spaceId: space.id, frameId: space.frame.frameId })),
    clock: pack.clockPolicy,
    cognitiveSeeds: pack.cognitiveSeeds,
    resources: kinds.flatMap(([kind, entries]) =>
      entries.map((entry) => {
        const bytes = resources[entry.path];
        if (bytes === undefined) throw new Error(`pack source lacks ${entry.path}`);
        return {
          kind,
          id: entry.id,
          version: entry.version,
          path: entry.path,
          sha256: entry.sha256,
          bytes,
        };
      }),
    ),
    genesisCommandId: bundle.genesisCommandId,
    seedCommands: bundle.seedCommands,
    events: bundle.events,
    schedules: bundle.schedules,
    state: bundle.state,
    randomState: bundle.randomState,
    expectedSeedProjectionHash: pack.expectedSeedProjectionHash,
  };
  return { ok: true, birth };
}
