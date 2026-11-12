import type {
  BrowserScope,
  ConversationChannel,
  ConversationSession,
  ConversationTranscript,
  ObjectId,
  SourceIdentityAssertion,
  TalkReceipt,
  TalkRequest,
  TurnPhase,
  TurnRequest,
  TurnStatus,
  VoiceMode,
  WorldPersonaId,
} from "@clockgrove/contracts";

import type { DocumentProposal } from "./cognition.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";

/** The participant a conversation call acts for: the authorized principal and their world persona. */
export interface ConversationParticipant extends RuntimeAuthorizationContext {
  readonly personaId: WorldPersonaId;
  readonly sourceIdentityAssertion?: SourceIdentityAssertion;
}

/** What the store needs to open a session; the caller has already checked the addressed actor. */
export interface OpenConversation {
  readonly scope: BrowserScope;
  readonly actorId: ObjectId;
  readonly voiceMode: VoiceMode;
  readonly title?: string;
  readonly channel?: ConversationChannel;
  readonly threadId?: string;
}

/**
 * The answer a turn records. It sees only the number of Caretaker messages its own session will
 * hold once this one is stored; it never sees another session.
 */
export type ConversationResponder = (
  session: ConversationSession,
  caretakerMessages: number,
  input: string,
  /** The turn's assembled prompt: its protected, governed and untrusted context sections. */
  prompt: string,
) => ConversationResponse | Promise<ConversationResponse>;

/**
 * The model's answer: its reply, and at most one proposal: a document change (issue 17) or a
 * capability call (issue 19). Neither is authority; each is decided where it commits.
 */
export interface ConversationResponse {
  readonly text: string;
  /** System failure/bound marker; never derived from model or tool text. */
  readonly outcomeCode?: string;
  readonly proposal?: DocumentProposal;
  readonly command?: CapabilityCall;
  /** The model call's measured usage; absent for the free fixture. */
  readonly usage?: ModelUsage;
}

export interface ModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicrousd: number | null;
}

/** A capability the model proposes to call, undecided: the registry's grants decide it. */
export interface CapabilityCall {
  readonly capability: string;
  readonly input: unknown;
  /** The partition revision the actor perceived when it proposed: the command's expected one. */
  readonly expectedRevision?: string;
}

/** A command proposal as checkpointed with the answer; `issuedAt` keeps a retried command's bytes. */
export interface StoredCommandProposal extends CapabilityCall {
  readonly issuedAt: string;
}

/** What became of a turn's command proposal, recorded as its run's `world_command_proposal` step. */
export interface TurnCommandRecord {
  readonly capability: string;
  readonly commandId: string | null;
  readonly status: "committed" | "refused";
  /** A stable `[a-z_]` reason when refused. */
  readonly code: string | null;
  readonly summary: string;
}

export interface TurnToolCall {
  /** Set only by trusted approval checkpointing; survives the transition back to tool_waiting. */
  readonly approvalRequired?: boolean;
  readonly callId: string;
  readonly effectId: string;
  readonly capability: string;
  readonly status: "waiting" | "succeeded" | "failed" | "uncertain" | "refused" | "simulated";
  readonly code: string | null;
  /** Sanitized, untrusted evidence only; stored in an encrypted artifact. */
  readonly text: string;
  readonly resultArtifactId: string | null;
  readonly grantId: string | null;
  readonly queueLatencyMs?: number | null;
  readonly costMicrousd?: number | null;
}
export interface TurnResearchState {
  readonly modelSteps: number;
  readonly reservedModelMicrousd: number;
  readonly knownCostMicrousd: number;
  readonly unknownCostCount: number;
  readonly calls: readonly TurnToolCall[];
}
export interface TurnModelStepLimits {
  readonly maxModelSteps: number;
  readonly maxCostMicrousd: number;
  readonly reserveMicrousd: number;
}
export type TurnModelStepReservation =
  | "reserved"
  | "model_steps_exhausted"
  | "cost_budget_exhausted"
  | "fenced";

/**
 * Canonical private conversations. Every call is scoped to the participant: a session of another
 * principal, tenant, world or timeline, or a deleted one, is not found.
 */
export interface ConversationStore {
  open(participant: ConversationParticipant, input: OpenConversation): Promise<ConversationSession>;
  list(
    participant: ConversationParticipant,
    scope: BrowserScope,
    actorId?: ObjectId,
  ): Promise<readonly ConversationSession[]>;
  read(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
    afterSequence: number,
    limit: number,
  ): Promise<ConversationTranscript>;
  title(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
    title: string,
  ): Promise<ConversationSession>;
  archive(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
    archived: boolean,
  ): Promise<ConversationSession>;
  delete(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
  ): Promise<void>;
  /**
   * Accepts a Caretaker message as a turn (Wave 5 §7): its stored receipt when it already
   * committed, or its fiber, new or the one an earlier delivery of the same message accepted.
   */
  acceptTurn(participant: ConversationParticipant, request: TalkRequest): Promise<TurnAcceptance>;
  /**
   * Claims the turn for an owner incarnation: a new lease epoch, and a new run unless the turn has
   * already committed. The previous holder's open run is abandoned. Undefined when it is finished.
   */
  claimTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    holder: string,
    capabilityRevision: number,
  ): Promise<TurnFiber | undefined>;
  /** Assembles the turn's context (the session revision it reads) and checkpoints `context_ready`. */
  assembleTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): Promise<TurnFiber | undefined>;
  /** The actor a session addresses: the owner its turns route to. */
  actorOf(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
  ): Promise<string>;
  /** Checkpoints the next phase; undefined when the lease or phase moved on (fenced). */
  advanceTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    to: TurnPhase,
  ): Promise<TurnFiber | undefined>;
  /** What the turn's model reads: its session, its Caretaker message count and its input text. */
  turnInput(participant: ConversationParticipant, fiber: TurnFiber): Promise<TurnInput>;
  /** Stores the model's answer (its reply and any proposal) and checkpoints `proposal_validating`. */
  answerTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    response: ConversationResponse,
  ): Promise<TurnFiber | undefined>;
  /** The command the answer proposed, read back from its checkpoint; undefined when it proposed none. */
  commandProposal(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): Promise<StoredCommandProposal | undefined>;
  /** Records the command's outcome on the run and checkpoints `committing`, in one transaction. */
  recordCommand(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    record: TurnCommandRecord,
  ): Promise<TurnFiber | undefined>;
  stopResearch?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    code: string,
    text: string,
  ): Promise<TurnFiber | undefined>;
  researchState?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): Promise<TurnResearchState>;
  reserveModelStep?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    limits: TurnModelStepLimits,
  ): Promise<TurnModelStepReservation>;
  waitForTool?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    call: Pick<TurnToolCall, "callId" | "effectId" | "capability">,
  ): Promise<TurnFiber | undefined>;
  waitForApproval?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): Promise<TurnFiber | undefined>;
  resumeAfterApproval?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): Promise<TurnFiber | undefined>;
  completeTool?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    result: TurnToolCall & { readonly status: Exclude<TurnToolCall["status"], "waiting"> },
  ): Promise<TurnFiber | undefined>;
  resumeAfterTool?(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): Promise<TurnFiber | undefined>;
  /** Commits the message, the reply and the turn with `finalizing`, in one transaction. */
  commitTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): Promise<TurnFiber | undefined>;
  /** Ends the turn: `completed` releases it; `failed` also fails its run with the refusal code. */
  endTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    phase: "completed" | "failed",
    outcomeCode?: string,
  ): Promise<TurnFiber | undefined>;
  /**
   * Closes the attempt's run `abandoned` with `attempt_failed` after an unexpected error, leaving
   * the turn open: its next claim resumes it under a new run.
   */
  abandonAttempt(participant: ConversationParticipant, fiber: TurnFiber): Promise<void>;
  /** The committed receipt of a completed turn. */
  turnReceipt(participant: ConversationParticipant, fiber: TurnFiber): Promise<TalkReceipt>;
  turnStatus(participant: ConversationParticipant, request: TurnRequest): Promise<TurnStatus>;
  /** Cancels a turn that has not started committing; otherwise answers its status unchanged. */
  cancelTurn(participant: ConversationParticipant, request: TurnRequest): Promise<TurnStatus>;
  /** The participant's open turns addressed to the actor, oldest first. */
  openTurns(
    participant: ConversationParticipant,
    scope: BrowserScope,
    actorId: string,
  ): Promise<readonly TurnFiber[]>;
}

/** A turn's model input, read from its checkpoint. */
export interface TurnInput {
  readonly session: ConversationSession;
  readonly caretakerMessages: number;
  readonly input: string;
  /** The assembled prompt stored with the turn's run (`renderPrompt`). */
  readonly prompt: string;
}

/** A turn fiber's durable checkpoint (migration 0038). */
export interface TurnFiber {
  readonly scope: BrowserScope;
  readonly sessionId: string;
  readonly messageId: string;
  readonly actorId: string;
  readonly principalId: string;
  readonly personaId: WorldPersonaId;
  readonly phase: TurnPhase;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly runId: string | null;
  readonly inputArtifactId: string;
  readonly replyArtifactId: string | null;
  /** The model's checkpointed document proposal (a `private_cognition` artifact), if it made one. */
  readonly proposalArtifactId: string | null;
  /** The session's message count the turn read, once its context is assembled. */
  readonly inputRevision: number | null;
  readonly outcomeCode: string | null;
}

export type TurnAcceptance =
  | { readonly receipt: TalkReceipt; readonly fiber?: undefined }
  | { readonly fiber: TurnFiber; readonly receipt?: undefined };

export type ConversationRefusalCode =
  | "channel_identity_unverified"
  | "channel_thread_reused"
  | "reply_not_found"
  | "conversation_not_found"
  | "conversation_not_active"
  | "conversation_full"
  | "conversation_limit_reached"
  | "message_id_reused"
  | "conversation_busy"
  | "turn_not_found"
  | "turn_cancelled";

/** A refused conversation call; nothing was changed. */
export class ConversationRefusedError extends Error {
  constructor(readonly code: ConversationRefusalCode) {
    super(`conversation refused: ${code}`);
    this.name = "ConversationRefusedError";
  }
}
