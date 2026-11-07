import { buildWorldPack, NAMED_RANDOM_ALGORITHM } from "@clockgrove/world-pack-sdk";
import { createSimulatorPackPorts, runScenario } from "../../src/index.js";
import { type Json, sha256Hex } from "../fixtures/lamp-yard.js";
import {
  buildSectionYardSource,
  SECTION_EPOCH,
  type SectionYardOptions,
} from "../fixtures/section-yard.js";

export const ports = { sha256: sha256Hex };
export { SECTION_EPOCH };

/** The event types whose live and fast-forward streams the kernel declares materially equal. */
export const MATERIAL_TYPES = [
  "environment.phase-changed",
  "weather.transitioned",
  "exposure.threshold-crossed",
  "resource.spoiled",
  "resource.appeared",
  "growth.stage-changed",
  "needs.threshold-crossed",
  "comfort.changed",
  "health.threshold-crossed",
  "routine.selected",
];

const rule = (id: string, trigger: Json, rain: bigint): Json => ({
  schemaVersion: 1,
  id,
  version: 1,
  trigger,
  bindings: [],
  condition: null,
  intents: [
    {
      commandType: "world.weather.set",
      commandVersion: 2,
      payload: { rainIntensity: { op: "literal", type: "integer", value: rain } },
    },
  ],
  budget: { maxFanout: 2, maxDepth: 3, cooldownMs: 5n },
});

export interface YardOptions {
  readonly rules?: boolean;
  readonly edit?: SectionYardOptions["edit"];
}

/** The section yard with the lifecycle random stream the kernel requires, and optionally two rules. */
export async function yard(options: YardOptions = {}) {
  const source = await buildSectionYardSource({
    edit: (context) => {
      (context.manifest.randomStreams as Json[]).push({
        name: "lifecycle",
        algorithm: NAMED_RANDOM_ALGORITHM,
        algorithmVersion: 1,
        seed: "lifecycle-seed",
        state: [3, -5, 9, -2],
        draws: 0,
      });
      if (options.rules === true) {
        context.docs["rules/on-routine.json"] = rule(
          "yard.on-routine",
          { kind: "event", eventType: "routine.selected", eventVersion: 1 },
          1000n,
        );
        context.docs["rules/every-two.json"] = rule(
          "yard.every-two",
          { kind: "schedule", everyMs: 120000n, offsetMs: 0n },
          2000n,
        );
        (context.manifest.rules as Json[]).push(
          { id: "yard.on-routine", version: 1, path: "rules/on-routine.json" },
          { id: "yard.every-two", version: 1, path: "rules/every-two.json" },
        );
      }
      options.edit?.(context);
    },
  });
  const built = await buildWorldPack(source, createSimulatorPackPorts(ports));
  if (!built.ok) throw new Error(`fixture build failed: ${JSON.stringify(built.error)}`);
  return { source, artifact: built.value.artifact };
}

export const PACK = { id: "fixture.section-yard", version: "1.0.0" };

export const advance = (
  key: string,
  to: bigint,
  mode: "live" | "fast-forward",
  stepMs?: bigint,
): Json => ({
  kind: "advance",
  key,
  to,
  mode,
  ...(stepMs === undefined ? {} : { stepMs }),
});

export const rain = (key: string, rainIntensity: number): Json => ({
  kind: "command",
  key,
  type: "world.weather.set",
  version: 2,
  payload: { rainIntensity },
});

export function scenario(extra: Record<string, unknown> = {}): Json {
  return {
    kind: "clockgrove.scenario",
    schemaVersion: 1,
    name: "yard-day",
    pack: { ...PACK },
    steps: [advance("span", SECTION_EPOCH + 240000n, "live", 60000n)],
    ...extra,
  };
}

export async function run(input: { artifact: unknown; source: unknown; scenario: unknown }) {
  return runScenario(input, ports);
}

export async function runOk(input: { artifact: unknown; source: unknown; scenario: unknown }) {
  const result = await runScenario(input, ports);
  if (!result.ok) throw new Error(`scenario refused: ${JSON.stringify(result.error)}`);
  return result.value;
}
