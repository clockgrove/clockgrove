import { join } from "node:path";
import { decodeCanonicalBytes } from "../src/canonical-decode.js";
import { isRecord } from "../src/scenario/support.js";
import { type BundleDifference, bytesEqual, describeDifference } from "./difference.js";
import { failed, type HostRuntime, type Outcome, type Refusal, succeed } from "./envelope.js";
import { directoryEntries, readPackDirectory } from "./pack-source.js";
import {
  ResourceLedger,
  type RuntimeRun,
  runInNode,
  WorkersSession,
  WorkersUnavailable,
} from "./runtime.js";
import { fromBase64, toWireRequest } from "./wire.js";

export const RUNTIMES = ["node", "workers"] as const;
export type RuntimeName = (typeof RUNTIMES)[number];

export interface ScenarioLocation {
  /** The directory name of the pack under the pack root. */
  readonly pack: string;
  readonly directory: string;
}

export type Resolution =
  | { readonly ok: true; readonly location: ScenarioLocation }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * Finds `<name>` as the stem of `<packRoot>/<dir>/scenarios/<name>.json`. A name in no pack is
 * `UNKNOWN_SCENARIO`; a name in several packs is `AMBIGUOUS_SCENARIO`.
 */
export async function resolveScenario(packRoot: string, name: string): Promise<Resolution> {
  const found: ScenarioLocation[] = [];
  for (const entry of await directoryEntries(packRoot)) {
    if (!entry.isDirectory()) continue;
    const directory = join(packRoot, entry.name);
    const scenarios = await directoryEntries(join(directory, "scenarios"));
    if (scenarios.some((file) => file.isFile() && file.name === `${name}.json`))
      found.push({ pack: entry.name, directory });
  }
  const [only] = found;
  if (found.length === 1 && only !== undefined) return { ok: true, location: only };
  return {
    ok: false,
    refusal:
      found.length === 0
        ? {
            code: "UNKNOWN_SCENARIO",
            path: "<name>",
            message: "no committed pack has this scenario",
          }
        : {
            code: "AMBIGUOUS_SCENARIO",
            path: "<name>",
            message: `the scenario is in several packs: ${found.map((item) => item.pack).join(", ")}`,
          },
  };
}

export type GoldenStatus = "match" | "mismatch" | "missing";

export interface GoldenReport {
  readonly status: GoldenStatus;
  /** Set for a mismatch only. */
  readonly difference: BundleDifference | null;
}

function goldenReport(golden: Uint8Array | undefined, actual: Uint8Array): GoldenReport {
  if (golden === undefined) return { status: "missing", difference: null };
  if (bytesEqual(golden, actual)) return { status: "match", difference: null };
  const difference = describeDifference(golden, actual);
  return {
    status: "mismatch",
    difference:
      difference === "golden-not-canonical"
        ? { fields: ["<golden is not canonical bytes>"], paths: [] }
        : difference,
  };
}

export interface ScenarioRequest {
  readonly packRoot: string;
  readonly name: string;
  readonly runtime: RuntimeName;
  /** Receives every worker and temporary directory a workers run creates. */
  readonly ledger?: ResourceLedger;
  /** Starts workerd; the default is the pinned root Wrangler with Miniflare. */
  readonly startWorkers?: (ledger: ResourceLedger) => Promise<WorkersSession>;
}

export type ScenarioOutcome = Outcome & { readonly observed?: HostRuntime };

/**
 * The one scenario execution path of the CLI: the committed bytes of the pack go to the chosen
 * runtime, which decodes them with the SDK, builds the artifact and calls `runScenario`. The `result`
 * is the same document for both runtimes. Nothing under the pack root is written.
 */
export async function runNamedScenario(request: ScenarioRequest): Promise<ScenarioOutcome> {
  const resolved = await resolveScenario(request.packRoot, request.name);
  if (!resolved.ok) return failed(resolved.refusal);
  const { pack, directory } = resolved.location;
  const files = await readPackDirectory(directory);
  const scenario = files.scenarios.find((item) => item.name === request.name);
  if (scenario === undefined)
    throw new Error("the resolved scenario is not among the pack's scenarios");
  const wire = toWireRequest({
    manifestBytes: files.manifest,
    resourceBytes: files.resources,
    scenarioBytes: scenario.bytes,
  });

  const ledger = request.ledger ?? new ResourceLedger();
  let run: RuntimeRun;
  try {
    if (request.runtime === "node") run = await runInNode(wire);
    else {
      const session = await (request.startWorkers ?? ((owner) => WorkersSession.start(owner)))(
        ledger,
      );
      run = await session.run(wire);
    }
  } catch (error) {
    if (error instanceof WorkersUnavailable)
      return failed({ code: "WORKERS_UNAVAILABLE", path: "--runtime", message: error.message });
    throw error;
  } finally {
    await ledger.disposeAll();
  }

  const response = run.response;
  if (!response.ok)
    return failed({ code: response.code, path: response.path, message: response.message });
  const bytes = fromBase64(response.bundle);
  const decoded = decodeCanonicalBytes(bytes);
  if (!decoded.ok || !isRecord(decoded.value))
    throw new Error("the scenario bundle is not canonical bytes");
  const bundle = decoded.value;
  const { bundleHash, assertions } = bundle;
  if (typeof bundleHash !== "string" || !Array.isArray(assertions))
    throw new Error("the scenario bundle has no bundleHash or assertions");

  const golden = goldenReport(
    files.goldens.find((item) => item.name === request.name)?.bytes,
    bytes,
  );
  const result = { pack, scenario: request.name, bundleHash, bundle, assertions, golden };
  const passed =
    golden.status === "match" &&
    assertions.every((assertion) => isRecord(assertion) && assertion.passed === true);
  const observed: HostRuntime = {
    runtime: run.observation.runtime,
    peakMemoryBytes: run.observation.peakMemoryBytes,
    peakMemoryNullReason: run.observation.peakMemoryNullReason,
  };
  return { ...(passed ? succeed(result) : failed(null, result)), observed };
}
