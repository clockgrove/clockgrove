import {
  type ContextExclusionRule,
  type ContextManifestEntry,
  type ContextSection,
  type DocumentKind,
  type DocumentOperation,
  type DocumentRefusalCode,
  MAX_DOCUMENT_OCTETS,
  resolveDocumentPath,
  type WriteClass,
} from "@clockgrove/contracts";
import { canonicalBytes, sha256Hex } from "@clockgrove/kernel";

/**
 * Authorized context assembly (Wave 5 §9, RW-0505; `docs/protocols/context-assembly.md`). Each
 * candidate is decided from its metadata alone; only an authorized candidate's text is read. The
 * ordering, token estimate and truncation are pure functions of the recorded inputs, so the same
 * inputs assemble the same manifest and prompt.
 */

/** Decision (issue 17 default): a turn's context holds at most 4,096 estimated tokens. */
export const CONTEXT_TOKEN_BUDGET = 4096;
/**
 * Decision: the newest 16 messages of the session are history candidates (eight turns), so a turn
 * reads a bounded number of protected messages however long its session grows.
 */
export const CONTEXT_HISTORY_WINDOW = 16;
/**
 * Decision (issue 359): whenever the session has history, actor-writable documents leave a quarter
 * of the budget to recent history, and every actor-writable document but the session's own summary
 * also leaves the summary's whole size (up to what the history reserve leaves), so a large working
 * document cannot crowd either out. Protected and governed documents are decided against the whole
 * budget. A reserve nothing uses goes to history, which is decided last.
 *
 * Why a quarter: under the default budget it is 1,024 estimated tokens, four chat lines of the
 * largest size (`MAX_CONVERSATION_TEXT_OCTETS`, 256 tokens) or 64 tokens for each message of the
 * full 16-message window, while the three quarters left (3,072 tokens) still admit a full-size
 * version (8,192 bytes, 2,048 tokens) beside the largest input and a summary of up to 768 tokens.
 * The trade is deliberate: past that, a full-size working document gives way to the summary and
 * history, which is the crowding-out this share exists to prevent.
 */
export const CONTEXT_HISTORY_SHARE = 0.25;
export const CONTEXT_PROMPT_VERSION = "context-prompt-v1";

const encoder = new TextEncoder();

/** Decision: ceil(UTF-8 bytes / 4), the common estimate for English text; no tokenizer is bound. */
export function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / 4);
}

/**
 * The most the model gateway's input measure (UTF-8 bytes, `inputTokenBound`) can charge for one
 * estimated token once rendered: an estimated token is at most 4 bytes, and JSON string escaping
 * turns one byte into at most 6 (`\u0000`).
 */
export const MEASURED_TOKENS_PER_ESTIMATED_TOKEN = 24;

/** The least input limit that leaves room for one estimated token beside the fixed parts. */
export function minimumInputLimitTokens(fixedInputTokens: number): number {
  return fixedInputTokens + MEASURED_TOKENS_PER_ESTIMATED_TOKEN;
}

/**
 * A turn's context budget under a model route's input limit, both in the gateway's measure: the
 * decided budget, lowered to whatever room the limit leaves after the request's fixed parts
 * (instructions, tool catalog, schemas, prompt framing). A limit with no room for one estimated
 * token is refused rather than clamped, so no turn silently assembles without its context.
 */
export function contextTokenBudget(
  inputLimitTokens: number,
  fixedInputTokens: number,
  budget: number = CONTEXT_TOKEN_BUDGET,
): number {
  const minimum = minimumInputLimitTokens(fixedInputTokens);
  if (!(inputLimitTokens >= minimum))
    throw new RangeError(
      `input limit ${inputLimitTokens} leaves no context room beside the request's fixed parts (${fixedInputTokens}); the minimum is ${minimum}`,
    );
  const room = Math.floor(
    (inputLimitTokens - fixedInputTokens) / MEASURED_TOKENS_PER_ESTIMATED_TOKEN,
  );
  return Math.min(budget, room);
}

/** The same estimate from a stored byte length, so the budget is decided before any text is read. */
export function tokensOfBytes(byteLength: number): number {
  return Math.ceil(byteLength / 4);
}

export function sourceHash(text: string): string {
  return sha256Hex(encoder.encode(text));
}

/**
 * The metadata of one actor document, as `actor_context_candidates` (0037) returns it. Another
 * session's summary is `foreignSession` and redacted: its path is `sessions/*\/summary.md` and its
 * session, hash and token estimate are withheld (`null`).
 */
export interface DocumentCandidate {
  readonly documentId: string;
  readonly path: string;
  readonly kind: DocumentKind;
  readonly writeClass: WriteClass;
  readonly sessionId: string | null;
  readonly foreignSession: boolean;
  readonly state: "active" | "archived";
  readonly version: number;
  readonly sourceHash: string | null;
  /** The head version's estimated tokens, from its stored byte length. */
  readonly tokens: number | null;
}

export interface MessageCandidate {
  readonly messageId: string;
  readonly sequence: number;
  readonly role: "caretaker" | "actor";
}

export interface ContextInputs {
  readonly sessionId: string;
  readonly inputMessageId: string;
  /** The session's message count: the input is message `inputRevision + 1`. */
  readonly inputRevision: number;
  /** The budget the turn was assembled under; a reassembly uses the manifest's recorded one. */
  readonly tokenBudget: number;
  readonly documents: readonly DocumentCandidate[];
  /** The session's messages up to the input revision, any order. */
  readonly messages: readonly MessageCandidate[];
  /** The newest messages that are history candidates; `CONTEXT_HISTORY_WINDOW` by default. */
  readonly historyWindow?: number;
  /**
   * How documents are decided: `shares` (the reserves of issue 359, the default for every new
   * turn) or `whole_budget`, every document against the whole budget, the rule manifests recorded
   * before the shares ran under. Only a reassembly names `whole_budget`.
   */
  readonly decisionRule?: ContextDecisionRule;
}

/** The document decision rules, newest first; a reassembly tries each until one reproduces. */
export const CONTEXT_DECISION_RULES = ["shares", "whole_budget"] as const;
export type ContextDecisionRule = (typeof CONTEXT_DECISION_RULES)[number];

export type ContextSource =
  | { readonly source: "document"; readonly documentId: string; readonly version: number }
  | { readonly source: "message"; readonly sequence: number }
  | { readonly source: "input" };

export interface PromptPart {
  readonly section: ContextSection;
  readonly label: string;
  readonly version: number;
  readonly text: string;
}

export interface AssembledContext {
  readonly tokenBudget: number;
  readonly tokensUsed: number;
  readonly manifestHash: string;
  readonly entries: readonly ContextManifestEntry[];
  /** Included sources in prompt order. */
  readonly parts: readonly PromptPart[];
  readonly input: string;
}

const KIND_ORDER: readonly DocumentKind[] = [
  "identity",
  "policy",
  "goals",
  "working_context",
  "session_summary",
];
const SECTION: Readonly<Record<WriteClass, ContextSection>> = {
  protected: "protected",
  governed: "governed",
  actor_writable: "untrusted",
};

/** The authorization decision for a document, from metadata only; `null` admits it. */
export function documentExclusion(
  document: DocumentCandidate,
  sessionId: string,
): ContextExclusionRule | null {
  if (document.foreignSession || (document.sessionId !== null && document.sessionId !== sessionId))
    return "other_session_private";
  if (document.state === "archived") return "document_archived";
  return null;
}

/** Candidate documents in prompt-candidate order: kind, then path, then document ID. */
function ordered(documents: readonly DocumentCandidate[]): DocumentCandidate[] {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...documents].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      compare(a.path, b.path) ||
      compare(a.documentId, b.documentId),
  );
}

export interface DocumentDecision {
  readonly document: DocumentCandidate;
  /** `null` admits the document into the prompt; only then is its text read. */
  readonly rule: ContextExclusionRule | null;
}

/**
 * Decides every document from metadata alone, after the input's tokens are reserved: the
 * authorization rules first, then the budget from the stored length. Protected and governed
 * documents are decided against the whole budget, as before the shares. Actor-writable documents
 * leave the history reserve (`CONTEXT_HISTORY_SHARE`) free, and every one but the session's own
 * summary also leaves the summary's whole size free while it still fits, so the summary is decided
 * as if ahead of them. A caller can therefore fetch exactly the admitted texts at once before
 * assembling.
 */
export function documentDecisions(
  inputs: ContextInputs,
  inputTokens: number,
): readonly DocumentDecision[] {
  const budget = inputs.tokenBudget;
  const shares = (inputs.decisionRule ?? "shares") === "shares";
  const historyReserve =
    shares && historyCandidates(inputs).length ? Math.floor(budget * CONTEXT_HISTORY_SHARE) : 0;
  const summary = inputs.documents.find(
    (document) =>
      ownSummary(document, inputs.sessionId) &&
      documentExclusion(document, inputs.sessionId) === null,
  );
  const summaryTokens = summary?.tokens ?? 0;
  let used = inputTokens;
  return ordered(inputs.documents).map((document) => {
    const rule = documentExclusion(document, inputs.sessionId);
    if (rule !== null) return { document, rule };
    const tokens = document.tokens ?? 0;
    let limit = budget;
    if (shares && document.writeClass === "actor_writable") {
      limit -= historyReserve;
      // The summary's room is kept only while the summary itself would still be admitted.
      if (document !== summary && used + summaryTokens <= limit) limit -= summaryTokens;
    }
    if (used + tokens > limit) return { document, rule: "token_budget" as const };
    used += tokens;
    return { document, rule: null };
  });
}

/** The session's own summary, the one document the summary share is kept for. */
function ownSummary(document: DocumentCandidate, sessionId: string): boolean {
  return (
    document.kind === "session_summary" &&
    !document.foreignSession &&
    document.sessionId === sessionId
  );
}

/** The history candidates, newest first: the window's newest messages at or before the input. */
function historyCandidates(inputs: ContextInputs): MessageCandidate[] {
  return inputs.messages
    .filter((message) => message.sequence <= inputs.inputRevision)
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, inputs.historyWindow ?? CONTEXT_HISTORY_WINDOW);
}

interface Draft {
  entry: Omit<ContextManifestEntry, "promptOrder">;
  text: string;
  order: number;
}

/**
 * Decides every candidate, reads only the admitted ones through `read`, then orders and truncates
 * them under the budget: the input first, then documents by kind and path, then history newest
 * first, keeping a contiguous newest suffix. Protected documents can only enter the protected
 * section and every untrusted source carries the untrusted label.
 */
export async function assembleContext(
  inputs: ContextInputs,
  read: (source: ContextSource) => Promise<string>,
): Promise<AssembledContext> {
  const drafts: Draft[] = [];
  const input = await read({ source: "input" });
  let used = estimateTokens(input);
  const included = (tokens: number) => used + tokens <= inputs.tokenBudget;
  for (const { document, rule } of documentDecisions(inputs, used)) {
    const base = {
      source: "document" as const,
      sourceId: document.documentId,
      version: document.version,
      label: document.path,
      scope:
        document.foreignSession || document.sessionId !== null
          ? ("session" as const)
          : ("actor" as const),
      writeClass: document.writeClass,
      sessionId: document.sessionId,
      state: document.state,
      trust:
        document.writeClass === "actor_writable" ? ("untrusted" as const) : ("trusted" as const),
    };
    if (rule !== null) {
      // Never read: the recorded hash and estimate are the candidate's own metadata.
      drafts.push({
        entry: {
          ...base,
          sourceHash: document.sourceHash,
          tokens: rule === "token_budget" ? (document.tokens ?? 0) : 0,
          decision: "excluded",
          rule,
          section: null,
        },
        text: "",
        order: 0,
      });
      continue;
    }
    const text = await read({
      source: "document",
      documentId: document.documentId,
      version: document.version,
    });
    const tokens = estimateTokens(text);
    if (tokens !== document.tokens || sourceHash(text) !== document.sourceHash)
      throw new Error("context document differs from its candidate metadata");
    used += tokens;
    const section = SECTION[document.writeClass];
    drafts.push({
      entry: {
        ...base,
        sourceHash: sourceHash(text),
        tokens,
        decision: "included",
        rule: null,
        section,
      },
      text,
      order: 1 + ["protected", "governed", "untrusted"].indexOf(section),
    });
  }
  const history = historyCandidates(inputs);
  let truncated = false;
  for (const message of history) {
    const text = await read({ source: "message", sequence: message.sequence });
    const tokens = estimateTokens(text);
    const fits = !truncated && included(tokens);
    if (fits) used += tokens;
    else truncated = true;
    drafts.push({
      entry: {
        source: "message",
        sourceId: message.messageId,
        version: message.sequence,
        label: message.role,
        scope: "session",
        writeClass: null,
        sessionId: inputs.sessionId,
        state: "active",
        sourceHash: sourceHash(text),
        tokens,
        decision: fits ? "included" : "excluded",
        rule: fits ? null : "token_budget",
        section: fits ? "untrusted" : null,
        trust: "untrusted",
      },
      text,
      // History follows the documents, oldest first.
      order: fits ? 4 + message.sequence / (inputs.inputRevision + 1) : 0,
    });
  }
  drafts.push({
    entry: {
      source: "input",
      sourceId: inputs.inputMessageId,
      version: inputs.inputRevision + 1,
      label: "caretaker",
      scope: "session",
      writeClass: null,
      sessionId: inputs.sessionId,
      state: "active",
      sourceHash: sourceHash(input),
      tokens: estimateTokens(input),
      decision: "included",
      rule: null,
      section: "untrusted",
      trust: "untrusted",
    },
    text: input,
    order: 6,
  });
  const ordered = drafts
    .map((draft, index) => ({ draft, index }))
    .filter(({ draft }) => draft.order > 0)
    .sort((a, b) => a.draft.order - b.draft.order || a.index - b.index);
  const promptOrder = new Map(ordered.map(({ draft }, position) => [draft, position + 1]));
  const entries: ContextManifestEntry[] = drafts.map((draft) => ({
    ...draft.entry,
    promptOrder: promptOrder.get(draft) ?? null,
  }));
  return {
    tokenBudget: inputs.tokenBudget,
    tokensUsed: used,
    manifestHash: manifestHash(inputs, entries),
    entries,
    parts: ordered.map(({ draft }) => ({
      section: draft.entry.section as ContextSection,
      label: draft.entry.label,
      version: draft.entry.version,
      text: draft.text,
    })),
    input,
  };
}

/** SHA-256 of the canonical encoding of the revision, budget and entries. */
export function manifestHash(
  inputs: Pick<ContextInputs, "sessionId" | "inputMessageId" | "inputRevision" | "tokenBudget">,
  entries: readonly ContextManifestEntry[],
): string {
  return sha256Hex(
    canonicalBytes({
      sessionId: inputs.sessionId,
      inputMessageId: inputs.inputMessageId,
      inputRevision: inputs.inputRevision,
      tokenBudget: inputs.tokenBudget,
      entries: entries.map((entry) => ({ ...entry })),
    }),
  );
}

/** The candidate inputs a recorded manifest names, so it can be assembled again. */
export function recordedInputs(
  manifest: Pick<
    import("@clockgrove/contracts").ContextManifest,
    "sessionId" | "inputMessageId" | "inputRevision" | "tokenBudget" | "entries"
  >,
): ContextInputs {
  const documents: DocumentCandidate[] = [];
  const messages: MessageCandidate[] = [];
  for (const entry of manifest.entries) {
    if (entry.source === "document") {
      if (entry.writeClass === null) continue;
      const foreignSession = entry.rule === "other_session_private";
      const kind = foreignSession ? "session_summary" : resolveDocumentPath(entry.label)?.kind;
      if (kind === undefined) continue;
      documents.push({
        documentId: entry.sourceId,
        path: entry.label,
        kind,
        writeClass: entry.writeClass,
        sessionId: entry.sessionId,
        foreignSession,
        state: entry.state,
        version: entry.version,
        sourceHash: entry.sourceHash,
        // An entry decided on the budget or included records the estimate it was decided on.
        tokens: entry.rule === null || entry.rule === "token_budget" ? entry.tokens : null,
      });
    } else if (entry.source === "message")
      messages.push({
        messageId: entry.sourceId,
        sequence: entry.version,
        role: entry.label === "actor" ? "actor" : "caretaker",
      });
  }
  return {
    sessionId: manifest.sessionId,
    inputMessageId: manifest.inputMessageId,
    inputRevision: manifest.inputRevision,
    tokenBudget: manifest.tokenBudget,
    documents,
    messages,
    // The recorded history entries are the turn's window, whatever the world's window was.
    historyWindow: messages.length,
  };
}

/** The exact prompt the model reads: sections in order, each untrusted part labelled. */
export function renderPrompt(
  header: Readonly<Record<string, string | number>>,
  context: AssembledContext,
): string {
  const section = (name: ContextSection) =>
    context.parts
      .filter((part) => part.section === name)
      .map((part) => ({
        ...(name === "untrusted" ? { trust: "untrusted" } : {}),
        source: part.label,
        version: part.version,
        text: part.text,
      }));
  return JSON.stringify({
    ...header,
    promptVersion: CONTEXT_PROMPT_VERSION,
    manifestHash: context.manifestHash,
    protected: section("protected"),
    governed: section("governed"),
    untrusted: section("untrusted"),
  });
}

/** A document change a model proposes: a path it returned and the content to write there. */
export interface DocumentProposal {
  readonly path: string;
  readonly content: string;
}

/**
 * The checks that need no stored state. A model proposal may only name an actor-writable path in
 * the grammar, and a summary only of its own session; an operator may name any path. Both are
 * bounded in size. The database guard (0037) refuses the same write classes again.
 */
export function operationRefusal(
  operation: DocumentOperation,
  proposer: { readonly kind: "operator" } | { readonly kind: "model"; readonly sessionId: string },
): DocumentRefusalCode | undefined {
  const resolved = resolveDocumentPath(operation.path);
  if (resolved === undefined) return "document_path_invalid";
  if (proposer.kind === "model") {
    if (resolved.writeClass !== "actor_writable") return "write_class_refused";
    if (resolved.sessionId !== null && resolved.sessionId !== proposer.sessionId)
      return "document_scope_refused";
  }
  if ("content" in operation && encoder.encode(operation.content).length > MAX_DOCUMENT_OCTETS)
    return "document_too_large";
  return undefined;
}
