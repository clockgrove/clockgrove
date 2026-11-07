import { lstat, readFile, stat } from "node:fs/promises";
import { decodeCanonicalBytes } from "../src/canonical-decode.js";

export type UnreadableCode =
  | "INPUT_UNREADABLE"
  | "NOT_CANONICAL_BYTES"
  | "NOT_PACK_ARTIFACT"
  | "NOT_PACK_SOURCE"
  | "NOT_SIMULATION_STATE";

/** An input that cannot be read or is not the expected encoding or document kind (exit 3). */
export class UnreadableInput extends Error {
  readonly code: UnreadableCode;

  constructor(code: UnreadableCode) {
    super(code);
    this.name = "UnreadableInput";
    this.code = code;
  }
}

/** A failed file-system call (missing, a directory where a file is expected, not permitted). */
export function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

export async function readBytes(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (isFileSystemError(error)) throw new UnreadableInput("INPUT_UNREADABLE");
    throw error;
  }
}

/** Strict kernel canonical bytes of a document. */
export async function readCanonicalFile(path: string): Promise<unknown> {
  const decoded = decodeCanonicalBytes(await readBytes(path));
  if (!decoded.ok) throw new UnreadableInput("NOT_CANONICAL_BYTES");
  return decoded.value;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Whether `path` is a directory; a path that cannot be inspected is an unreadable input. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isFileSystemError(error)) throw new UnreadableInput("INPUT_UNREADABLE");
    throw error;
  }
}
