// Peak memory of a process tree, read from the host (Linux /proc only; empty elsewhere).
import { readdirSync, readFileSync } from "node:fs";

const LINUX_PROC = "/proc";

/** Descendant process ids of `root`. */
function descendants(root) {
  let entries;
  try {
    entries = readdirSync(LINUX_PROC).filter((name) => /^[0-9]+$/u.test(name));
  } catch {
    return [];
  }
  const children = new Map();
  for (const pid of entries) {
    try {
      // The command name may contain spaces or parentheses; the parent id follows the last ")".
      const stat = readFileSync(`${LINUX_PROC}/${pid}/stat`, "utf8");
      const parent = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(pid);
    } catch {
      // The process exited while the table was read.
    }
  }
  const found = [];
  const queue = [String(root)];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** The resident-set high-water mark in bytes of every workerd process below this one. */
export function workerdPeakMemory() {
  const peaks = [];
  for (const pid of descendants(process.pid)) {
    try {
      if (readFileSync(`${LINUX_PROC}/${pid}/comm`, "utf8").trim() !== "workerd") continue;
      const status = readFileSync(`${LINUX_PROC}/${pid}/status`, "utf8");
      const kilobytes = /^VmHWM:\s+([0-9]+) kB$/mu.exec(status)?.[1];
      if (kilobytes !== undefined) peaks.push(Number(kilobytes) * 1024);
    } catch {
      // The process exited before it could be read.
    }
  }
  return peaks;
}
