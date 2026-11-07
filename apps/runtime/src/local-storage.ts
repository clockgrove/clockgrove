import type { RuntimeLocalState } from "./types.js";

export interface RuntimeLocalStorage {
  read(): Promise<RuntimeLocalState | undefined>;
  replace(state: RuntimeLocalState): Promise<void>;
}

/** Local/emulated storage used by tests; it is never canonical authority. */
export class MemoryRuntimeLocalStorage implements RuntimeLocalStorage {
  constructor(private state?: RuntimeLocalState) {}

  async read(): Promise<RuntimeLocalState | undefined> {
    return this.state;
  }

  async replace(state: RuntimeLocalState): Promise<void> {
    this.state = state;
  }

  destroy(): void {
    this.state = undefined;
  }

  seedStale(state: RuntimeLocalState): void {
    this.state = state;
  }
}
