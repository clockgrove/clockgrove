import { performance } from "node:perf_hooks";
import { type CommandTable, parseArguments } from "./args.js";
import { COMMANDS } from "./commands/index.js";
import {
  EXIT_CODES,
  encodeEnvelope,
  type HostRuntime,
  INTERNAL_DEFECT_EXIT_CODE,
  type Observations,
  type Outcome,
} from "./envelope.js";

export interface Streams {
  stdout(bytes: Uint8Array): void;
  stderr(text: string): void;
}

/** Host measurements; they are the only part of the envelope that varies between identical runs. */
function observe(startedAt: number, observed: HostRuntime | undefined): Observations {
  return {
    runtime: `node/${process.version}`,
    durationMs: Math.round(performance.now() - startedAt),
    // libuv reports the high-water resident set size in kilobytes.
    peakMemoryBytes: process.resourceUsage().maxRSS * 1024,
    peakMemoryNullReason: null,
    ...observed,
  };
}

/**
 * Runs one invocation: parses the arguments, runs the command and writes exactly one result document
 * to stdout. A thrown value is an internal defect (exit 70): it writes a diagnostic to stderr and
 * nothing to stdout.
 */
export async function runCli(
  argv: readonly string[],
  commands: CommandTable,
  streams: Streams,
): Promise<number> {
  const startedAt = performance.now();
  try {
    const parsed = parseArguments(argv, commands);
    const outcome: Outcome = parsed.ok ? await parsed.spec.run(parsed.options) : parsed.outcome;
    streams.stdout(
      encodeEnvelope(argv.slice(0, 2).join(" "), outcome, observe(startedAt, outcome.observed)),
    );
    return EXIT_CODES[outcome.status];
  } catch (error) {
    streams.stderr(
      `clockgrove: internal defect: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return INTERNAL_DEFECT_EXIT_CODE;
  }
}

export function main(argv: readonly string[]): Promise<number> {
  return runCli(argv, COMMANDS, {
    stdout: (bytes) => void process.stdout.write(bytes),
    stderr: (text) => void process.stderr.write(text),
  });
}
