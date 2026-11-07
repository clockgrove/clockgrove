import { join, resolve } from "node:path";

/** The repository root: `packages/simulator/cli` is three levels below it. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const WORLDS_ROOT = join(REPO_ROOT, "worlds");
