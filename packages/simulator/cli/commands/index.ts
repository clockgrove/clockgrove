import type { CommandTable } from "../args.js";
import { PACK_COMMANDS } from "./pack.js";
import { SCENARIO_COMMANDS } from "./scenario.js";
import { SIMULATE_COMMANDS } from "./simulate.js";

/** Every command, by `<group> <command>`. */
export const COMMANDS: CommandTable = new Map([
  ...PACK_COMMANDS,
  ...SIMULATE_COMMANDS,
  ...SCENARIO_COMMANDS,
]);
