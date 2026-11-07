/** Built-in base classes stand in for the provider runtime only in local tests. */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    _ctx: unknown,
    protected readonly env: Env,
  ) {}
}
export class DurableObject {
  constructor(..._args: unknown[]) {}
}
export class WorkflowEntrypoint {
  constructor(..._args: unknown[]) {}
}
export class NonRetryableError extends Error {
  override readonly name = "NonRetryableError";
}
