import {
  type Observation,
  ResourceLedger,
  type RuntimeRun,
  runInNode,
  WorkersSession,
  WorkersUnavailable,
} from "../../cli/runtime.js";
import type { WireRequest } from "../../cli/wire.js";
import { CHECKS, failCheck } from "./failure.js";

export type { Observation, RuntimeRun };
export { ResourceLedger, runInNode, WorkersSession };

/** Starts workerd for `pack`; a workers failure is a `workers-runtime` conformance failure. */
export async function startWorkers(pack: string, ledger: ResourceLedger): Promise<WorkersSession> {
  try {
    return await WorkersSession.start(ledger);
  } catch (error) {
    if (error instanceof WorkersUnavailable) return failCheck(pack, CHECKS.workers, error.message);
    throw error;
  }
}

/** Runs one request in workerd; a workers failure is a `workers-runtime` conformance failure. */
export async function runInWorkers(
  pack: string,
  session: WorkersSession,
  request: WireRequest,
): Promise<RuntimeRun> {
  try {
    return await session.run(request);
  } catch (error) {
    if (error instanceof WorkersUnavailable) return failCheck(pack, CHECKS.workers, error.message);
    throw error;
  }
}
