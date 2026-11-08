import { neutralShell, readWorldShell, type WorldShellInput } from "./shell-input.js";

declare const __WORLD_SHELL__: unknown;
export const worldShell: WorldShellInput =
  typeof __WORLD_SHELL__ === "undefined" ? neutralShell : readWorldShell(__WORLD_SHELL__);
