import {
  CAPABILITY_REGISTRY,
  type CapabilityDefinition,
  type CapabilityEvidence,
  type CapabilityGrants,
  type ConversationParticipant,
  ConversationRefusedError,
  type ConversationResponder,
  type ConversationResponse,
  type ConversationStore,
  SELF_CAPABILITIES,
  type StoredCommandProposal,
  type TurnCommandRecord,
  type TurnFiber,
  type TurnInput,
  type TurnToolCall,
} from "@clockgrove/application";
import type { TalkReceipt, TalkRequest, TalkStreamFrame } from "@clockgrove/contracts";
import type { PreparedModelStep, PreparedResponder } from "./actor-model.js";
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

/** Owner decisions for tool-using turns (issue 165, 2026-11-09); composition supplies model pricing. */
export interface TurnResearchPolicy {
  readonly maxCalls: number;
  readonly maxModelSteps: number;
  readonly maxCostMicrousd: number;
  readonly modelStepReserveMicrousd: number;
}

export interface TurnResearchHost {
  readonly policy: TurnResearchPolicy;
  /** Enqueues or reads the deterministic call; undefined means canonical Queue work is pending. */
  executeTool(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    proposal: StoredCommandProposal,
    call: TurnToolCall,
  ): Promise<TurnToolCall | undefined>;
  /** Trusted composition reads canonical human approval; model/tool output cannot decide it. */
  approvalState?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    proposal: StoredCommandProposal,
    call: TurnToolCall,
  ): Promise<"not_required" | "waiting" | "approved" | "denied" | "expired" | "revoked">;
  /** Presentation only: observes the canonical attempt without dispatching or invoking cognition. */
  waitForToolStart?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    call: TurnToolCall,
  ): Promise<boolean>;
}

function citedReply(text: string, calls: readonly TurnToolCall[]): string {
  const recorded = calls.filter((call) => call.status !== "waiting");
  const citations = recorded.map((call) => `[tool:${call.callId}]`);
  const valid = new Set(citations);
  const clean = text
    .replace(/\[tool:[^\]\r\n]*\]/gu, (citation) =>
      valid.has(citation) ? "" : "[unverified tool citation]",
    )
    .trim();
  return citations.length === 0 ? clean : `${clean}\n\nResearch evidence: ${citations.join(" ")}`;
}

/** The owner-specific edges of a fiber: its lease holder, connection, checkpoint hook and keep-alive. */
export interface TurnFiberHost {
  readonly holder: string;
  /** The actor this owner serves. */
  readonly actorId: string;
  readonly stores: ConversationStores;
  readonly respond: ConversationResponder;
  /**
   * The same model step, built and measured before it is sent: a research turn reserves the step's
   * measured worst case instead of the policy's fixed reserve (issue 349).
   */
  readonly prepare?: PreparedResponder | undefined;
  readonly research?: TurnResearchHost | undefined;
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
  grants?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): CapabilityGrants | undefined | Promise<CapabilityGrants | undefined>;
  /** Submits an authorized world command through the ordinary world-command path. */
  submitCommand?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    proposal: StoredCommandProposal,
    call: { readonly objectId: string; readonly kind: string },
  ): Promise<TurnCommandRecord>;
  /**
   * Executes an accepted self capability (issue 322): the actor's own subscriptions, intentions,
   * perception listing, self-inspection and document write. Answers the record's status, code,
   * summary and result; the fiber adds the grant and arguments.
   */
  executeSelf?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    proposal: StoredCommandProposal,
    definition: CapabilityDefinition,
    input: unknown,
  ): Promise<SelfOutcome>;
  /**
   * Called once a reply has committed, with its text, and never awaited: shadow judging of the
   * reply (issue 271) runs beside the turn and can neither delay nor change it.
   */
  afterReply?(participant: ConversationParticipant, fiber: TurnFiber, reply: string): void;
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

/** What a self capability did: the step's outcome and its bounded result. */
export interface SelfOutcome {
  readonly status: "committed" | "refused";
  readonly code: string | null;
  readonly summary: string;
  readonly result: unknown;
}

/** The arguments recorded for a call; document text is private cognition, so only its digest. */
async function recordedArguments(capability: string, input: unknown): Promise<unknown> {
  if (capability === "document.write" && typeof input === "object" && input !== null) {
    const { path, content } = input as { path?: unknown; content?: unknown };
    if (typeof content === "string") {
      const bytes = new TextEncoder().encode(content);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return {
        path: typeof path === "string" ? path : null,
        octets: bytes.length,
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      };
    }
  }
  const text = JSON.stringify(input ?? null);
  return new TextEncoder().encode(text).length <= 4096 ? JSON.parse(text) : { truncated: true };
}

/**
 * Decision: the inbox remembers the last 256 activations. A duplicate it did not admit joins this
 * owner's acceptance or run of that message without accepting it again; the fiber row's key in
 * PostgreSQL is what makes any duplicate harmless, so forgetting an entry is safe.
 */
export const PERCEPTION_INBOX_LIMIT = 256;

/**
 * Decision: a new message resumes and waits for its session's abandoned turn at most 3 times.
 * Each round claims the turn under a new attempt; one normally settles it. A turn whose three
 * resumptions fail the same way is poison: it ends failed with `turn_resume_failed`, which the run
 * records and the person sees, and the message is accepted. Resumptions that fail differently
 * (still changing, so possibly transient) leave the turn open and the message answered busy.
 */
const RESUME_ROUNDS = 3;

/** The outcome code of a turn ended because every resumption failed the same way. */
export const TURN_RESUME_FAILED = "turn_resume_failed";

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
   * run only after PostgreSQL verifies the exact input and normalized envelope. One this owner
   * is not handling falls to the fiber's key, which answers its stored receipt or resumes it.
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
      if (joined !== undefined)
        return this.store((store) => store.acceptTurn(participant, request)).then(() => joined);
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
    const failures: string[] = [];
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
        if (round >= RESUME_ROUNDS) {
          const poisoned =
            open !== undefined &&
            failures.length === RESUME_ROUNDS &&
            failures.every((failure) => failure === failures[0]);
          if (!poisoned) throw error;
          const ended = await this.store((store) =>
            store.endTurn(participant, open, "failed", TURN_RESUME_FAILED),
          );
          if (ended === undefined) throw error;
          failures.length = 0;
          continue;
        }
        if (open === undefined) continue;
        if (this.live.has(activationKey({ kind: "direct_message", ...open }))) throw error;
        await this.activate(participant, open).then(
          () => (failures.length = 0),
          (failure: unknown) => {
            // Compared only to see whether the failure repeats; the text never leaves.
            failures.push(
              failure instanceof Error ? `${failure.name}:${failure.message}` : String(failure),
            );
          },
        );
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
    // Refresh admission before claiming so the attempt records its canonical revision.
    await this.host.grants?.(participant, accepted);
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
            let response: ConversationResponse | undefined;
            let prepared: PreparedModelStep | undefined;
            if (this.host.research !== undefined) {
              const policy = this.host.research.policy;
              // A step that cannot be built falls back to `respond`, which fails the same way.
              prepared = await this.host
                .prepare?.(session, caretakerMessages, input, prompt)
                .catch(() => undefined);
              const reserveMicrousd = prepared?.reserveMicrousd ?? policy.modelStepReserveMicrousd;
              const reserved = await this.store((store) =>
                store.reserveModelStep!(participant, current, {
                  maxModelSteps: policy.maxModelSteps,
                  maxCostMicrousd: policy.maxCostMicrousd,
                  reserveMicrousd,
                }),
              );
              if (reserved === "fenced") return this.settled(participant, current);
              if (reserved !== "reserved") {
                response = {
                  text: `Research stopped: ${reserved}. No further action was taken.`,
                  outcomeCode: reserved,
                };
              }
            }
            if (response === undefined) {
              try {
                response =
                  prepared === undefined
                    ? await this.host.respond(session, caretakerMessages, input, prompt)
                    : await prepared.send(async (reserveMicrousd) => {
                        // A fallback route reserves its own worst case against what is left of
                        // the turn's cap before it is tried (issue 349).
                        const policy = this.host.research?.policy;
                        if (policy === undefined) return true;
                        const decision = await this.store((store) =>
                          store.reserveModelRoute!(participant, current, {
                            maxCostMicrousd: policy.maxCostMicrousd,
                            reserveMicrousd,
                          }),
                        );
                        if (decision === "reserved") return true;
                        if (decision === "cost_budget_exhausted") return false;
                        // A fenced turn is not a spent budget: the step fails as unavailable and
                        // the fenced answer is refused where it commits.
                        throw new Error(`model_route_${decision}`);
                      });
              } catch (error) {
                if (this.host.research === undefined) throw error;
                // Provider exception text can contain prompts or credentials; only a fixed state leaves.
                response = {
                  text: "Model unavailable. I could not finish this turn.",
                  outcomeCode: "model_unavailable",
                };
              }
            }
            if (this.host.research !== undefined) {
              if (
                response.command !== undefined &&
                !/^[!-~]{1,4096}$/u.test(response.command.capability)
              )
                response = {
                  text: "Model unavailable. The model returned an invalid tool proposal.",
                  outcomeCode: "model_unavailable",
                  ...(response.usage === undefined ? {} : { usage: response.usage }),
                };
              const state = await this.store((store) => store.researchState!(participant, current));
              response = { ...response, text: citedReply(response.text, state.calls) };
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
            // Existing world-command behavior stays on its ordinary Journal path. A read gets
            // a durable identity before admission or Queue publication can happen.
            if (
              this.host.research !== undefined &&
              proposal.capability !== "world.command" &&
              !SELF_CAPABILITIES.has(proposal.capability)
            ) {
              const state = await this.store((store) => store.researchState!(participant, current));
              if (state.calls.length >= this.host.research.policy.maxCalls) {
                next = await this.store((store) =>
                  store.stopResearch!(
                    participant,
                    current,
                    "tool_calls_exhausted",
                    citedReply(
                      "Research stopped: tool_calls_exhausted. No further action was taken.",
                      state.calls,
                    ),
                  ),
                );
              } else {
                const digest = await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(
                    JSON.stringify([
                      current.scope.tenantId,
                      current.sessionId,
                      current.messageId,
                      state.calls.length + 1,
                    ]),
                  ),
                );
                const callId = `tool:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
                next = await this.store((store) =>
                  store.waitForTool!(participant, current, {
                    callId,
                    effectId: callId,
                    capability: proposal.capability,
                  }),
                );
              }
              break;
            }
            // Decided while the store holds the turn: a cancel and the submission exclude each other.
            next = await this.store((store) =>
              store.recordCommand(participant, current, () =>
                this.decideCommand(participant, current, proposal),
              ),
            );
            break;
          }
          case "approval_waiting":
          case "tool_waiting": {
            const state = await this.store((store) => store.researchState!(participant, current));
            const call = state.calls.at(-1);
            const proposal = await this.store((store) =>
              store.commandProposal(participant, current),
            );
            if (call === undefined || proposal === undefined || this.host.research === undefined)
              throw new Error("tool checkpoint unavailable");
            const approval = await this.host.research.approvalState?.(
              participant,
              current,
              proposal,
              call,
            );
            if (approval === "waiting") {
              if (current.phase === "tool_waiting") {
                next = await this.store((store) => store.waitForApproval!(participant, current));
                break;
              }
              return { refused: "conversation_busy" };
            }
            if (approval === "denied" || approval === "expired" || approval === "revoked") {
              next = await this.store((store) =>
                store.completeTool!(participant, current, {
                  ...call,
                  status: "refused",
                  code: `approval_${approval}`,
                  text: `Tool refused: approval_${approval}`,
                  costMicrousd: 0,
                }),
              );
              break;
            }
            if (current.phase === "approval_waiting") {
              // Losing trusted approval composition must never turn a durable wait into permission.
              if (approval !== "approved") return { refused: "conversation_busy" };
              next = await this.store((store) => store.resumeAfterApproval!(participant, current));
              break;
            }
            if (call.approvalRequired && approval !== "approved")
              return { refused: "conversation_busy" };
            emit({
              type: "tool",
              callId: call.callId,
              capability: call.capability,
              status: "queued",
            });
            const result = await this.host.research.executeTool(
              participant,
              current,
              proposal,
              call,
            );
            if (
              result?.status !== "refused" &&
              result?.status !== "simulated" &&
              (await this.host.research.waitForToolStart?.(participant, current, call))
            )
              emit({
                type: "tool",
                callId: call.callId,
                capability: call.capability,
                status: "using",
              });
            if (result === undefined || result.status === "waiting")
              return { refused: "conversation_busy" };
            next = await this.store((store) =>
              store.completeTool!(participant, current, {
                ...result,
                status: result.status as Exclude<TurnToolCall["status"], "waiting">,
              }),
            );
            emit({
              type: "tool",
              callId: call.callId,
              capability: call.capability,
              status:
                result.status === "succeeded" || result.status === "simulated"
                  ? "completed"
                  : "failed",
            });
            break;
          }
          case "tool_completed":
            next = await this.store((store) => store.resumeAfterTool!(participant, current));
            break;
          case "committing": {
            next = await this.store((store) => store.commitTurn(participant, current));
            if (next !== undefined) {
              // Text leaves the actor only after the reply and its governed reservation commit.
              fiber = next;
              const committed = next;
              const receipt = await this.store((store) =>
                store.turnReceipt(participant, committed),
              );
              try {
                this.host.afterReply?.(participant, committed, receipt.reply.text);
              } catch {}
              const words = receipt.reply.text.split(/(?<= )/u);
              for (const [index, text] of words.entries()) {
                emit({ type: "delta", text });
                if (index === 0) await this.host.checkpointed(next, "model_running:streaming");
              }
            }
            break;
          }
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

  /**
   * What became of a capability call: refused by the grants, submitted as an ordinary command, or
   * executed as one of the actor's self capabilities. The record carries the deciding grant, the
   * call's arguments and its result as run evidence.
   */
  private async decideCommand(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    proposal: StoredCommandProposal,
  ): Promise<TurnCommandRecord> {
    const grants = await this.host.grants?.(participant, fiber);
    if (grants === undefined || this.host.submitCommand === undefined)
      throw new Error("capability context unavailable");
    const held = grants.grants.find((grant) => grant.capability === proposal.capability);
    const definition =
      grants.availableDefinitions().find((d) => d.name === proposal.capability) ??
      CAPABILITY_REGISTRY.get(proposal.capability);
    const evidence = async (result: unknown): Promise<CapabilityEvidence> => ({
      grant:
        held === undefined
          ? null
          : {
              capability: held.capability,
              callsPerTurn: held.callsPerTurn,
              requiredRuntimeGrant: definition?.requiredRuntimeGrant ?? "",
            },
      arguments: await recordedArguments(proposal.capability, proposal.input),
      result,
    });
    const decision = grants.authorize(proposal);
    if (!decision.accepted)
      return {
        capability: proposal.capability,
        commandId: null,
        status: "refused",
        code: decision.code,
        summary: `Refused before the world: ${decision.code}`,
        evidence: await evidence({ refused: decision.code }),
      };
    if (
      decision.definition.remoteMcp === undefined &&
      SELF_CAPABILITIES.has(decision.definition.name) &&
      this.host.executeSelf !== undefined
    ) {
      const outcome = await this.host.executeSelf(
        participant,
        fiber,
        proposal,
        decision.definition,
        decision.input,
      );
      return {
        capability: proposal.capability,
        commandId: null,
        status: outcome.status,
        code: outcome.code,
        summary: outcome.summary,
        evidence: await evidence(outcome.result),
      };
    }
    // Other reads have no executor on this path; only a world command acts.
    if (
      decision.definition.remoteMcp !== undefined ||
      decision.definition.effect !== "world_command"
    )
      return {
        capability: proposal.capability,
        commandId: null,
        status: "refused",
        code: "not_executable",
        summary: "Refused before the world: not_executable",
        evidence: await evidence({ refused: "not_executable" }),
      };
    const { objectId, kind } = decision.input as { objectId: string; kind: string };
    const record = await this.host.submitCommand(participant, fiber, proposal, { objectId, kind });
    return {
      ...record,
      evidence: await evidence({
        commandId: record.commandId,
        status: record.status,
        code: record.code,
      }),
    };
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
