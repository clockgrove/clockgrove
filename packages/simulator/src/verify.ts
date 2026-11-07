import { canonicalBytes } from "@clockgrove/kernel";
import { bytesEqual, decodeCanonicalBytes } from "./canonical-decode.js";
import { GENESIS_BUNDLE_KIND } from "./constants.js";
import { type SeedRefusal, type SimulatorPorts, seedGenesis } from "./genesis.js";
import { isRecord } from "./scenario/support.js";

export type VerifyResult =
  | { readonly ok: true; readonly value: { readonly bundleHash: string } }
  | { readonly ok: false; readonly error: SeedRefusal };

/** Documented top-level order of a genesis bundle. */
const BUNDLE_FIELDS = [
  "kind",
  "version",
  "simulatorVersion",
  "engineVersion",
  "artifact",
  "world",
  "clock",
  "cognitiveSeeds",
  "genesisCommandId",
  "seedCommands",
  "events",
  "decisionTraces",
  "schedules",
  "counters",
  "state",
  "initialStateHash",
  "seedProjection",
  "randomState",
  "finalStateHash",
  "bundleHash",
] as const;

class Stop extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

function stop(code: string, path: string, message: string): never {
  throw new Stop(code, path, message);
}

/** Total: never throws; verifies a genesis bundle against a fresh re-seeding of its pack artifact. */
export async function verifyGenesisBundle(
  input: unknown,
  ports: SimulatorPorts,
): Promise<VerifyResult> {
  try {
    if (!isRecord(input)) return stop("MALFORMED_INPUT", "input", "input must be a record");
    for (const key of Object.keys(input))
      if (key !== "bundle" && key !== "artifact" && key !== "source")
        stop("UNKNOWN_FIELD", `input.${key}`, "unknown input field");
    for (const key of ["bundle", "artifact", "source"])
      if (!Object.hasOwn(input, key)) stop("MISSING_FIELD", `input.${key}`, `${key} is required`);
    const bytes = input.bundle;
    if (!(bytes instanceof Uint8Array))
      stop("MALFORMED_INPUT", "input.bundle", "bundle must be a Uint8Array");

    const decoded = decodeCanonicalBytes(bytes);
    if (!decoded.ok || !isRecord(decoded.value))
      return stop(
        "MALFORMED_BUNDLE",
        "bundle",
        "bundle is not canonical clockgrove-canonical-v1 bytes",
      );
    const bundle = decoded.value;

    for (const key of Object.keys(bundle).sort())
      if (!(BUNDLE_FIELDS as readonly string[]).includes(key))
        stop("UNKNOWN_FIELD", `bundle.${key}`, "unknown bundle field");
    for (const field of BUNDLE_FIELDS)
      if (!Object.hasOwn(bundle, field))
        stop("MISSING_FIELD", `bundle.${field}`, "missing bundle field");
    if (bundle.kind !== GENESIS_BUNDLE_KIND)
      stop("UNSUPPORTED_BUNDLE_VERSION", "bundle.kind", "unsupported bundle kind");
    if (bundle.version !== 1)
      stop("UNSUPPORTED_BUNDLE_VERSION", "bundle.version", "unsupported bundle version");

    const { bundleHash, ...withoutHash } = bundle;
    const recomputed = await ports.sha256(canonicalBytes(withoutHash));
    if (bundleHash !== recomputed)
      stop(
        "BUNDLE_HASH_MISMATCH",
        "bundle.bundleHash",
        "bundleHash differs from the bundle contents",
      );

    const seeded = await seedGenesis({ artifact: input.artifact, source: input.source }, ports);
    if (!seeded.ok) return { ok: false, error: seeded.error };
    const fresh = seeded.value.bundle as unknown as Record<string, unknown>;
    for (const field of BUNDLE_FIELDS)
      if (!bytesEqual(canonicalBytes(bundle[field]), canonicalBytes(fresh[field])))
        stop(
          field === "bundleHash" ? "BUNDLE_HASH_MISMATCH" : "BUNDLE_FIELD_MISMATCH",
          `bundle.${field}`,
          `${field} differs from a fresh seeding of the artifact`,
        );
    return { ok: true, value: { bundleHash: recomputed } };
  } catch (error) {
    if (error instanceof Stop)
      return { ok: false, error: { code: error.code, path: error.path, message: error.message } };
    return {
      ok: false,
      error: {
        code: "MALFORMED_INPUT",
        path: "input",
        message: "verification could not be completed",
      },
    };
  }
}
