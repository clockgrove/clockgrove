import { type Outcome, unreadable } from "./envelope.js";
import { type UnreadableCode, UnreadableInput } from "./input.js";

const UNREADABLE_MESSAGES: Readonly<Record<UnreadableCode, string>> = {
  INPUT_UNREADABLE: "the input cannot be read",
  NOT_CANONICAL_BYTES: "the input is not strict canonical bytes",
  NOT_PACK_ARTIFACT: "the input is not a clockgrove.pack-artifact document",
  NOT_PACK_SOURCE: "the pack manifest is not SDK resource JSON",
  NOT_SIMULATION_STATE: "the input is not a clockgrove.simulation-state document",
};

/** The unreadable outcome for an input error against the option that named it; null for any other error. */
export function unreadableOutcome(option: string, error: unknown): Outcome | null {
  return error instanceof UnreadableInput
    ? unreadable(error.code, option, UNREADABLE_MESSAGES[error.code])
    : null;
}

/** Runs a command body, reporting an unreadable input against the option that named it. */
export async function readingOption(
  option: string,
  body: () => Promise<Outcome>,
): Promise<Outcome> {
  try {
    return await body();
  } catch (error) {
    const outcome = unreadableOutcome(option, error);
    if (outcome === null) throw error;
    return outcome;
  }
}
