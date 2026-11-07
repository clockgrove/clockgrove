/**
 * Stable world command types and their payload schema versions. `world.weather.set` v2 applies at
 * the command's own time; v1 is retired (replay is event-sourced and never re-executes commands).
 */
export const WORLD_COMMAND_VERSIONS = Object.freeze({
  "world.advance": [1],
  "world.weather.set": [2],
} as const);

export type WorldCommandType = keyof typeof WORLD_COMMAND_VERSIONS;

export const WORLD_COMMAND_DEFINITIONS: readonly Readonly<{
  type: WorldCommandType;
  version: number;
}>[] = Object.freeze(
  (Object.keys(WORLD_COMMAND_VERSIONS) as WorldCommandType[]).flatMap((type) =>
    WORLD_COMMAND_VERSIONS[type].map((version) => Object.freeze({ type, version })),
  ),
);
