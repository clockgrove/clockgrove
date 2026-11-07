/** Minimal built-in runtime declarations; provider tooling is deliberately deferred. */
declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown> {
    constructor(ctx: unknown, env: Env);
    protected readonly env: Env;
  }
  export class DurableObject<Env = unknown> {
    constructor(ctx: unknown, env: Env);
  }
  export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    constructor(ctx: unknown, env: Env);
    protected readonly env: Env;
    run(event: { readonly payload: Params }, step: unknown): Promise<unknown>;
  }
}
declare module "cloudflare:workflows" {
  export class NonRetryableError extends Error {
    constructor(message: string, name?: string);
  }
}

/** Native Durable Object hibernation surface; attachments use structured clone, including bigint. */
interface WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
declare class WebSocketPair {
  readonly 0: WebSocket;
  readonly 1: WebSocket;
}
