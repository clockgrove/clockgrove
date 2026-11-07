/** Stable machine code plus the source path that caused a refusal. */
export interface WorldPackIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class WorldPackError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "WorldPackError";
  }
}

export function fail(code: string, path: string, message: string): never {
  throw new WorldPackError(code, path, message);
}
