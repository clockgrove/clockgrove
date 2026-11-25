# Authorized context assembly and governed actor documents

Wave 5 §5.3 and §9, RW-0505, local path (issue 17). An actor has governed, versioned Markdown
documents. Each model turn assembles its context authorization-first and records a context
manifest. The manifest lists every candidate source with its exact version, trust label and
decision, and names the rule for each candidate it excluded. It can be reproduced from its
recorded inputs.

Today the only turns are Caretaker Talk attempts ([private conversations](conversations.md)),
answered by the scripted model fixture. Their runs are [run and step evidence](runs.md).

## Documents

A document belongs to one actor of one world timeline (migration 0037). It has a stable ID
(`document-<uuid>`) for its logical path and immutable versions numbered from 1. Each version
records its exact text, its `byteLength`, its `sourceHash` (the SHA-256 hex of its UTF-8 text,
recomputed by a database CHECK), its state (`active` or `archived`) and the change set that wrote
it. The paths form a closed grammar. The path fixes the kind, and the kind fixes the write class:

| Path | Kind | Write class |
| --- | --- | --- |
| `identity.md` | `identity` | `protected` |
| `policy.md` | `policy` | `protected` |
| `goals.md` | `goals` | `governed` |
| `working-context.md` | `working_context` | `actor_writable` |
| `sessions/<sessionId>/summary.md` | `session_summary` | `actor_writable` |

Nothing is normalised. `./policy.md`, `Policy.md`, `../policy.md` and any other path are refused
`document_path_invalid`.

### Change sets

Every write is a change set of 1 to 8 operations over one actor's documents, all or nothing:

- `create` takes a path and content.
- `patch` takes a path, `expectedVersion` and the whole new content.
- `archive` takes a path and `expectedVersion`. It writes a final version with the last text and
  state `archived`. An archived document never changes again.

Before commit, a change set checks:

- the expected version (the head);
- authority;
- the write class;
- the limits: at most 8,192 bytes a version (`document_too_large`), 8 operations a change set
  (`change_set_too_large`), 256 documents an actor (`document_limit_reached`) and 1,000 versions a
  document (`version_limit_reached`);
- provenance: the change set names its proposer (`operator` or `model`), principal, persona, actor
  and, for a model, its run and session.

A refused change set writes nothing but its own refusal row, which names the code and the operation
(from 1) that caused it. The refusal codes are `document_path_invalid`, `write_class_refused`,
`document_scope_refused`, `document_exists`, `document_not_found`, `document_archived`,
`version_conflict`, `document_too_large`, `change_set_too_large`, `document_limit_reached`,
`version_limit_reached` and `change_set_reused`. Each document changes at most once per change
set.

The database guards (`guard_actor_document_version`, `SECURITY DEFINER`) apply the same rules to
every writer:

- A model proposal writes only an `actor_writable` document, and a session summary only of its own
  session (`CG023`).
- An operator change set needs the `private_cognition` category (`CG023`).
- A version follows its document's head, and an archived document never changes (`CG024`).
- An actor holds at most 256 documents (`CG022`).

So a path a model returns can never select a protected or governed target, whatever the
application does.

### Operator mute

`POST /v1/runtime/actor-mute` (issue 374, G8) takes version 1, the flat authorized scope, `actorId`,
`sessionId` (a conversation of that actor, or `null` for the whole actor) and `muted`. It needs the
change set's authority: the `runtime:actor-govern` grant and a `private_cognition` ceiling, under
the inspector rate limit, and each request is audited in `inspector_accesses` as `actor-mute`. It
answers the mute as it now stands, `{ actorId, sessionId, muted, version, changedBy, changedAt }`;
`version` counts every change. A session that is not the actor's answers `404
conversation_not_found`; a caller without the grant `403 authorization_refused`.

A mute takes effect when it commits (`actor_mutes`, migration 0078). Each start reads it in its own
transaction through `clockgrove.actor_muted`, so nothing waits for a model call:

- **Turns.** A muted actor or conversation accepts no Talk, and no wake, and claims no turn that was
  accepted before the mute: Talk answers `409 conversation_muted`, and a wake settles with that
  outcome. No run opens, so no model is called. An accepted turn stays open and resumes once
  unmuted. A turn already inside its model call when the mute lands is not interrupted; its
  delivery and effects are stopped as below.
- **Deliveries.** A new or held delivery is recorded `rejected` with reason `actor_muted`, and
  nothing is sent. A wake session is muted with the conversation it wakes.
- **Effects.** A pending effect of a muted actor, or of a run in a muted conversation, is recorded
  `refused` with `actor_muted` instead of being claimed, on every claim path, so its tool is never
  called.

`muted: false` lifts the mute. Withdrawn delivery consent stops held deliveries the same way: they
are `rejected` with `consent_required` when next checked ([channels](channels.md)).

### Proposers

- **Operator:** `POST /v1/runtime/actor-documents/change` needs the `runtime:actor-govern` grant,
  which no other grant implies, and a `private_cognition` ceiling. It writes any class. It answers
  `{ changeSetId, status: "committed", documents }`, where each document carries its `documentId`,
  `path`, `version`, `state` and `sourceHash`. A refusal answers
  `409 { error, changeSetId, operation }`.
- **Model:** the turn's model may propose one document change. It returns a path and content. The
  store creates the path, or patches its head, inside the turn's transaction as a change set
  `<runId>:documents`. The run records this as a `validation` step: `succeeded`, or `failed` with
  the refusal code. A refused proposal does not fail the turn. The scripted fixture proposes when
  the Caretaker text's first line is `fixture:propose <path>`; the rest of the text is the content.
  That trigger lives only in the scripted provider fixture (`scriptedConversationReply`); no
  production path parses Caretaker text into a proposal. A proposal reaches the store only as the
  model responder's returned `proposal`.
  The model can also call the `document.write` capability (issue 322;
  [capabilities](capabilities.md#self-capabilities)) with `path` and `content`, in the production
  responder as in the fixture. Its grant, call budget and revocation are decided before anything is
  written; an accepted call commits with the turn through this same change set and `validation`
  step, so its write classes, limits and provenance are a model proposal's. A path outside
  `actor_writable` is refused `write_class_refused` before commit and recorded on the call.
  Wave 6 owns governed adoption of model proposals to `governed` documents.
  The actor's newest recorded self capability results enter its next prompt outside the manifest,
  beside the untrusted tool catalog, in an `UNTRUSTED SELF CAPABILITY RESULTS` section
  ([capabilities](capabilities.md#self-capabilities)); they are run evidence, not a context source,
  so the manifest hash and replay are unchanged. Its own standing subscriptions and intentions, with
  their ids, enter beside them in an `UNTRUSTED STANDING CONFIGURATIONS` section, read from its
  activation policy's configurations (issue 354), also outside the manifest. A failed read fails
  the step, as a failed self-results read does, so the section is never silently missing.
  The prompt's `You perceive:` digest lists what the actor itself perceives (issue 354), by the
  kernel resolver's location rule (`space-contents`, [perception](../../packages/kernel/docs/perception.md)):
  the active entities of the actor's own space, within the member's authorized scene, so privacy
  never widens. The resolver's modality-range rule is not applied: it excludes a `space-contents`
  observer when no range is declared, and a runtime world declares no perception policy (its scene
  audience passes no modalities), so the rule would leave every actor perceiving nothing by
  location. Until a world can declare ranges, the actor's space is its range. An actor that is not an entity of the world state perceives that scene. Entities
  the message names, by object id or scene label (case-insensitive), come first, then the nearest
  to the actor by squared distance in its own frame, then those in another frame, ties by object
  id in UTF-16 order. The order reads only the state at the perceived revision and the message, so
  replay perceives the same. At most 24 entities and 8 KiB are listed (issue 349), and a final line
  counts the perceived entities left out.

`POST /v1/runtime/actor-documents/read` takes `actorId`, `path` and an optional `version` (meant as
the document version, default the head). The request envelope's own `version` is that same key and
must be 1, so today a read always names version 1 (a known defect, left for a follow-up because
fixing it changes the wire format). It answers that version with its text and provenance
(`changeSetId`, `proposer`, `principalId`, `runId`) and the versions' retention policy,
`retention`: `{ policy: "world_lifetime", maxVersions: 1000, maxDocumentBytes: 8192,
maxDocuments: 256 }`. Every version is kept for the world's life (issue 17 decision;
`db/retention.json`) within those bounds, so the first version stays readable after later ones.
The read is under `runtime:world-inspect` and a `private_cognition` ceiling. An unknown path or
version answers `404 document_not_found`.

### Who reads documents

A reader whose ceiling holds `private_cognition` reads every document of the tenant. A participant
of a session that addresses the actor reads the actor's documents too, so context can be assembled
for that session. They never read another session's summary (RLS). Document text is private
cognition. It never enters scene state, the journal or any projection.

## Context assembly

Each Talk attempt assembles its context before its run opens, all under the participant's own
authorization:

1. **Candidates.** `actor_context_candidates(tenant, session)` returns the metadata of every
   document of the session's actor (path, kind, write class, session, state, head version, source
   hash, byte length), and only to a participant of that session. Another session's summary is
   returned redacted, flagged `foreign_session`: its path reads `sessions/*/summary.md` and its
   session, hash and length are `null`, so a participant learns neither that session's ID nor its
   summary's hash or size. The history candidates are the newest messages of the session at or
   before its input revision, as many as the world's history window (16 by default). The turn's input is a candidate too.
2. **Authorization, before any text is read.** A document is excluded `other_session_private` when
   it is another session's summary, or `document_archived` when it is archived. Its hash in the
   manifest is the metadata's (`null` for another session's summary), and its text is never read.
3. **Budget.** The turn's budget is the world's budget (the decided 4,096 estimated tokens by
   default; see [world settings](#world-context-settings)), lowered when the model
   route's input limit leaves less room (`contextTokenBudget`, issue 349). That room is the alias's
   `maxInputTokens`, less the request's fixed parts, divided by 24. The limit and the fixed parts are
   both in the [model gateway's](../../packages/model-gateway/docs/model-gateway.md#budget) input
   measure, UTF-8 bytes, which is never below the real token count. The runtime keeps 311,920 for
   the fixed parts (`ACTOR_FIXED_INPUT_TOKENS`), from the repository's own bounds: the turn's tool
   evidence (at most one call per model step, four; each call's text cut to 8 KiB before it enters
   model context, escaped by JSON to at most 6 bytes a byte, plus 12,288 of the call's framing),
   and 65,536 for the rest:
   the system text, the tool catalog, recorded self results, the input's second copy, the output
   schema and the sections' framing. Where the request is built, the tool catalog gets only what
   that 65,536 has left once the rest is measured and 8,192 is kept for the prompt's own framing:
   entries that do not fit are left out and counted in a closing note (`fittedCatalog`), so a
   catalog of any size never overruns it. The other parts are bounded where they are made: a
   configured identity at 4 KiB and scene label at 256 bytes, the scene digest at 8 KiB, self
   results at 16 KiB and the input at 1 KiB. An estimated token renders to at most 24 measured tokens: at
   most 4 bytes, each escaped by JSON to at most 6. A context within the budget therefore never
   makes a request, research steps included, that the
   gateway refuses for size. Under the production limit (998,976) the budget stays 4,096. Without
   a model route (the scripted fixture), it is 4,096. A world model configuration whose actor alias
   leaves no room for one estimated token (a limit below 311,944) is refused when it is read, with
   the alias, its limit, the fixed parts and the minimum named, so an actor never answers without
   its summary and history for want of room. `contextTokenBudget` itself refuses such a limit
   rather than clamping it to a budget of one. Each research step reserves one route at a time
   (owner decision): before it is sent, its primary route's worst case for the exact request;
   if that route fails over, the fallback route's own worst case against what is left of the
   turn's cost cap (`reserve_turn_model_route`, through the gateway's `admitFallback`). A fallback
   that does not fit is never called, and the step ends `cost_budget_exhausted`.
   Once the step's answer is recorded with a known cost, the rest of its reservation is released
   (`settle_turn_model_step`, migration 0071); a step whose cost is unknown keeps all of it.
   The input is reserved first. Then documents in kind order (identity, policy, goals,
   working context, session summaries; then path and document ID), decided from their stored byte
   length, then history newest first. Room is reserved for history and the summary (issue 359):
   whenever the session has history, actor-writable documents leave a quarter of the budget to it
   (`CONTEXT_HISTORY_SHARE`), and every actor-writable document but the session's own summary also
   leaves the summary's whole size free, as long as the summary itself would still fit. The summary
   is therefore decided as if ahead of the other actor-writable documents, against the budget less
   the history reserve. Protected and governed documents are decided against the whole budget, as
   before, and history against the whole budget. A large working document therefore gives way
   before the summary and recent history do; when the documents fit beside both reserves, nothing
   changes. The history reserve is not sized to the history, because a message's size is known
   only once its encrypted text is read, after the documents are decided. A source that would pass its limit is excluded `token_budget`, and a
   document so excluded is never read. History keeps a contiguous newest suffix: after one message
   is excluded, all older ones are too.
4. **Read.** Only the admitted sources' text is read: the admitted documents in one query, in the
   same transaction as the candidates and under RLS, and message text decrypted from the session's
   artifacts. A document whose text does not match its candidate hash and length fails the
   assembly.
5. **Prompt.** The included sources go into three sections:
   - `protected`: `protected` documents only;
   - `governed`: `governed` documents;
   - `untrusted`: `actor_writable` documents, history oldest first, then the input. Every part here
     is labelled `trust: "untrusted"`.

   Protected policy therefore never enters an untrusted section, and untrusted text cannot change
   policy. No grants or capability catalog are assembled yet (RW-0506).

The prompt, the run's protected model input, is
`{ model, sessionId, caretakerMessages, promptVersion: "context-prompt-v1", manifestHash, protected, governed, untrusted }`.
Each part is `{ source, version, text }`: a document path or message role, and a document version
or message sequence.

A prompt that includes any document is stored as a `private_cognition` artifact, under that
class's retention; a prompt without one stays `conversation`. Document text is never copied into a
`conversation` artifact. The runtime writes a private prompt as the actor's cognition, with
`private_cognition` added to the participant's ceiling for that one write only. Reading it back
through the [run inspector](runs.md#inspector-api) needs a session participant whose own ceiling
holds `conversation` and `private_cognition`. A conversation-only participant reads the manifest
below, never the text.

### The manifest

The manifest is one immutable `context_manifests` row per run, written in the run's opening
transaction with its `context_retrieval` step (step 1). It holds metadata only:

- `runId`, `sessionId`, `actorId`, `inputMessageId`;
- `inputRevision`, the session's message count it read;
- `tokenBudget`, `tokensUsed` and `manifestHash`;
- `entries`, in candidate order. Each entry has:
  - `source` (`document`, `message` or `input`), `sourceId` (a document ID or a message ID) and
    `version` (a document version or a message sequence);
  - `label` (a path or a role), `scope` (`actor` or `session`), `writeClass`, `sessionId` and
    `state`;
  - `sourceHash` (`null` for another session's summary) and `tokens`: the estimate the budget was
    decided on, and 0 for a source excluded before the budget;
  - `decision` (`included` or `excluded`), `rule`, `section`, `trust` and `promptOrder` (from 1,
    `null` when excluded).

`manifestHash` is the SHA-256 of the canonical encoding (`@clockgrove/kernel` `canonicalBytes`) of
the session, input message, input revision, budget and entries. The budget is the manifest's
recorded `tokenBudget`, so a reassembly decides and hashes under the budget the turn ran with even
after the default changes. The manifest does not name the rule its documents were decided under,
so a reassembly tries each rule, newest first (`CONTEXT_DECISION_RULES`): `shares`, the reserved
shares below (issue 359), then `whole_budget`, every document against the whole budget, the rule
manifests recorded before the shares ran under. It answers the first hash that equals
`manifestHash`, or the `shares` hash when none does, so a manifest recorded before the shares still
reproduces.

`POST /v1/runtime/context/inspect` takes `runId`, or `sessionId` with `turn`. It needs
`runtime:world-inspect` and `operator_evidence`, is audited with subject `context-manifest`, and
shares the inspector rate limit. It answers `{ manifest, reassembledHash }`. When the inspector is a
session participant whose ceiling holds `conversation`, the route assembles the context again from
the recorded inputs and answers its hash in `reassembledHash`; anyone else gets `null`. The
recorded inputs are the entries' candidate metadata, the cited document versions (not the current
heads), the messages up to the input revision and the stored input message. A reproduced context
has `reassembledHash` equal to `manifestHash`. An entry that reaches no manifest of the scope
answers `404 manifest_not_found`. The document and context routes need the `ARTIFACT_KEYRING`
secret, and answer `503 inspector_unavailable` without it.

## Decided limits and retention

These are the defaults chosen for the human-owned policy (ADR §6, issue 17):

| Limit | Value | Reason |
| --- | --- | --- |
| Version size | 8,192 bytes | Two versions fit one turn's budget with room for history |
| Operations per change set | 8 | One actor's working set in one atomic step |
| Documents per actor | 256 | Bounds candidate metadata read every turn |
| Versions per document | 1,000 | Bounds a document that changes every turn for two sessions' lives |
| Context budget | 4,096 estimated tokens, or less if the route's input limit leaves less room | A small fixed model window for the local path; never a prompt the gateway refuses |
| Token estimate | ceil(UTF-8 bytes / 4) | Common English estimate; no tokenizer is bound |
| History window | 16 messages | Bounds the messages decrypted per turn |
| Reserved shares | actor-writable documents leave a quarter of the budget for history and the session's own summary's size for it | A large working document cannot crowd out recent history or the summary (issue 359). A quarter of the default is 1,024 tokens: four chat lines of the largest size (1,024 bytes, 256 tokens), or 64 tokens for each message of the 16-message window. The three quarters left (3,072 tokens) still admit a full-size version (2,048 tokens) beside the largest input and a summary of up to 768 tokens; past that, a full-size working document gives way to the summary and history |

Versions are kept for the world's life, because manifests cite exact versions. Refused change sets
are kept 90 days, then retired on insert. Manifests follow their run. See `db/retention.json`.

### World context settings

A world sets its own context budget and history window in the `context` object of its
[model configuration](world-presentation.md#runtime-inputs) (`WORLD_MODEL_CONFIG`), both optional:

- `tokenBudget`: an integer from 256 to 65,536 estimated tokens, 4,096 by default. 256 keeps room
  for the 1 KiB input; 65,536, sixteen times the default, bounds the document text read per turn.
  A model route whose input limit leaves less room still lowers it, as above.
- `historyWindow`: an integer from 1 to 64 messages, 16 by default; 64 bounds the messages
  decrypted per turn at four times the default.

A value outside its range, or any other field, refuses the whole configuration when it is read,
so no turn runs under a setting the world did not choose. The settings apply on the scripted path
too, and to the turn an operator's retry of an uncertain effect records (`composeResearch`'s
`context`). A manifest records the budget its turn ran under, and its history entries are that turn's
window, so a reassembly uses neither the current settings nor the defaults.
