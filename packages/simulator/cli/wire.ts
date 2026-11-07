import { buildWorldPack, decodeResource } from "@clockgrove/world-pack-sdk";
import { runScenario } from "../src/index.js";
import { packPorts, ports } from "./ports.js";

/**
 * The one scenario execution path shared by the Node run and the workerd run: both receive the
 * same committed bytes, decode them with the SDK resource decoder, build the artifact and run the
 * scenario. Only the runtime differs. It measures nothing; observations are taken by the host.
 */
export interface WireRequest {
  readonly manifest: string;
  readonly resources: Readonly<Record<string, string>>;
  readonly scenario: string;
}

export type WireResponse =
  | { readonly ok: true; readonly bundle: string }
  | {
      readonly ok: false;
      readonly stage: "decode" | "build" | "scenario";
      readonly code: string;
      readonly path: string;
      readonly message: string;
    };

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export function toWireRequest(input: {
  readonly manifestBytes: Uint8Array;
  readonly resourceBytes: Readonly<Record<string, Uint8Array>>;
  readonly scenarioBytes: Uint8Array;
}): WireRequest {
  return {
    manifest: toBase64(input.manifestBytes),
    resources: Object.fromEntries(
      Object.entries(input.resourceBytes).map(([path, bytes]) => [path, toBase64(bytes)]),
    ),
    scenario: toBase64(input.scenarioBytes),
  };
}

export async function runWire(request: WireRequest): Promise<WireResponse> {
  let source: { manifest: unknown; resources: Record<string, Uint8Array>; dependencyArtifacts: [] };
  let scenario: unknown;
  try {
    source = {
      manifest: decodeResource(fromBase64(request.manifest), "manifest.json"),
      resources: Object.fromEntries(
        Object.entries(request.resources).map(([path, text]) => [path, fromBase64(text)]),
      ),
      dependencyArtifacts: [],
    };
    scenario = decodeResource(fromBase64(request.scenario), "scenario");
  } catch (error) {
    return {
      ok: false,
      stage: "decode",
      code: "MALFORMED_RESOURCE",
      path: "wire",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const built = await buildWorldPack(source, packPorts);
  if (!built.ok) return { ok: false, stage: "build", ...built.error };
  const ran = await runScenario({ artifact: built.value.artifact, source, scenario }, ports);
  if (!ran.ok) return { ok: false, stage: "scenario", ...ran.error };
  return { ok: true, bundle: toBase64(ran.value.bytes) };
}
