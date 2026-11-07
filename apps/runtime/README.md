# Runtime entry

`POST /v1/runtime/commands` accepts a strict version-1 envelope with the four `RuntimeScope` IDs,
decimal-string `routingEpoch` and `authorityEpoch`, and `command: encodeCanonicalNode(CommandEnvelope)`.
It returns the canonical-node `WorldCommandResult`: committed 200, kernel refusal 409,
authorization refusal 403 and authentication refusal 401. Physical commands require committed
world participation and `runtime:world-command`, and clock controls `runtime:world-clock`; workspace administration and `runtime:no-op`
cannot substitute. Tenant members receive `409 world_not_ready` before readiness without a
projection or execution. Unauthenticated callers and tenant outsiders receive no readiness disclosure.

Preserve accepted bytes and authenticated metadata when retrying. Exact decided retries return
stored outcomes even after epoch changes; changed bytes under the same command ID refuse.
`complete: false` retains application continuation semantics: trusted owner work resumes the
stored continuation, and public commands cannot choose trusted chunk IDs. The
[world-command protocol](../../docs/protocols/runtime-world-commands.md) describes the endpoint,
retry identity, fencing and recovery. Finite native tests establish local safety evidence;
exhaustive native parity, hosted qualification and full Wave 3 acceptance remain separate.

The same endpoint accepts `PauseWorld`, `ResumeWorld` and `SetClockPolicy` clock controls and
returns the committed `clockPolicy`. Ready worlds start paused with installed genesis speed and a
86400000-simulation-millisecond activation cap. Resume anchors trusted server wall time; pauses
exclude elapsed wall time, while speed changes and capped activations retain earned backlog.
`ResumeWorld` differs from continuation resume, which only executes a bounded physical-command
chunk. The [runtime runbook](../../docs/runbooks/runtime.md#timeline-clock-operation) describes
payload limits, mapping, policy-version fencing and recovery. Resume schedules the native partition
owner alarm without client presence. Each activation admits at most the cap in new earned horizon,
starts at most four command attempts within 250 ms, and retains unused admissions and backlog in
PostgreSQL. Physical progress and accepted continuation completion can exceed the admission cap.
Local native alarm and compatible-replacement evidence remains distinct from hosted qualification.

`@clockgrove/runtime` retains the portable shells and their existing names.
`@clockgrove/runtime/cloudflare` exports the default Worker handler and native
`WorldDO`, `SpaceDO`, `ActorAgentDO`, and seven Workflow adapter classes. This
separate entry avoids collisions with the portable class exports and keeps the
native `cloudflare:workers` dependency out of portable consumers.

Fresh Worker and owner isolates compose PostgreSQL services from scalar bindings, including
`HYPERDRIVE.connectionString`, and stored-session authentication from its least-privilege database
bindings. `injectRuntimeComposition(factory)` is an explicit local/test override. No fallback
identity or canonical store is installed; missing required composition fails closed.

Local tests obtain named roles from `authenticationFixture(undefined, "observer")` or
`authenticationFixture(undefined, "operator")` in `test/auth-fixture.ts`. Use the returned
`event.credential` with `authenticationRequest({}, event.credential)`, then call
`authenticator.identify(request)` and `authenticator.authorize(identified, undefined,
"runtime:world-observe")`. Inspection uses `runtime:world-inspect` and succeeds only for the
operator. Calling `authenticationFixture()` retains the existing `valid` no-op session.

| Local role | Principal / external identity | World grants | Privacy ceiling |
| --- | --- | --- | --- |
| observer | `principal-observer` / `identity-observer` | `runtime:world-observe` | `public_scene` |
| operator | `principal-operator` / `identity-operator` | `runtime:world-observe`, `runtime:world-inspect` | `public_scene`, `operator_evidence` |

Both fixtures are scoped to `tenant-runtime` / `world-runtime` / `timeline-runtime` /
`space-runtime`. Neither implicitly grants operate, command, clock or no-op authority.
`local/test-auth.ts` exports `LOCAL_TEST_PRINCIPALS`, `LocalTestRole` and the explicit
`DeterministicTestAuthProvider.createRoleSession(role, { revision, expiresAt })` installer.
The provider maps identities and verifies sessions; `authenticationFixture` supplies separate
`WorldAuthorization` records. Its clock is 100 and session expiry is 200, matching the existing
local session convention. These fixtures do not enroll hosted or staging users and are not
production authentication or fallback identities; hosted enrollment and production stored-session
composition remain separate.

`runtimeBindingManifest` lists the namespace/class pairs, Workflow/class pairs,
queue bindings and non-secret queue-name variables. Queue-name variables must
match the physical queue names delivered as `batch.queue` and must be distinct.
World-command commits publish their `world-reactions` dispatches through the native Queue binding.
Consumption durably verifies the complete committed batch once per tenant/message ID; publication
status and consumption status are separate. The scheduled handler recovers lost hints and expired
leases without browser traffic. Other Queue consumers keep refusing; Workflow shells initiate no
later-wave jobs. See the [Queue runbook](../../docs/runbooks/runtime.md#world-reactions-queue-lifecycle)
for retry, physical DLQ, operator recovery and retention policy.

The Worker authenticates before routing and sends trusted context only through
internal Durable Object RPC. Namespace types describe public RPC methods, rather
than remote class instances. Names created with `idFromName` are read from the
native state ID and checked by the portable shell against canonical scope. This
uses the [documented named-ID runtime support](https://developers.cloudflare.com/durable-objects/api/id/).
Unnamed routes fail closed. Owner constructors perform no canonical reads or
writes. Initialization rehydrates only reconstructible local storage. No-op commands retain the
injected journal seam; world commands use an invocation-owned PostgreSQL journal, preserving
PostgreSQL mutation authority. HTTP error mapping remains owned by the portable Worker.

Local tests alias only the built-in base classes; the native journey in
`test:runtime` runs the entry in workerd. Provider declarations
are limited to the entry, adapter implementation and adapter declaration
companion. `scripts/check-boundaries.mjs` verifies that portable modules and all
packages remain free of provider types and checks negative regressions without
writing fixtures into product paths.

The Cloudflare composition root accepts `HYPERDRIVE.connectionString`. An injected factory
can supply authentication and queue consumers while the root constructs PostgreSQL journal and
canonical-state services. Fully supplied journal/canonical test services take precedence; missing
composition or a missing required database binding fails closed. Each database operation reserves
one connection and closes it unconditionally, preserving transaction-local authorization.

The Hyperdrive adapter uses the pinned `pg` driver with `nodejs_compat`. Each physical-owner
persistence invocation owns one connection for its reads and journal transaction, then closes it.
Transaction-local authorization does not survive the operation. No deployment or infrastructure
configuration is added by this service.

`pnpm run test:db` includes the adapter's real journal test through the existing disposable
PostgreSQL cluster helper. Its connection string carries the helper's abstract Unix socket path;
no TCP listener or persistent database is introduced. The test verifies duplicate command bytes,
canonical counts, rollback, authority cleanup, and connection cleanup after an operation failure.
