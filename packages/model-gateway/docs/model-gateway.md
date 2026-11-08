# Model gateway

Wave 5 §10, RW-0504, local path (issue 16). Every cognitive feature reaches a language model
through the `ModelGateway` port in `src/port.ts`. No provider SDK type crosses that port. The
production adapter, `src/ai-sdk.ts`, is the only module that imports the Vercel AI SDK.

## Port

```ts
interface ModelGateway {
  stream(request: ModelRequest, signal?: AbortSignal, onText?: (delta: string) => void): Promise<ModelOutcome<string>>;
  generateObject<T>(request: StructuredModelRequest<T>, signal?: AbortSignal): Promise<ModelOutcome<T>>;
  inspect(alias: string): ModelRouteStatus;
}
```

A request names an `alias` and gives a caller-chosen `callId`, its `attribution` (tenant, world,
actor, and optionally session and run), a `system` text and `messages`. `generateObject` also takes
a Zod `schema`.

Each call resolves to exactly one outcome. It is either `completed`, with the value, or `failed`,
with a `code` and a `retryable` flag. Every outcome carries the call's accounting record. Provider
faults are never thrown. A caller error, such as an unknown alias, is thrown. A route whose
provider has no adapter is refused when the gateway is created, before any call.

| Code | When |
| --- | --- |
| `unavailable` | every route failed: missing credential, open breaker, HTTP error, connection error |
| `timeout` | the last route tried timed out |
| `rate_limited` | the last route tried answered 429 |
| `refused` | the model declined (`content-filter` finish) |
| `invalid_output` | structured output was not JSON or failed the schema |
| `input_too_large` | the request exceeds the alias's input bound; no route was called |
| `budget_exceeded` | the reservation was refused; no route was called |
| `cancelled` | the caller's signal aborted the call |

## Aliases and routes

An alias (`ModelAliasDefinition`, `src/aliases.ts`) pins:

- `policyVersion`;
- its ordered routes;
- `maxInputTokens` and `maxOutputTokens`;
- three timeouts: `firstByteMs` until the first text, `idleMs` between text after that, and
  `totalMs` for the whole route attempt.

A route pins its provider (`scripted`, `vercel-ai-gateway` or `anthropic`), the provider's model
name, a credential reference and its price in USD per million tokens. That price is also
microdollars per token. Callers never see provider or model names.

`stevie.conversation@1` is the production alias. The owner decided this on 2026-11-07 (issue 16):

1. `vercel-ai-gateway/claude-opus-5.5`: Vercel AI Gateway, model `anthropic/claude-opus-5.5`,
   credential `AI_GATEWAY_API_KEY`. The same gateway is the routing layer for generation models
   (issue 27).
2. `anthropic/claude-opus-5-5`: Anthropic directly, model `claude-opus-5-5`, credential
   `ANTHROPIC_API_KEY`.

Both routes serve Claude Opus 5.5 at $4 input and $20 output per million tokens (Anthropic pricing,
2026-10-06). A fallback therefore never changes policy or eval identity. Cloudflare AI Gateway is not
used.

These bounds are decisions, not provider limits:

- **Tokens.** Input is at most 16,000 tokens, the context-assembly budget. Output is at most
  1,024 tokens, one conversational reply.
- **Timeouts.** The first text must arrive within 15 s, which leaves room for model thinking. After
  that, 10 s of silence means a stalled stream. A route attempt lasts at most 60 s. The bound is
  per route, so a turn that falls back after a first-byte timeout lasts at most 15 s + 60 s.

A reply cut at the output cap completes; its attempt's `finishReason` is `length`. A structured
reply cut at the cap fails as `invalid_output`.

## Routing, fallback and breakers

Routes are tried in order. The next route is tried only when the route sent no text and ended
with one of these outcomes:

- `skipped_breaker_open`;
- `credential_missing`;
- `timeout_before_first_byte`;
- `rate_limited`;
- `unavailable`.

The gateway does not fall back after any other outcome:

- **Any outcome after first bytes**, including a timeout and a mid-stream provider error such as
  Anthropic's `overloaded_error`. The caller already received text, and a second route would
  duplicate it. The call ends with that route's outcome and decision `primary` (or `fallback`).
- **Refusal or invalid output.** The model answered, so moving to another route would be a silent
  switch.
- **Cancellation.** The caller stopped the call.

The SDK makes no retries of its own (`maxRetries: 0`). Every retry or fallback is the gateway's,
and it is recorded.

Each route has a breaker (`src/breaker.ts`). These outcomes count against it:

- timeouts before or after first bytes;
- `rate_limited`;
- `unavailable`.

Three consecutive failures open the breaker. One or two failures are ordinary provider noise.
While the breaker is open, calls skip the route and record `skipped_breaker_open`. After 30 s the
breaker is half-open and lets one trial call through. A success closes it; a failure opens it again.
`inspect(alias)` reports each route's breaker state and consecutive failures. Breaker state is
in-memory execution state, one entry per route.

## Budget

Before any reservation, the gateway bounds the request's input: one token is at least one UTF-8
byte, so the UTF-8 length of the system text, the messages and the JSON schema, plus 8 tokens per
message and 16 for framing, is an upper bound on its input tokens. A request whose bound exceeds
`maxInputTokens` ends as `input_too_large`, decision `input_refused`, before any reservation or
provider call. The bound is conservative: English text runs about four bytes per token, so it
admits about a quarter of the token budget in English.

The gateway then reserves the alias's cost ceiling against the scope
`<tenantId>/<worldId>` through `ModelBudgetPort`. The ceiling is the highest, over the alias's
routes, of `maxInputTokens × input price + maxOutputTokens × output price`. For
`stevie.conversation` that is 84,480 microdollars.

A refused reservation ends the call as `budget_exceeded` before any provider is contacted. After
the call, the reservation is settled with the summed cost of its attempts. A route that streamed
text and ended without usage (a timeout, a cancellation or a mid-stream error) has billed tokens of
unknown count: the call's `costMicrousd` is then `null` and the whole reservation stays spent. Nothing in a prompt can
change a reservation or a breaker.

`InMemoryModelBudget` is the local ledger. A durable, tenant-wide ledger is Wave 12 metering. This
gateway owns model spend only; world commands have no quota yet (Wave 3 audit).

## Accounting

Every call, whether completed, failed or refused, writes one `ModelCallRecord` to the
`ModelAccountingSink`:

- `callId`, `alias`, `policyVersion` and the caller's `attribution`, unchanged;
- `decision`:
  - `primary`: the first route ended the call;
  - `fallback`: a later route ended it;
  - `exhausted`: every route failed in a way that falls back;
  - `input_refused`: the request exceeds the input bound; no route was called;
  - `budget_refused`: no route was called;
- one attempt per route tried. Each attempt has the route, provider and pinned model, the model the
  provider reported serving (`responseModel`), its outcome, its
  HTTP status, latency and time to first text, its input and output tokens, and its cost in
  microdollars. It also has the cost the gateway reported in USD, when it reported one, and the
  finish reason. `null` means unknown, not zero;
- `reservedMicrousd` and `costMicrousd` (`null` when unknown, as above);
- `requestSha256` and `outputSha256`. These are hashes of the canonical request and of the output
  text. The texts themselves stay out of the record.

Cost is computed from the route's pinned price, so it is deterministic. A completed attempt's cost
is `inputTokens × input price + outputTokens × output price`.

## Credentials

A route names a credential reference, never a value. `AiSdkRouteAdapter` resolves the reference
through its `CredentialResolver` at call time. `environmentCredentials` reads the process
environment. The key goes only into the provider request's authentication header:

- `x-api-key` for Anthropic;
- `Authorization` for Vercel AI Gateway.

It is never placed in a prompt, a request body, an outcome, an accounting record or an error. The
adapter replaces the SDK's error logger with a no-op, and a provider fault keeps only its class and
HTTP status. A route whose credential is missing records `credential_missing` and is skipped
without a network call.

## Decide

`ModelGateway.decide(request, signal?)` is a bounded Choice, Score or Boolean request: the caller lists the
options (or score levels, or the yes/no question) and the model answers with one label and a probability.
It goes through Vercel AI Gateway's decisions endpoint (`AiSdkDecisionAdapter`, AI SDK `experimental_decide`).
It is not a generation call: no streaming, no structured output, no fallback chain.

- **Aliases.** A decision alias (`decisionAlias({alias, model})`) maps a name to a route and bounds: 8 KiB of
  input, a 5 s timeout and a 1000 microusd ceiling by default. The model is configuration, never code (the free
  tier reached only some models; the paid tier reaches all four measured in factory#2504). Suggested default
  `pplx-decider-v1.2`, alternate `gpt-6-luna-decisions`.
- **Order of checks.** Input byte bound, cancellation, circuit breaker, then the budget reservation. A timeout
  settles the whole reservation and records a null cost; a failed or refused call settles 0.
- **Outcome.** `completed` carries `{type, label, confidence}`; `failed` carries a `ModelFailureCode`,
  `retryable` and the call record. Confidence is the model's probability for its label, `null` when absent.
  Observed confidences run 0.5 to 0.8 even when correct, so callers set a threshold per decision, not a global one.
- **Record.** Every call records `DecisionCallRecord` through `ModelAccountingSink.recordDecision`: model,
  response model, outcome, label, confidence, latency, cost in microusd (reported cost, else tokens times price,
  else null) and the request hash. Null means unknown, not zero.
- **Scripted decider.** `ScriptedDecider` answers from a per-route finite script of `answer` or `http` steps and
  refuses with `unavailable` when it runs out. Tests and replays use it; replay never calls a model.

The runtime's shadow tier consumes it ([decision shadow](../../../docs/protocols/decision-shadow.md)).

## Tests

The offline suite (`test/model-gateway.journey.test.ts`) runs in `pnpm test`. It drives the
gateway through the real `AiSdkRouteAdapter`, against a local HTTP server that speaks the Anthropic
Messages streaming protocol. It also drives the `ScriptedModelProvider`. It shows:

- a scripted reply streamed with its accounting;
- structured-output validation, with the JSON schema the real adapter sends;
- timeouts before and after first bytes, and no fallback after a mid-stream overload;
- a breaker trip and routing around it;
- fallback;
- input-bound and budget refusal;
- every route down, as a recoverable outcome.

It also checks that the key appears only in the outbound request's header.

The live check (`test/production-route.journey.test.ts`) sends one bounded request through
`stevie.conversation` and prints its accounting record: the model the provider reported, the tokens
and the cost. When Vercel AI Gateway reports its charge, the pinned price must agree with it
within 10%. It runs
only with `CLOCKGROVE_MODEL_LIVE=1` and a provider key, through
`pnpm --filter @clockgrove/model-gateway test:live`. `pnpm test` runs under Turbo's strict
environment mode, which strips both variables, so it always skips there.

The Actions half of the owner's key decision is not wired yet. That half is a manual
(`workflow_dispatch`) qualification run with a repository secret. Wiring it is a `.github/`
change, which belongs to the owner.
