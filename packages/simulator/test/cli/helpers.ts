import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalBytes, sha256Hex } from "@clockgrove/kernel";
import { decodeResource, encodeResource } from "@clockgrove/world-pack-sdk";
import { COMMANDS } from "../../cli/commands/index.js";
import { runCli } from "../../cli/main.js";
import { decodeCanonicalBytes } from "../../src/canonical-decode.js";
import { REPO_ROOT } from "../conformance/pack-source.js";

export { REPO_ROOT };
export const CLI_PATH = join(REPO_ROOT, "packages/simulator/cli/clockgrove.mjs");

export interface Envelope {
  readonly kind: string;
  readonly version: number;
  readonly command: string;
  readonly status: string;
  readonly exitCode: number;
  readonly result: unknown;
  readonly refusal: {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  } | null;
  readonly observations: Record<string, unknown>;
}

export interface CliRun {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

/**
 * Runs the real executable as a child process under the current Node. Each call starts Node and
 * transforms the TypeScript sources again, so only the bin entry's own tests use it.
 */
export function spawnExecutable(
  args: readonly string[],
  cwd: string = REPO_ROOT,
  env: NodeJS.ProcessEnv = {},
): Promise<CliRun> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolveRun({
        exitCode,
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

/**
 * Runs one invocation in this process: the executable's `runCli` with its command table and captured
 * streams, relative paths resolving against `cwd` as for the spawned executable.
 */
export async function runExecutable(
  args: readonly string[],
  cwd: string = REPO_ROOT,
): Promise<CliRun> {
  const stdout: Uint8Array[] = [];
  const stderr: string[] = [];
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const exitCode = await runCli(args, COMMANDS, {
      stdout: (bytes) => stdout.push(bytes),
      stderr: (text) => stderr.push(text),
    });
    return { exitCode, stdout: new Uint8Array(Buffer.concat(stdout)), stderr: stderr.join("") };
  } finally {
    process.chdir(previous);
  }
}

/** The single stdout document: SDK `encodeResource` bytes plus one newline, nothing else. */
export function readEnvelope(stdout: Uint8Array): Envelope {
  const document = stdout.slice(0, -1);
  if (
    stdout.at(-1) !== 0x0a ||
    Buffer.compare(encodeResource(decodeResource(document, "stdout")), document) !== 0
  )
    throw new Error("stdout is not exactly one encodeResource document and a newline");
  return decodeResource(document, "stdout") as Envelope;
}

/** Everything an invocation must reproduce for identical inputs: the envelope minus `observations`. */
export function stableBytes(envelope: Envelope): Uint8Array {
  const { observations: _observations, ...stable } = envelope;
  return encodeResource(stable);
}

export async function temporaryDirectory(): Promise<{ path: string; dispose(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "clockgrove-cli-"));
  return { path, dispose: () => rm(path, { recursive: true, force: true }) };
}

/** The decoded pack artifact document, without its `bundleHash`. */
export interface ArtifactDocument {
  readonly kind: string;
  readonly version: number;
  artifact: Record<string, string>;
  source: { manifest: string; resources: Record<string, string> };
  scenarios: { name: string; bytes: string }[];
  goldens: { name: string; bytes: string }[];
}

/**
 * Rewrites a pack artifact file: decodes it, applies `edit` to the document without `bundleHash`
 * and records the new `bundleHash`, so the only defect is the edit.
 */
export function tamperArtifact(
  bytes: Uint8Array,
  edit: (document: ArtifactDocument) => void,
): Uint8Array {
  const decoded = decodeCanonicalBytes(bytes);
  if (!decoded.ok) throw new Error("artifact file is not canonical bytes");
  const { bundleHash: _bundleHash, ...document } = decoded.value as ArtifactDocument & {
    bundleHash: string;
  };
  edit(document);
  return canonicalBytes({ ...document, bundleHash: sha256Hex(canonicalBytes(document)) });
}

/** Runs the executable in the repository root and decodes its single result document. */
export async function invoke(
  args: readonly string[],
): Promise<{ readonly run: CliRun; readonly envelope: Envelope }> {
  const run = await runExecutable(args);
  return { run, envelope: readEnvelope(run.stdout) };
}

export async function packBuild(pack: string, out: string) {
  const run = await runExecutable(["pack", "build", "--pack", pack, "--out", out]);
  return { run, envelope: readEnvelope(run.stdout) };
}

export interface CheckRow {
  readonly name: string;
  readonly scenario: string | null;
  readonly status: string;
}

export async function packTest(artifact: string) {
  const run = await runExecutable(["pack", "test", "--artifact", artifact]);
  const envelope = readEnvelope(run.stdout);
  const result = envelope.result as { checks: CheckRow[] } | null;
  const checks = (result?.checks ?? []).map(({ name, scenario, status }) => ({
    name,
    scenario,
    status,
  }));
  return { run, envelope, checks };
}
