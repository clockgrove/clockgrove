import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";

// TMPDIR is relative to the effective OpenTofu -chdir directory, not the caller.
export async function withProviderIpc(tofuDirectory, operation) {
  const anchor = await realpath(tofuDirectory);
  const directory = await mkdtemp(path.join(anchor, ".ipc-"));
  try {
    await chmod(directory, 0o700);
    return await operation(`./${path.basename(directory)}`, anchor);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
