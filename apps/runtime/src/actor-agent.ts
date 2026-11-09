import {
  type CapabilityGrants,
  type ConversationParticipant,
  ConversationRefusedError,
  type ConversationResponder,
  type ConversationStore,
  type StoredCommandProposal,
  type TurnCommandRecord,
  type TurnFiber,
  type TurnInput,
} from "@clockgrove/application";
import type { TalkReceipt, TalkRequest, TalkStreamFrame } from "@clockgrove/contracts";
import { CONVERSATION_REFUSAL_STATUS, type ConversationStores } from "./conversations.js";

/**
 * The portable half of `ActorAgentDO` (Wave 5 §7, RW-0503 with RW-0307): logical session lanes,
 * the perception inbox, the capability revision and the recovery metadata of one actor's owner,
 * and the turn fiber that runs each Caretaker message through its checkpointed phases. Every fact
 * it holds is rebuilt from PostgreSQL or is presentation; the owner keeps no world truth.
 */

/** What a turn ends with: the committed receipt or a refusal. */
export type TurnOutcome =
  | { readonly receipt: TalkReceipt; readonly refused?: undefined }
  | { readonly refused: ConversationRefusedError["code"]; readonly receipt?: undefined };

/** An activation the owner admits (Wave 5 §5.2); only direct messages have a producer today. */
export interface DirectMessageActivation {
  readonly kind: "direct_message";
  readonly sessionId: string;
  readonly messageId: string;
}

/** Recovery metadata in the owner's local storage: rebuildable, never canonical. */
export interface ActorAgentRecovery {
  readonly schemaVersion: 1;
  /** The incarnation that last initialized, and how many incarnations this owner has had. */
  readonly incarnation: string;
  readonly incarnations: number;
  /** The newest capability revision announced to this actor (the RW-0506 hook). */
  readonly capabilityRevision: number;
  /** Turns this incarnation found open in PostgreSQL and resumed. */
  readonly recoveredTurns: number;
}

/** The owner-specific edges of a fiber: its lease holder, connection, checkpoint hook and keep-alive. */
export interface TurnFiberHost {
  readonly holder: string;
  /** The actor this owner serves. */
  readonly actorId: string;
  readonly stores: ConversationStores;
  readonly respond: ConversationResponder;
  capabilityRevision(): number;
  beforeModel?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    input: TurnInput,
  ): Promise<void>;
  /**
   * What this owner may do for the turn's member: the registry's grants for the member's runtime
   * grants. Undefined when the owner holds no trusted context (a recovered turn), which abandons
   * the attempt so the client's retry carries one.
   */
  grants?(participant: ConversationParticipant): CapabilityGrants | undefined;
  /** Submits an authorized world command through the ordinary world-command path. */
  submitCommand?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    proposal: StoredCommandProposal,
    call: { readonly objectId: string; readonly kind: string },
  ): Promise<TurnCommandRecord>;
  /**
   * Called after every durable checkpoint, and inside `model_running` after the first streamed
   * delta, with the phase just reached. The owner records it for recovery; a local fault binding
   * may end the incarnation there.
   */
  checkpointed(fiber: TurnFiber, phase: string): Promise<void>;
  /** Runs the fiber under the platform's keep-alive and interrupted-work recovery. */
  durable<T>(
    fiber: TurnFiber,
    participant: ConversationParticipant,
    run: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Decision: the inbox remembers the last 256 activations. A duplicate it did not admit joins this
 * owner's acceptance or run of that message without accepting it again; the fiber row's key in
 * PostgreSQL is what makes any duplicate harmless, so forgetting an entry is safe.
 */
export const PERCEPTION_INBOX_LIMIT = 256;

/**
 * Decision: a new message resumes and waits for its session's abandoned turn at most 3 times
 * before answering busy. Each round claims the turn under a new attempt; one normally settles it,
 * and a turn that fails three resumptions in a row is not one a waiting message should hide.
 */
const RESUME_ROUNDS = 3;

/** Bounded, insertion-ordered dedupe of activation keys. */
export class PerceptionInbox {
  private readonly keys: string[];
  constructor(keys: readonly string[] = []) {
    this.keys = keys.slice(-PERCEPTION_INBOX_LIMIT);
  }
  /** Whether the activation is new; a duplicate is not admitted again. */
  admit(activation: DirectMessageActivation): boolean {
    const key = activationKey(activation);
    if (this.keys.includes(key)) return false;
    this.keys.push(key);
    if (this.keys.length > PERCEPTION_INBOX_LIMIT) this.keys.shift();
    return true;
  }
  snapshot(): readonly string[] {
    return [...this.keys];
  }
}

export function activationKey(activation: DirectMessageActivation): string {
  return `${activation.kind}:${activation.sessionId}:${activation.messageId}`;
}

/**
 * Runs turn fibers for one actor. Within the owner, an activation already running joins that run
 * (coalescing duplicate wakeups), and a session's turns run one after another on its lane while
 * other sessions' lanes run concurrently.
 */
export class TurnFibers {
  private readonly running = new Map<string, Promise<TurnOutcome>>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  /** Acceptances in flight, by activation key: a duplicate joins one before its run exists. */
  private readonly accepting = new Map<string, Promise<TurnOutcome>>();
  /** Activations a live Talk request is waiting on, by activation key. */
  private readonly live = new Set<string>();
  constructor(private readonly host: TurnFiberHost) {}

  /** How many fibers this incarnation is running. */
  get active(): number {
    return this.running.size;
  }

  /**
   * Accepts a Caretaker message and runs its turn, streaming deltas to the first caller only. An
   * activation the perception inbox did not admit (a duplicate) joins this owner's acceptance or
   * run of that message without accepting it again; one this owner is not handling falls to the
   * fiber's key in PostgreSQL, which answers its stored receipt or resumes it.
   */
  talk(
    participant: ConversationParticipant,
    request: TalkRequest,
    emit: (frame: TalkStreamFrame) => void,
    admitted = true,
  ): Promise<TurnOutcome> {
    const key = activationKey({ kind: "direct_message", ...request });
    if (!admitted) {
      const joined = this.accepting.get(key) ?? this.running.get(key);
      if (joined !== undefined) return joined;
    }
    const accepting = this.accept(participant, request, emit);
    this.accepting.set(key, accepting);
    void accepting
      .finally(() => {
        if (this.accepting.get(key) === accepting) this.accepting.delete(key);
      })
      .catch(() => undefined);
    return accepting;
  }

  private async accept(
    participant: ConversationParticipant,
    request: TalkRequest,
    emit: (frame: TalkStreamFrame) => void,
  ): Promise<TurnOutcome> {
    let accepted: Awaited<ReturnType<ConversationStore["acceptTurn"]>> | undefined;
    for (let round = 0; accepted === undefined; ++round) {
      try {
        accepted = await this.store((store) => store.acceptTurn(participant, request));
      } catch (error) {
        if (!(error instanceof ConversationRefusedError && error.code === "conversation_busy"))
          throw error;
        // The session's open turn decides. One a live request is running here keeps the session
        // busy. One whose request died (its owner was lost) is resumed or joined here, and the new
        // message waits for it, then follows it, instead of being refused.
        const open = (
          await this.store((store) =>
            store.openTurns(participant, request.scope, this.host.actorId),
          )
        ).find((fiber) => fiber.sessionId === request.sessionId);
        if (round >= RESUME_ROUNDS) throw error;
        if (open === undefined) continue;
        if (this.live.has(activationKey({ kind: "direct_message", ...open }))) throw error;
        await this.activate(participant, open).catch(() => undefined);
      }
    }
    if (accepted.receipt !== undefined) return { receipt: accepted.receipt };
    if (accepted.fiber.phase === "accepted")
      await this.host.checkpointed(accepted.fiber, "accepted");
    const key = activationKey({ kind: "direct_message", ...accepted.fiber });
    this.live.add(key);
    try {
      return await this.activate(participant, accepted.fiber, emit);
    } finally {
      this.live.delete(key);
    }
  }

  /** Runs, or joins, the fiber of an accepted turn. */
  activate(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    emit: (frame: TalkStreamFrame) => void = () => undefined,
  ): Promise<TurnOutcome> {
    const key = activationKey({ kind: "direct_message", ...fiber });
    const joined = this.running.get(key);
    if (joined !== undefined) return joined;
    const lane = this.lanes.get(fiber.sessionId) ?? Promise.resolve();
    const run = lane
      .catch(() => undefined)
      .then(() => this.host.durable(fiber, participant, () => this.run(participant, fiber, emit)));
    const settled = run.finally(() => {
      this.running.delete(key);
      if (this.lanes.get(fiber.sessionId) === settled) this.lanes.delete(fiber.sessionId);
    });
    this.running.set(key, settled);
    this.lanes.set(fiber.sessionId, settled);
    return settled;
  }

  /** Resumes every open turn of the participant addressed to this actor. */
  async recover(
    participant: ConversationParticipant,
    scope: TurnFiber["scope"],
    actorId: string,
  ): Promise<number> {
    const open = await this.store((store) => store.openTurns(participant, scope, actorId));
    for (const fiber of open) void this.activate(participant, fiber).catch(() => undefined);
    return open.length;
  }

  private async run(
    participant: ConversationParticipant,
    accepted: TurnFiber,
    emit: (frame: TalkStreamFrame) => void,
  ): Promise<TurnOutcome> {
    let fiber = await this.store((store) =>
      store.claimTurn(participant, accepted, this.host.holder, this.host.capabilityRevision()),
    );
    if (fiber === undefined) return this.settled(participant, accepted);
    await this.host.checkpointed(fiber, fiber.phase);
    try {
      for (;;) {
        const current: TurnFiber = fiber;
        let next: TurnFiber | undefined;
        switch (current.phase) {
          case "context_pending":
            next = await this.store((store) => store.assembleTurn(participant, current));
            break;
          case "context_ready":
            next = await this.store((store) =>
              store.advanceTurn(participant, current, "model_running"),
            );
            break;
          case "model_running": {
            const { session, caretakerMessages, input, prompt } = await this.store((store) =>
              store.turnInput(participant, current),
            );
            await this.host.beforeModel?.(participant, current, {
              session,
              caretakerMessages,
              input,
              prompt,
            });
            const response = await this.host.respond(session, caretakerMessages, input, prompt);
            const words = response.text.split(/(?<= )/u);
            for (const [index, text] of words.entries()) {
              emit({ type: "delta", text });
              if (index === 0) await this.host.checkpointed(current, "model_running:streaming");
            }
            next = await this.store((store) => store.answerTurn(participant, current, response));
            break;
          }
          case "proposal_validating": {
            // A document proposal is validated where it commits, with the turn (issue 17). A
            // capability call is decided here, against the grants, before anything executes.
            const proposal = await this.store((store) =>
              store.commandProposal(participant, current),
            );
            if (proposal === undefined) {
              next = await this.store((store) =>
                store.advanceTurn(participant, current, "committing"),
              );
              break;
            }
            const record = await this.decideCommand(participant, current, proposal);
            next = await this.store((store) => store.recordCommand(participant, current, record));
            break;
          }
          case "committing":
            next = await this.store((store) => store.commitTurn(participant, current));
            break;
          case "finalizing":
            next = await this.store((store) => store.endTurn(participant, current, "completed"));
            break;
          default:
            return this.settled(participant, current);
        }
        if (next === undefined) return this.settled(participant, current);
        fiber = next;
        if (fiber.phase !== "completed") await this.host.checkpointed(fiber, fiber.phase);
      }
    } catch (error) {
      const failing = fiber;
      if (error instanceof ActivationGateBlockedError && error.status === "noop") {
        await this.store((store) => store.cancelTurn(participant, failing));
        throw error;
      }
      if (!(error instanceof ConversationRefusedError)) {
        // The attempt is recorded as failed at once; the turn stays open for its next claim.
        await this.store((store) => store.abandonAttempt(participant, failing)).catch(
          () => undefined,
        );
        throw error;
      }
      await this.store((store) => store.endTurn(participant, failing, "failed", error.code));
      return { refused: error.code };
    }
  }

  /** What became of a capability call: refused by the grants, or submitted as an ordinary command. */
  private async decideCommand(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    proposal: StoredCommandProposal,
  ): Promise<TurnCommandRecord> {
    const grants = this.host.grants?.(participant);
    if (grants === undefined || this.host.submitCommand === undefined)
      throw new Error("capability context unavailable");
    const decision = grants.authorize(proposal);
    if (!decision.accepted)
      return {
        capability: proposal.capability,
        commandId: null,
        status: "refused",
        code: decision.code,
        summary: `Refused before the world: ${decision.code}`,
      };
    // Read capabilities have no executor in this checkpoint; only a world command acts.
    if (decision.definition.effect !== "world_command")
      return {
        capability: proposal.capability,
        commandId: null,
        status: "refused",
        code: "not_executable",
        summary: "Refused before the world: not_executable",
      };
    const { objectId, kind } = decision.input as { objectId: string; kind: string };
    return this.host.submitCommand(participant, fiber, proposal, { objectId, kind });
  }

  /** The outcome of a turn this holder no longer moves: finished, or moved on by another. */
  private async settled(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): Promise<TurnOutcome> {
    const status = await this.store((store) => store.turnStatus(participant, fiber));
    if (status.phase === "completed")
      return { receipt: await this.store((store) => store.turnReceipt(participant, fiber)) };
    if (status.phase === "cancelled") return { refused: "turn_cancelled" };
    const code = status.outcomeCode;
    if (code !== null && code in CONVERSATION_REFUSAL_STATUS)
      return { refused: code as ConversationRefusedError["code"] };
    return { refused: "conversation_busy" };
  }

  private store<T>(operation: (store: ConversationStore) => Promise<T>): Promise<T> {
    return this.host.stores(operation);
  }
}

export class ActivationGateBlockedError extends Error {
  constructor(readonly status: "deferred" | "noop") {
    super(`activation ${status} before model escalation`);
    this.name = "ActivationGateBlockedError";
  }
}
