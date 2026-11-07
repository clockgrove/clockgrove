import { type Outcome, usage } from "./envelope.js";

export type Options = Readonly<Record<string, string>>;

/**
 * Every option takes exactly one value and is required. The leading positional arguments are read
 * first and handed to `run` in the options, under their names (for example `<name>`).
 */
export interface CommandSpec {
  readonly positionals?: readonly string[];
  readonly options: readonly string[];
  run(options: Options): Promise<Outcome>;
}

/** Commands by their `<group> <command>` name. */
export type CommandTable = ReadonlyMap<string, CommandSpec>;

export type ParsedArguments =
  | { readonly ok: true; readonly spec: CommandSpec; readonly options: Options }
  | { readonly ok: false; readonly outcome: Outcome };

function refuse(code: string, path: string, message: string): ParsedArguments {
  return { ok: false, outcome: usage(code, path, message) };
}

/** Parses `<group> <command> (--name value)...` against the command table. */
export function parseArguments(argv: readonly string[], commands: CommandTable): ParsedArguments {
  const [group, command, ...rest] = argv;
  if (group === undefined)
    return refuse("MISSING_COMMAND", "command", "a command group is required");
  if (command === undefined) return refuse("MISSING_COMMAND", "command", "a command is required");
  const spec = commands.get(`${group} ${command}`);
  if (spec === undefined) return refuse("UNKNOWN_COMMAND", "command", "unknown command");

  const options: Record<string, string> = Object.create(null) as Record<string, string>;
  const positionals = spec.positionals ?? [];
  for (const [index, name] of positionals.entries()) {
    const value = rest[index];
    if (value === undefined || value.startsWith("--") || value === "")
      return refuse("MISSING_ARGUMENT", name, "a required argument is missing");
    options[name] = value;
  }
  rest.splice(0, positionals.length);
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index] ?? "";
    if (!spec.options.includes(name)) return refuse("UNKNOWN_OPTION", name, "unknown option");
    if (Object.hasOwn(options, name)) return refuse("DUPLICATE_OPTION", name, "duplicate option");
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--"))
      return refuse("MISSING_VALUE", name, "the option needs a value");
    if (value === "") return refuse("MALFORMED_VALUE", name, "the option value must not be empty");
    options[name] = value;
  }
  for (const name of spec.options)
    if (!Object.hasOwn(options, name))
      return refuse("MISSING_OPTION", name, "a required option is missing");
  return { ok: true, spec, options };
}

/** The value of an option the parser has already required. */
export function optionValue(options: Options, name: string): string {
  const value = options[name];
  if (value === undefined) throw new Error(`option ${name} was not parsed`);
  return value;
}
