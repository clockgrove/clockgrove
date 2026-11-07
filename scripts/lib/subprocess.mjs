import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const scope = new AsyncLocalStorage();

// Cancellation remains cooperative in the owner; child process groups are forcibly settled.
export async function withSubprocessDeadline(operation, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("positive finite owner deadline required");
  const controller = new AbortController();
  const inherited = scope.getStore();
  const signal = inherited ? AbortSignal.any([inherited, controller.signal]) : controller.signal;
  const cancel = () => controller.abort(new Error("owned operation interrupted"));
  const timer = setTimeout(
    () => controller.abort(new Error("owned operation timed out")),
    timeoutMs,
  );
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  try {
    return await scope.run(signal, operation);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}

export function withoutSubprocessCancellation(operation) {
  return scope.run(undefined, operation);
}

// Return observations only after pipes and the directly owned child have closed.
export async function ownedSubprocess(executable, args, options = {}) {
  const {
    cwd,
    env = process.env,
    input,
    inherit = false,
    timeoutMs = 30_000,
    killGraceMs = 1_000,
    maxBuffer = 128 * 1024 * 1024,
    signal = scope.getStore(),
  } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("positive finite subprocess deadline required");
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0)
    throw new Error("finite subprocess termination grace required");
  if (signal?.aborted)
    return { status: null, signal: null, error: failure("ETIMEDOUT"), stdout: "", stderr: "" };
  return await new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: [
        input === undefined ? "ignore" : "pipe",
        inherit ? "inherit" : "pipe",
        inherit ? "inherit" : "pipe",
      ],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let error;
    let escalation;
    const kill = (signalName) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signalName);
        else process.kill(-child.pid, signalName);
      } catch (cause) {
        if (cause.code !== "ESRCH") error ??= cause;
      }
    };
    const cancel = (code = "ETIMEDOUT") => {
      if (escalation !== undefined) return;
      error ??= failure(code);
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), killGraceMs);
    };
    const aborted = () => cancel();
    const timer = setTimeout(() => cancel(), timeoutMs);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) cancel();
    const collect = (stream, append) => {
      stream?.setEncoding("utf8").on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBuffer) cancel("ENOBUFS");
        else append(chunk);
      });
    };
    collect(child.stdout, (chunk) => {
      stdout += chunk;
    });
    collect(child.stderr, (chunk) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      error ??= cause;
    });
    child.stdin?.on("error", (cause) => {
      if (cause.code !== "EPIPE") error ??= cause;
    });
    child.on("close", async (status, childSignal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", aborted);
      // Even a cooperative leader can leave descendants after closing its own pipes.
      kill("SIGKILL");
      try {
        await settleProcessGroup(child.pid);
      } catch (cause) {
        error ??= cause;
      }
      resolve({
        status: typeof status === "number" && status >= 0 ? status : null,
        signal: childSignal,
        error,
        stdout,
        stderr,
      });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function settleProcessGroup(group) {
  if (!group || process.platform === "win32") return;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      process.kill(-group, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    // Reparented zombies have ceased execution; their host reaper owns removal.
    const states = await Promise.all(
      (await readdir("/proc"))
        .filter((name) => /^\d+$/u.test(name))
        .map(async (name) => {
          const stat = await readFile(`/proc/${name}/stat`, "utf8").catch((error) => {
            if (error.code === "ENOENT" || error.code === "ESRCH") return "";
            throw error;
          });
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          return Number(fields[2]) === group && fields[0] !== "Z";
        }),
    );
    if (!states.some(Boolean)) return;
    if (Date.now() >= deadline) throw failure("ETIMEDOUT");
    await delay(10);
  }
}

function failure(code) {
  return Object.assign(new Error(`owned subprocess failed: ${code}`), { code });
}
