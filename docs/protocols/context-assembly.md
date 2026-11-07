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
- the size limits;
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
  Wave 6 owns governed adoption of model proposals to `governed` documents.

`POST /v1/runtime/actor-documents/read` takes `actorId`, `path` and an optional `version` (default:
the head). It answers that version with its text and provenance (`changeSetId`, `proposer`,
`principalId`, `runId`) under `runtime:world-inspect` and a `private_cognition` ceiling. An unknown
path or version answers `404 document_not_found`.

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
   hash), and only to a participant of that session. The history candidates are the newest 16
   messages of the session at or before its input revision. The turn's input is a candidate too.
2. **Authorization, before any text is read.** A document is excluded `other_session_private` when
   it is another session's summary, or `document_archived` when it is archived. Its hash in the
   manifest is the metadata's, and its text is never read.
3. **Read.** Only the admitted sources' text is read. Document text is read under RLS, and message
   text is decrypted from the session's artifacts.
4. **Budget.** The input is reserved first. Then documents in kind order (identity, policy, goals,
   working context, session summaries), then history newest first. A source that would pass the
   budget is excluded `token_budget`. History keeps a contiguous newest suffix: after one message
   is excluded, all older ones are too.
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
  - `sourceHash` and `tokens`, which is 0 when the source was never read;
  - `decision` (`included` or `excluded`), `rule`, `section`, `trust` and `promptOrder` (from 1,
    `null` when excluded).

`manifestHash` is the SHA-256 of the canonical encoding (`@clockgrove/kernel` `canonicalBytes`) of
the session, input message, input revision, budget and entries.

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
| Context budget | 4,096 estimated tokens | A small fixed model window for the local path |
| Token estimate | ceil(UTF-8 bytes / 4) | Common English estimate; no tokenizer is bound |
| History window | 16 messages | Bounds the messages decrypted per turn |

Versions are kept for the world's life, because manifests cite exact versions. Refused change sets
are kept 90 days, then retired on insert. Manifests follow their run. See `db/retention.json`.
