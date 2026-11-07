// One Wave 1 long run in one runtime, in a process of its own so that its peak memory is its own.
// Usage: node scripts/ci/qualify-wave1-long-run-child.mjs <pack-dir> <scenario-file> <node|workers> <bundle-out>
// The scenario bundle bytes go to <bundle-out>; stdout carries one JSON line of host observations.
// Observations are measured by the host and never enter the bundle or its hash.
import "../../packages/simulator/cli/typescript-hooks.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { workerdPeakMemory } from "../lib/process-memory.mjs";

const [packDirectory, scenarioFile, runtime, bundleOut] = process.argv.slice(2);
if (!bundleOut || !["node", "workers"].includes(runtime))
  throw new Error(
    "usage: qualify-wave1-long-run-child.mjs <pack-dir> <scenario-file> <node|workers> <bundle-out>",
  );

const { readPackDirectory } = await import("../../packages/simulator/cli/pack-source.ts");
const { fromBase64, toWireRequest } = await import("../../packages/simulator/cli/wire.ts");
const { ResourceLedger, runInNode, WorkersSession } = await import(
  "../../packages/simulator/cli/runtime.ts"
);

const files = await readPackDirectory(packDirectory);
const wire = toWireRequest({
  manifestBytes: files.manifest,
  resourceBytes: files.resources,
  scenarioBytes: new Uint8Array(await readFile(scenarioFile)),
});

let run;
let memory;
if (runtime === "node") {
  run = await runInNode(wire);
  memory = {
    peakMemoryBytes: run.observation.peakMemoryBytes,
    peakMemorySource: "node process resident-set high-water mark (getrusage maxrss)",
    peakMemoryNullReason: null,
  };
} else {
  const ledger = new ResourceLedger();
  try {
    const session = await WorkersSession.start(ledger);
    run = await session.run(wire);
    // Read before disposal: VmHWM is the workerd process's own peak resident set.
    const peaks = workerdPeakMemory();
    memory =
      peaks.length === 1
        ? {
            peakMemoryBytes: peaks[0],
            peakMemorySource: "workerd process resident-set high-water mark (/proc VmHWM)",
            peakMemoryNullReason: null,
          }
        : {
            peakMemoryBytes: null,
            peakMemorySource: null,
            peakMemoryNullReason:
              peaks.length === 0
                ? "no workerd process was readable from the host /proc"
                : `${peaks.length} workerd processes were found; the run's own is ambiguous`,
          };
  } finally {
    await ledger.disposeAll();
  }
}

const observation = {
  runtime: run.observation.runtime,
  durationMs: Math.round(run.observation.durationMs),
  ...memory,
  hostProcessPeakMemoryBytes: process.resourceUsage().maxRSS * 1024,
};
if (run.response.ok) await writeFile(bundleOut, fromBase64(run.response.bundle));
const { ok, stage = null, code = null, path = null, message = null } = run.response;
process.stdout.write(
  `${JSON.stringify({ ok, refusal: ok ? null : { stage, code, path, message }, observation })}\n`,
);
