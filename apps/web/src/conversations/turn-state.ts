import type { ConversationMessage } from "@clockgrove/contracts";

export type ServiceOutcome = NonNullable<ConversationMessage["serviceOutcome"]>;
export type TurnResult = "completed" | "cancelled" | "failed" | ServiceOutcome;

export interface TurnStateInput {
  /** The latest durable or stream phase, if any frame arrived. */
  readonly phase?: string | undefined;
  /** Provisional text is streaming. */
  readonly provisional?: boolean;
  /** The turn was sent (or resumed) and has not settled. */
  readonly inFlight?: boolean;
  /** The turn was resumed after a reload or an interruption. */
  readonly recovered?: boolean;
  /** How the turn settled; it stays shown until the next send. */
  readonly result?: TurnResult | undefined;
}

export interface TurnState {
  readonly key: string;
  readonly label: string;
}

const RESULTS: Readonly<Record<TurnResult, TurnState>> = {
  completed: { key: "completed", label: "Completed" },
  cancelled: { key: "cancelled", label: "Cancelled" },
  failed: { key: "failed", label: "Failed" },
  model_unavailable: { key: "model-unavailable", label: "Model unavailable" },
  cost_budget_exhausted: { key: "budget-blocked", label: "Budget blocked" },
  tool_calls_exhausted: { key: "budget-blocked", label: "Budget blocked" },
  model_steps_exhausted: { key: "budget-blocked", label: "Budget blocked" },
};

const QUEUED: TurnState = { key: "queued", label: "Queued" };
const THINKING: TurnState = { key: "thinking", label: "Thinking…" };

function phaseState(phase: string | undefined, provisional: boolean): TurnState | undefined {
  switch (phase) {
    case "tool_using":
    case "tool_completed":
      return { key: "tool", label: "Using tool…" };
    case "approval_waiting":
      return { key: "approval", label: "Awaiting approval of a tool call" };
    case "tool_waiting":
      return { key: "delayed", label: "Delayed: waiting for a tool" };
    case "completed":
      return RESULTS.completed;
    case "cancelled":
      return RESULTS.cancelled;
    case "rejected":
    case "failed":
    case "abandoned":
      return RESULTS.failed;
    case "accepted":
      return QUEUED;
    case undefined:
      return provisional ? THINKING : undefined;
    default:
      return THINKING;
  }
}

export function isTerminalState(state: TurnState): boolean {
  return ["completed", "cancelled", "failed", "model-unavailable", "budget-blocked"].includes(
    state.key,
  );
}

/** The one visible turn state, or nothing when no turn is in flight or settled. */
export function turnStateLabel(input: TurnStateInput): TurnState | undefined {
  if (input.result) return RESULTS[input.result];
  const state =
    phaseState(input.phase, input.provisional === true) ?? (input.inFlight ? QUEUED : undefined);
  if (!state) return undefined;
  if (input.recovered && !isTerminalState(state))
    return { key: "recovered", label: `Reply in progress (recovered: ${state.label})` };
  return state;
}
