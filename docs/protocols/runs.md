# Run and step evidence

Wave 5 §8, RW-0502, local path (issue 15). Every cognitive attempt the runtime makes for an actor has
one durable run in PostgreSQL. A run holds ordered steps, and each run and each step reaches exactly
one terminal disposition. Raw model input and output are protected artifacts. Metadata never holds
raw text. An inspector walks from a conversation turn to what it committed and back.

Today every run is a Caretaker Talk attempt ([private conversations](conversations.md)), answered by
the scripted model fixture, inside a recoverable turn fiber ([turn fibers](conversation-fibers.md)):
each claim of a turn by its owner is one run. The schema and the walk already take tool, approval
and world-command steps. Their producer is RW-0506 (capabilities).

## Runs and steps

A run (`agent_runs`, migration 0036) records:

- the actor it executes for (`actorId`) and who initiated it (`principalId`, `personaId`);
- its activation (`conversation_message`) and the session's `inputMessageId`;
- `parentRunId` and `parentStep`, the step of the parent run that started it, and `rootRunId`, the
  causal root (itself when it has no parent). The schema enforces that a child shares its parent's
  root and session;
- `model`, `promptVersion` and `inputRevision`, the session's message count it read;
- `status`, `outcomeCode`, the committed `turn`, a safe `summary`, `startedAt` and `endedAt`;
- `prompt`, its protected model input.

A step (`run_steps`) has an ordered number from 1 and a `kind`. The kinds are `context_retrieval`,
`model_attempt`, `tool_proposal`, `approval`, `tool_execution`, `world_command_proposal`,
`validation`, `commit` and `delivery`. A step also records its `status`, `outcomeCode`, model or
tool identity, and what it led to: a `commandId`, which the [causal chain](../runbooks/runtime.md)
follows, or an `outputMessageId` in the session. It records usage (`inputTokens`, `outputTokens`)
and `costMicrousd` where known. `null` means unknown, not zero. It also has its protected `input`
and `output`.

A Talk attempt records three to five steps (a resumed attempt's model step succeeds with the
answer its turn already checkpointed):

1. `context_retrieval`, written with the run and its context manifest
   ([context assembly](context-assembly.md)).
2. `model_attempt`, by the model that answered: `scripted-fixture-v1`, or the production route's
   model name. Its input is the prompt artifact and its output is the reply message's artifact.
   The fixture costs `0` with unknown tokens; a route records the gateway's tokens and cost.
3. `validation`, only when the model proposed a document change: `succeeded`, or `failed` with the
   change set's refusal code.
   `world_command_proposal`, only when the model proposed a capability call: `succeeded` when the
   world committed the command, else `failed` with the refusal code. `tool` is the capability and
   `command_id` the stored receipt, null when the grants refused it before the world.
4. `commit`, which leads to the reply message (`<messageId>:reply`). It is written in the same
   transaction as the messages and the turn, so a run completes exactly when its turn commits.

## State machines

```text
run:  running → completed | failed | cancelled | abandoned | superseded
step: running → succeeded | failed | cancelled | abandoned | superseded
```

Guards in SQL hold these rules for every writer:

- A run starts `running`, and a finished run or step never changes (`CG020`).
- A run completes only when all of its steps have ended.
- Any other disposition closes the run's open steps with that same disposition.
- A step is added only to a running run, in order.
- Nothing is deleted.

The attempt names its own disposition:

| Disposition | When | `outcomeCode` |
| --- | --- | --- |
| `completed` | its turn committed | none |
| `failed` | a refusal after the run opened, such as the session closing before the commit | the refusal code |
| `abandoned` | an unexpected error ended the attempt; its turn stays open for the next claim | `attempt_failed` |
| `abandoned` | a later claim of its turn found it open: its owner incarnation was evicted or crashed | `owner_lost` |
| `cancelled` | its turn was cancelled before committing | `cancel_requested` |
| `superseded` | reserved; no producer since turn fibers | none |
| `running` (no disposition yet) | its turn has not been claimed again since its owner was lost | none |

Turn fibers replace the earlier `superseded/retried`, `superseded/message_stored` and
`abandoned/stale` dispositions: a retry of the same message joins or resumes its turn instead of
starting a competing attempt, and a lost owner's attempt is closed by the next claim
(`owner_lost`) instead of by a 60 s timeout.

A late commit of a closed run is refused (`CG020`) and rolls back with its messages, so an abandoned
or cancelled attempt never commits a message. A claim after the turn committed opens no new run.

Known gap: a run whose owner lost its local storage stays `running` until its turn is resumed: by
the participant's next call to the actor, or a retry of the same message
([turn fibers](conversation-fibers.md#known-gaps)).

## Protected payloads

The prompt (the exact JSON the scripted model reads: the assembled context of
[context assembly](context-assembly.md#context-assembly)) and the reply are artifacts in the
[artifact store](../runbooks/database.md#artifact-store). They are stored only as AES-256-GCM
ciphertext, and rows name them through keys that pin the class. The reply is `conversation`. The
prompt is `conversation` unless it includes any actor document; then it is `private_cognition`,
under that class's retention, and its text is never copied into a `conversation` artifact
(migration 0037). The run row's `prompt_privacy_class` and the model attempt's
`input_privacy_class` carry the class. The prompt is
`<sessionId>:prompt:<runId>`. The output is the reply message's own artifact, not a copy. A Talk
past the run limit is refused before its prompt is stored.

## Inspector API

Both routes are `POST`, version 1. The body carries the browser scope (tenant, world, timeline and
space) and the bearer credential, under the causal inspector's authority: `runtime:world-inspect`
and the `operator_evidence` category. Every access, allowed or refused, is audited in
`inspector_accesses` with subject `agent-runs` and shares the inspector rate limit
(`429 inspection_rate_limited`). The talking member does not need the grant to talk. Without it
they are refused here with `403 authorization_refused`.

- `/v1/runtime/runs/inspect` takes exactly one entry: `runId`, `commandId`, `sessionId` with
  `turn`, or `sessionId` with `messageId`. It answers `{ entry, runs }`: every run of the causal
  trees the entry reaches, each with its steps, oldest first (at most 100).
  - A turn reaches every attempt at its input message, so superseded attempts appear beside the
    one that committed it.
  - A message reaches the run that read it or the run that produced it.
  - A command reaches the run whose step proposed it.

  The walk shows payload `text` only when the inspector is a participant of the run's session
  whose ceiling also holds `conversation` and the payload's own class: a `private_cognition`
  prompt needs both. A conversation-only participant still reads that turn's context manifest
  (path, version, hash, token estimate, decision and rule of each document), never its text. Conversation text is
  participant-only (migration 0034), and the run walk keeps that rule. Otherwise each payload is `{ artifactId, privacyClass, text: null }`: metadata
  only. An entry that reaches no run of the world timeline, including another world's, answers
  `404 run_not_found`.
- `/v1/runtime/runs/search` filters by `actorId`, `sessionId` and `status`, with `limit` from 1
  to 100 (default 100), newest first. It answers `{ runs }` of run metadata: no steps, no artifact
  IDs and no payload text, whatever the ceiling.

Rows follow the policy of migration 0036. A session's participant writes its runs as themselves,
and reads them. A member whose ceiling holds `operator_evidence` reads every run of the tenant, and
the routes add the world, timeline and space scope. An inspect grant for one space walks only the
runs of sessions opened in that space, as the causal inspector finds only commands of the requested
space. Both routes need the `ARTIFACT_KEYRING` secret, and
answer `503 inspector_unavailable` without it.

## Limits and retention

Decided limits:

| Limit | Value |
| --- | --- |
| Runs per session | 2,000 (four attempts for each of a session's 500 turns) |
| Steps per run | 32 |
| Runs per walk, per search page | 100 |

A Talk past the run limit answers `409 conversation_full`. Runs and steps are retired with their
session's conversation data, as `db/retention.json` says.
