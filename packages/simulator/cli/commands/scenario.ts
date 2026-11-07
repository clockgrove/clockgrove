import { type CommandSpec, optionValue } from "../args.js";
import { differenceOf } from "../difference.js";
import { failed, type Outcome, succeed, usage } from "../envelope.js";
import { readCanonicalFile } from "../input.js";
import { unreadableOutcome } from "../reading.js";
import { WORLDS_ROOT } from "../repo.js";
import { RUNTIMES, type RuntimeName, runNamedScenario } from "../scenario.js";

function isRuntimeName(value: string): value is RuntimeName {
  return (RUNTIMES as readonly string[]).includes(value);
}

const scenario: CommandSpec = {
  positionals: ["<name>"],
  options: ["--runtime"],
  run: (options) => {
    const runtime = optionValue(options, "--runtime");
    if (!isRuntimeName(runtime))
      return Promise.resolve(
        usage("MALFORMED_VALUE", "--runtime", "the runtime must be node or workers"),
      );
    return runNamedScenario({
      packRoot: WORLDS_ROOT,
      name: optionValue(options, "<name>"),
      runtime,
    });
  },
};

type Argument =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly outcome: Outcome };

/** Reads the canonical file named by a positional argument; an unreadable one names that argument. */
async function readArgument(name: string, path: string): Promise<Argument> {
  try {
    return { ok: true, value: await readCanonicalFile(path) };
  } catch (error) {
    const outcome = unreadableOutcome(name, error);
    if (outcome === null) throw error;
    return { ok: false, outcome };
  }
}

const diff: CommandSpec = {
  positionals: ["<a>", "<b>"],
  options: [],
  run: async (options) => {
    const left = await readArgument("<a>", optionValue(options, "<a>"));
    if (!left.ok) return left.outcome;
    const right = await readArgument("<b>", optionValue(options, "<b>"));
    if (!right.ok) return right.outcome;
    const difference = differenceOf(left.value, right.value, "document");
    const identical = difference.fields.length === 0 && difference.paths.length === 0;
    const result = { identical, fields: difference.fields, paths: difference.paths };
    return identical ? succeed(result) : failed(null, result);
  },
};

export const SCENARIO_COMMANDS: ReadonlyMap<string, CommandSpec> = new Map([
  ["simulate scenario", scenario],
  ["simulate diff", diff],
]);
