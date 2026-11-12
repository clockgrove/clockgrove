# First-party world MCP and remote installation

## First-party server readiness

The first-party server is a stateless authenticated surface over the ordinary runtime
application APIs. Configure the separate MCP authentication writer as described in the
[runtime runbook](../runbooks/runtime.md#first-party-world-mcp-connection). The endpoint
is `/mcp` on `AUTH_ORIGIN`; without its explicit writer configuration it fails closed.
This service is distinct from outbound remote MCP installations below.

`apps/runtime/src/world-mcp-endpoint.ts` composes fresh credential verification,
durable principal admission and ordinary `RuntimeWorker` application dispatch.
`world-mcp-server.ts` uses the current Agents `createMcpHandler` from
`agents/mcp/server`, constructing a fresh MCP server for every request. No actor
memory, conversation, credential cache, subscription or MCP session is retained.
The current SDK stateless protocol returns finite JSON; legacy stateful transport
is refused. OAuth protocol records are durable credential state, not MCP connection memory.

| Tool | Ordinary use case and authority |
| --- | --- |
| `world_directory` | Lists the member's observable world/timeline/space scopes, using current membership and `runtime:world-observe`. |
| `world_status`, `entity_inspect` | Existing authorized observation and entity inspection, scoped to tenant/world/timeline/space. |
| `command_receipt` | Existing causal inspector, `runtime:world-inspect` and privacy ceiling. |
| `run_receipt`, `run_search` | Existing [run inspector](runs.md#inspector-api), including participant-only payload access, audit and rate limits. |
| `command_submit` | Typed ordinary [world commands](runtime-world-commands.md), validator and Journal. Requires `runtime:world-command`, or the distinct clock grant for clock controls. |
| `runtime_state` | Existing runtime inspector under `runtime:world-inspect`, including privacy redaction and RLS. |
| `runtime_action` | Ordinary `repair-publication` and `replay-message`, requiring scoped `runtime:world-operate`, audit and operator limits. |
| `changeset_prepare`, `changeset_apply` | Declared Wave 7 placeholders. Strict versioned scope only; always `changesets_unavailable_until_wave_7`, without mutation. |

There is no Talk tool. Conversation remains on the channel-neutral session path.
MCP adapters issue no SQL and supply no grants. Each exchange authenticates anew;
application dispatch verifies current identity, membership, grant and privacy rules
again. Tenant/world/timeline identifiers are untrusted scope, never authority.

### Command attribution and receipts

`command_submit` accepts the same strict version-1 envelope as `/v1/runtime/commands`,
including canonical-node typed command bytes and routing/authority epochs. It returns
the ordinary canonical receipt for a committed, kernel-refused or authorized-denied
command. Boundary failures use fixed public error categories. A retry preserves
accepted bytes; command identity includes the verified MCP client identity, so a
second credential cannot silently adopt an earlier credential's receipt identity.

The endpoint obtains client identity from fresh Better Auth storage verification:
`member-key:<keyId>` or `oauth:<clientId>`. An internal worker method carries that
identity to the ordinary command owner, which seals `channel: mcp:<clientIdentity>`
and the authorized member's world persona as initiator and effective actor. Caller
attribution, headers and MCP initialization metadata cannot select these fields.
The presented causal root is retained. A successful command requires a world persona.
Why projects the recorded nonsecret channel alongside the command receipt; full
command and run receipts retain inspector authorization.

### Input and principal limits

Published tools use strict application envelopes; application decoders remain
authoritative. Arguments are limited to 64 KiB UTF-8 JSON and raw requests to
128 KiB before parsing. These engineering bounds allow command metadata without
unbounded parsing. Errors expose fixed categories, never exceptions, credentials
or application response text.

Every authenticated protocol exchange, including initialization, listing and refused
calls, reserves durable capacity against the canonical principal across credentials,
worlds and connections. Policy is 60 exchanges and 240 input-work units per fixed
UTC database minute: one initial unit plus one per started 4 KiB. Reservation precedes
body reading, and body-work admission precedes parsing/dispatch. Invalid/oversized
bodies charge the maximum 32 body units. Failed downstream work is not refunded;
storage failure refuses execution. One mutable row follows each principal's lifetime.

These units bound local request work, not currency. The exposed command path performs
physical/control kernel work and invokes no model or newly billable remote action.
Operator repair/replay retains ordinary application admission and existing effect
reservations. No Talk or arbitrary remote tool execution is exposed. A future billable
MCP operation must reserve worst-case monetary capacity before dispatch; request units
cannot substitute for that reservation.

## Internal member credential composition (issue 167, part 5)

The credential foundation from part 5 is now integrated into the endpoint.
`composeWorldMcpAuthentication` confines Better Auth OAuth-provider/API-key SDKs
to the auth adapter. The existing read-only session verifier is unchanged; the
separately configured `clockgrove_mcp_auth_writer` cannot mutate world history,
Management identity links, existing users or web sessions. Issuing a credential
never enrolls a member, links an identity or creates a grant.

Both owner-required credential modes are available. OAuth authorization code uses
PKCE S256, explicit member consent, fixed `clockgrove:mcp` scope and exact resource
audience. Discovery supplies protected-resource and authorization-server metadata;
bounded public dynamic registration admits public clients only. Unauthenticated
authorization redirects to the existing member-session sign-in handoff. Member API
tokens are created/listed/revoked through `/mcp/tokens`; `/mcp/consent` approves or
denies OAuth, and token management also lists/revokes existing consents. Browser
credentials stay in component memory; a newly issued token is shown once.

Opaque OAuth tokens and member keys use fresh provider storage verification on every
exchange and resolve an existing environment/subject identity link. OAuth access
lasts one hour and member keys thirty days, engineering exposure bounds. Revocation,
expired credentials, deleted authorizing OAuth sessions, revoked identity links or
revoked principals refuse the next exchange. Member keys are independent of web
session lifetime and remain subject to their own revocation/expiry and live mapping.

Auth bodies/queries are bounded at 16 KiB UTF-8, credentials at 16,384 UTF-16 code
units and key names/identifiers at 128 characters, engineering metadata limits.
Registration refuses remote key-discovery fields, secret-bearing client modes and
unapproved scopes/grants. Endpoint origins must match the configured service origin;
there is no cross-origin ambient-cookie authority.

### Credential record retention

Migration 0063 serializes successful credential insertion with a database lock and
caps public issuance at 240 credential rows per database minute. This includes
dependent rows, so a complete OAuth flow consumes more than one unit. Failed
transactions do not retain reservations or credentials. These are engineering
storage/issuance bounds, separate from principal MCP execution admission.

| Table | Capacity and retirement |
| --- | --- |
| `clockgrove_auth.apikey` | 16 live keys per subject, 16,384 globally; expiry/disabled cleanup, member deletion or auth-user cascade. |
| `clockgrove_auth.oauthClient` | 1,024 global registrations; retire after thirty days or explicit client deletion. Cascades resources, consents and credentials. |
| `clockgrove_auth.oauthResource` | One seeded row per configured resource URL; explicit operator deletion. |
| `clockgrove_auth.oauthClientResource` | Unique client/resource pair, bounded by registered clients and configured resource; parent cascade. |
| `clockgrove_auth.oauthAccessToken` | 64 per subject, 65,536 global; one-hour expiry, immediate revocation and expiry/revocation cleanup. Client/user/session deletion cascades. |
| `clockgrove_auth.oauthConsent` | 64 per subject, 65,536 global; retire after thirty days without update or member revocation. Deletion revokes corresponding credentials. |
| `clockgrove_auth.verification` | At most 2,048 live public-issuance records; expired records removed. |
| `clockgrove_auth.oauthRefreshToken` | Refresh grant/offline access disabled; expired/revoked compatibility rows cleaned. |
| `clockgrove_auth.oauthClientAssertion` | Assertion client modes not exposed; expired compatibility rows cleaned. |
| `clockgrove_auth.mcp_issuance_budget` | One mutable singleton counter, replaced in place each database-minute window. |

These mutable provider records are separate from append-only world history.
`clockgrove_auth.retire_mcp_credentials()` runs before credential insertion and is
available for explicit administration; it never makes an expired credential valid.
The caps bound abandoned issuance even when there is no scheduled cleanup. Operators
can run retirement without an MCP connection; see the runbook procedure.

### Real path and attacks

`apps/runtime/test/world-mcp-public.postgres.test.ts` drives the production Worker,
native owners and PostgreSQL through a real SDK client using issued OAuth and member
credentials. It proves trusted Journal attribution, Why channel, private payload
redaction, foreign tenant/world/timeline refusal and immediate credential/grant/link
revocation. The focused command, auth, endpoint, operation, transport and admission
PostgreSQL proofs cover their own boundaries. `tests/database/authorization.sql` retains
the canonical RLS/privilege attack inventory, including the inaccessible principal-budget
table; public MCP attacks exercise those existing use cases rather than a separate SQL path.
The existing browser MCP journey additionally creates and revokes a member key through
the web controls against native runtime auth storage. Every proof uses the fixture world.
Local proof does not establish a hosted deployment or hosted egress qualification.

## Remote MCP installation

Issue 164 provides local authenticated installation routes, a capabilities screen, isolated PostgreSQL
credentials, canonical installation/review/binding governance and actor revision integration.
The [local runtime composition](#local-runtime-composition) and
[operator procedure](../runbooks/runtime.md#local-operator-lifecycle) describe the current path.
Production remote MCP remains guarded off pending issue 3's hosted egress receipt after issue 2's
staging deployment. Remote execution belongs to RW-0508. Earlier delivery-part sections below
record the foundation boundaries; the final local integration supersedes their pending local work.

## Transport and untrusted discovery

`packages/application/src/mcp-network.ts` owns `SafeMcpHttpClient`. A trusted `McpNetworkPort`
resolves addresses and connects only to the admitted addresses while verifying the original HTTPS
hostname. There is deliberately no default global-fetch adapter: supplying DNS results alongside
an ordinary fetch does not pin its independently resolved destination. There is no production
loopback setting. Tests map public fixture URLs to an actual local HTTP server in a test-owned
adapter, outside the production policy.

Only HTTPS URLs without user information, fragments or query strings are accepted. Literal and
resolved private, loopback, link-local, metadata and special-purpose addresses fail with fixed
refusal codes. Each hop checks DNS before and after the request. Redirects must preserve the
origin and method (307/308); credentials never cross origins. The adapter contract pins the
admitted addresses, so a resolver changing its answer between checks cannot change the connected
destination. Resolver/request failures are sanitized; remote error text is never an error message.

The engineering bounds are three redirects, a 15-second deadline per HTTP request and 1 MiB of
response bytes. Discovery further bounds candidate count, page count, nesting, nodes and text.
These are conservative installation limits, not MCP protocol requirements. Discovery allows 256 candidates,
16 pages per listing, nesting depth 16, 16,384 nodes per value and 16,384 characters per string.
Four listing methods and initialization bound a discovery to 66 requests (at most 16.5 minutes
at the request deadline). A refused server
needs an explicit implementation change and review rather than a server-supplied override.

`packages/application/src/mcp-http.ts` owns `RemoteHttpMcpDiscovery`, a discovery-only client.
It explicitly supports and pins the **2025-11-25** Streamable HTTP protocol. This is a compatibility
choice, not a claim to support the latest protocol. It initializes a connection, handles JSON or
bounded, finite SSE responses, and lists tools, resources (including templates) and prompts with
pagination. Persistent SSE streams exceed the request deadline and fail closed. See the pinned
[transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and
[lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) specifications. It retains server
identity and advertised protocol capabilities as untrusted metadata. The server's initialization
instructions never enter policy. This discovery class has no tools/call or resources/read
execution method. The separate internal read-execution adapter described below does not
change discovery authority.

Every returned candidate has `enabled: false` and `effectClass: external-write`, regardless of
server hints. Tool schemas use a bounded subset refusing remote references and executable/regex
keywords; unsupported schemas fail discovery without returning a partial snapshot. Hashes are
SHA-256 over deterministic JSON with sorted object keys; tool hashes include input and optional
output schemas. Resources and prompts hash their candidate metadata. These hashes are discovery
evidence; the internal governance service records pins and disables drift, while actor capability
version integration remains pending.

The existing `McpTransportPort` stays compatible. The foundation does not bypass it to expose
remote tools to an actor; future adapters must implement that port behind installation authority.

## Credential boundary

`packages/application/src/mcp-credentials.ts` owns the isolated credential provider. A credential
is owned by the installing operator and bound to the complete tenant/world/timeline/installation
scope. Canonical records may contain its opaque reference only. The dedicated credential keyring
has versioned keys separate from artifact encryption. Stored token material and OAuth state use
AES-GCM envelope encryption with scope-bound authenticated data; storage adapters see ciphertext.

OAuth supports explicitly registered **public clients**, not dynamic registration or client-secret
authentication. Scopes are explicitly supplied by the trusted operator configuration, never selected
from server hints. The browser authorization endpoint must share the registered issuer origin,
and all discovered endpoints pass DNS admission before the connect URL is returned. OAuth uses
protected-resource/authorization-server metadata, authorization
code with S256 PKCE, issuer binding and single-use state. Static tokens are also supported. Access
and refresh tokens stay in the provider. Refresh and revocation must durably block use before a
remote operation whose result can be uncertain. Revocation first authenticates ownership and then
sets an irreversible shared storage fence, observing the latest credential even if refresh changed
it since the ownership check. New use observes the fence; compare-and-swap cannot restore an
active credential after it. Errors never include provider response bodies, caller inputs or causes.

The encrypted storage port requires linearizable reads, atomic durable compare-and-swap and an
irreversible revocation fence. An uncertain fence outcome must make future reads unavailable until
reconciled; an adapter that simply throws and later returns the old unfenced row is invalid. The fixture HTTP journeys prove the OAuth lifecycle. The PostgreSQL secret-provider journey separately proves encrypted persistence and secret isolation; canonical attribution, actor integration and deployed durability remain unproved.
OAuth state expires after ten minutes (an engineering limit). Secret-provider retention must preserve irreversible revocation fences; it must never delete a tombstone and permit the same reference to become active again. Keys must remain available for referenced older key
versions until those rows have been retired or re-encrypted. Do not compose a memory store in
production. Do not place plaintext in events, run evidence,
logs, traces, prompts, R2 keys or Durable Object names.

## PostgreSQL secret provider

`packages/persistence/src/postgres-mcp-secrets.ts` implements the encrypted storage port in a
separate PostgreSQL schema. The non-login `clockgrove_mcp_secrets` role has access only to that
provider. The ordinary runtime role has no access. Forced RLS binds each operation to the complete
tenant, world, timeline, installation and installing-owner scope. Envelope state and revision form
encryption authenticated data, so fencing preserves them and sets a separate irreversible bit.
SQL guards prevent clearing that bit, changing scope, deleting tombstones or reusing a revision.
The vault continues to own the separate versioned credential keyring; the adapter receives only
sealed envelopes and opaque references. Nothing is appended to the Journal by this provider.

Decision: this adapter sacrifices credential availability on provider restart to preserve the
storage port's fail-closed uncertainty guarantee. It owns a dedicated, pinned PostgreSQL session
and an exclusive scope lock. Opening a provider fences all existing references in that scope
before permitting operations. A competing provider fails closed while the first session owns the
lock. A connection error makes the provider unusable; no transparent reconnect is allowed.
After session loss, a successor must acquire the lock and fence the old references before it can
serve reads. Thus even a revocation request that never committed cannot expose an old active
credential through a fresh provider. Operators must reconnect credentials after provider takeover,
including a graceful restart. This adapter is not composed into the Worker or a connection pool.

The [database runbook](../runbooks/database.md#mcp-secret-provider-prerequisite) records role
provisioning. Future installation composition must supply the privileged pinned connection,
coordinate provider ownership, and expose reconnect through the operator flow. Do not use a
per-request provider: opening it deliberately invalidates all older scoped credentials.

## Cloudflare composition prerequisite

The owner's decision is DNS preflight plus verified platform private-egress blocking, with the
residual risk documented at the first deployed consumer. This part does not assert that ordinary
Workers fetch satisfies the pinning port. Before composing it, verify hosted behavior and enable
[`global_fetch_strictly_public`](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)
to prevent own-zone fetch shortcuts to origins. The
[workerd network configuration](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)
describes a default public-only network, but that alone is not hosted Cloudflare evidence. If the
verified hosted adapter leaves an actual rebinding hole, use an egress adapter that pins addresses.

## Acceptance boundary

The foundation is a sequential delivery part, not acceptance of issue 164 as a whole.
In particular, address admission is not hosted installation safety; a discovery snapshot alone is
not a canonical installation or registry version; ciphertext owner binding alone is not
installation authorization; and credential fencing is not actor grant
revocation. The PostgreSQL secret journey establishes secret persistence and isolation only; it does not establish the complete PostgreSQL/runtime/browser installation path. No operator installation procedure is available yet.
The internal governance service below supplies canonical installation records and reviews; all
remaining composition obligations must be delivered before deployment.

## Remaining acceptance by delivery part

The PostgreSQL provider (part 2) and internal governance (part 3) are independently
reviewable under the Factory `implement-split` sequential-delivery rule. Their passing
proofs do not complete the following installation acceptance entries. The remaining work stays in issue
164; these are prerequisites for remote actor access, not optional follow-ups.

| Issue acceptance | Required integration and real-path proof |
| --- | --- |
| 2: Network safety at install | Authenticated installation endpoint and production outbound adapter; readable sanitized refusals and malicious-schema, redirect, SSRF and rebinding installation journeys. Hosted egress verification precedes exposure. |
| 3: Discovery recorded | Internal attributed snapshots are persisted in part 3. Remaining: compose admitted discovery into installations and register disabled tools in the one capability registry. |
| 5: Pinning and drift | Internal refresh drops changed-schema and protocol-drift reviews in part 3. Remaining: connection/operator refresh composition and PostgreSQL/runtime proof for callable registry versions. |
| 6: Bindings and grants | Scoped bindings and grants narrowing inputs, destinations, call counts, effects, budget and expiry; most-specific deny and session approval resolution through the actor runtime. |
| 7: Immediate revocation | Canonical installation, binding and capability disable/revoke operations notify the actor capability revision hook and fence new use without cognition. Credential fencing alone is insufficient. |
| 8: Operator authority | The separate owner-defaulted installation grant governs internal changes in part 3. Remaining: authenticated install, enable, bind and revoke routes; actors cannot install, supply credentials or grant access. The secret-provider database role supplies no operator authority. |
| 9: Canonical isolation | Installation/review Journal records, scoped RLS and retention ship in part 3. Binding/grant events and full composed isolation proof remain. Secret envelopes remain outside the Journal. |
| 10: Credential exclusion | Composed authenticated OAuth/static-token installation, refresh, failure and revoke journey through PostgreSQL, with canary exclusion checked in Journal, runtime evidence, logs, traces, prompts, errors, R2 keys and Durable Object names. Memory OAuth tests alone are insufficient. |
| 11: Real-path experience | Deterministic fixture installation through PostgreSQL and actor grants/runtime, plus the operator capabilities-screen browser journey for connect, inspect, review, bind, refresh and revoke. |

Internal canonical governance is available in part 3. Authenticated credential composition
precedes registry and runtime integration; the operator screen and complete canary/browser proof finish
the Objective. No installation endpoint or callable remote actor capability is
exposed by this part.

The remaining delivery groups are ordered within issue 164:

- Part 4 adds the internal authorized discovery-to-Journal coordinator described below.
  It is proved against actual HTTP fixtures and PostgreSQL, without exposing a deployed route.
- Part 5 supplies internal owned static/OAuth discovery, reviewed-version registry snapshots
  and canonical scoped binding policy, as detailed below. Production provider/reference ownership,
  verified hosted egress, authenticated routes and actor revision wiring remain final-part work.
- Part 6 adds the operator capabilities screen and completes the composed
  PostgreSQL, deterministic-server, actor-runtime and browser proofs (entry 11),
  including the full credential-canary surfaces in entry 10. The final operator
  runbook must describe those proven operations before Objective completion.

These assignments preserve the full OAuth decision and every acceptance entry;
they do not authorize production remote access or count pending proofs as passed.

## Canonical integration still required

Installation and review changes are now attributed Journal events; binding and grant changes
must follow that path. All are backed by
PostgreSQL with tenant/world/timeline RLS and retention entries. Only the separate installation
grant, held by world owners by default, may install, enable, bind or revoke. Actors and decision
models cannot supply credentials, authorize operations or grant themselves access.

A single installation serves multiple scoped bindings. Most-specific deny precedes narrowing
grants, then session approval. Grants must constrain inputs, destinations, calls, effects, budget
and expiry. Connection listings and operator refresh compare pinned protocol/schema versions;
only affected versions disable on drift. Revocation invalidates new use through the actor
capability revision hook immediately, without waiting for cognition.

The remaining proof is PostgreSQL plus actor-runtime fixture journeys, the isolation attack
suite and a real operator browser journey for connect, inspect, review, bind, refresh and revoke.
Resources stay disabled until Wave 6 ingestion; provider prompts remain untrusted candidates.
The [runtime runbook](../runbooks/runtime.md#remote-mcp-installation-readiness) records this
readiness boundary rather than presenting future procedures as available commands.

## Canonical installation governance

Part 3 adds `PostgreSqlMcpInstallations` in
`packages/persistence/src/postgres-mcp-installations.ts`, backed by migration 0046. It records an admitted discovery
snapshot and its installation scope, installing operator, remote endpoint, server identity,
protocol metadata and schema hashes. Credential-reference attachment remains part of trusted
credential composition. This service is not an HTTP
installation endpoint: trusted composition must first perform network admission and discovery
through the transport port. It accepts no credential plaintext and makes no remote calls.

The separate `runtime:mcp-install` grant governs installation changes; world owners hold it by
default. An actor, a model and a principal holding only `runtime:world-operate` cannot authorize
these changes. Authorization uses canonical membership and grants inside the database
transaction, rather than accepting server assertions or a caller-supplied grant list.

Discovery starts with every candidate disabled and classified `external-write`. An operator
reviews an exact tool schema hash and assigns one of `read`, `world-write`, `external-write`,
`destructive`, `network` or `cost`. Resources and prompts remain disabled untrusted records;
none of their text becomes policy. Refresh compares the admitted snapshot with recorded pins.
Changed or removed tools lose enablement; unchanged tool reviews survive. Current changed tools
are recorded in the `drifted` list until exact-pin review clears them. A protocol change
requires renewed review of tools. Revocation is terminal for the installation.

Installation, refresh, review and revocation write attributed canonical Journal events in the
same transaction as their state changes. The event payload stores deterministic `operationJson`
text so arbitrary finite schema numbers survive the Journal's integer-only canonical payload
encoding; the database parses that same operation into structured installation state. Scoped RLS
protects the records, and their retention
entries describe installation-lifetime state. Encrypted credential material remains exclusively
in the isolated secret provider. The PostgreSQL governance journey proves this internal path,
not authenticated OAuth composition or actor revocation.

Part 3 alone does not grant actor access. Part 5 below adds reviewed-version admission snapshots,
scoped binding policy and owned credential-backed discovery. Deployed actor revision notification
and authenticated network/credential composition remain final integration work.
The capabilities screen and complete PostgreSQL/runtime/browser canary journey finish the
Objective. Until those are delivered there is no operator installation procedure to run.

## Authorized discovery composition

Part 4 adds the internal `McpInstallationService` in
`packages/application/src/mcp-installation-service.ts`. Its trusted composition supplies the
PostgreSQL governance adapter, network port and authenticated principal context; it adds no
operator route, credential input or actor invocation.

Install checks canonical `runtime:mcp-install` authority before DNS or HTTP, then uses
`RemoteHttpMcpDiscovery` through `SafeMcpHttpClient` to obtain the snapshot. The caller supplies
only an installation identifier and endpoint, never a discovery snapshot. The governance adapter
checks authority again in the Journal transaction, so authority revoked during discovery cannot
commit an installation. Remote claims do not authorize any operation.

Refresh reads the endpoint and space from canonical storage, refuses inactive installations,
and performs the same admitted discovery before committing drift. If discovery fails or the refresh commit is rejected, refresh
commits a whole-installation disable that clears reviews before returning the refusal. This
safety invalidation uses its own command ID so retrying an earlier successful refresh cannot
collide with that refresh receipt and prevent disabling. This includes a valid changed-schema
listing whose command ID replays an earlier successful refresh: rejected changed bytes must
not leave the previous enabled reviews active. If that
commit is uncertain, it returns `installation_change_failed`, never success; trusted callers must
treat the installation as unavailable until canonical state is reconciled. A disabled installation
is not refreshed or reactivated by this service; reconnect requires a new installation. Successful
complete discovery still preserves unchanged tool reviews. Exact-pin review, disable and
revoke use the existing Journal operations. A caller cannot use the coordinator's change surface
to submit an install/refresh snapshot, even by bypassing TypeScript. Fixed refusal codes hide
storage/transport exception text; network policy refusals remain readable codes. No transaction
is held across remote requests.

The PostgreSQL/HTTP journey proves this internal composition, including unauthorized requests
without outbound work, refused server attempts without persisted installations, per-tool drift,
and terminal installation revocation. It does not establish hosted egress, credential
composition, registry callability, runtime invalidation or the operator browser experience.
Those remain mandatory before production exposure and Objective completion.

## Scoped binding policy and registry admission

Part 5 adds `McpBinding`, `PostgreSqlMcpBindings` and migration 0050. An operator holding
`runtime:mcp-install` changes policy through an attributed `McpBindingChanged` Journal event in
the same transaction as its row. The database rechecks canonical membership, refuses actor
identities, rejects direct writes, and serializes policy changes with installation review/refresh/
revocation. Binding changes increment the installation revision. Rows and reads remain isolated
to their full tenant/world/timeline and installation; each new table has a retention entry.

A binding names an exact tool/protocol/schema pin, one tenant/world/timeline/actor/session scope,
and an enabled allow or deny. Broad scope IDs must match the canonical installation scope;
session IDs must name a live session there. Actor IDs are exact opaque identities, since the
base has no independent actor table. Binding policy supports top-level input-field allowlists,
exact destination allowlists, call limits, allowed effect classes, microdollar budgets and UTC
expiry. Empty field/destination lists allow none. A zero-call grant grants no use. Counts and
budgets are operator-provided nonnegative safe integers, not provider hints. Policy sizes reuse
the existing bounded installation limits, with explicit engineering decisions in migration 0050.

`resolveMcpCapabilityRegistry` builds a snapshot in the existing `CapabilityRegistry`, preserving
its internal definitions and default grants. Remote names include installation ID, tool ID,
protocol version and schema hash. Server descriptions never become registry instructions. Tools
remain ungranted unless the installation is active, an exact current review enables the pin,
the tool is not drifted, and matching scoped policy allows it. Resources and prompts never
become registry definitions. Unsupported schema vocabulary fails closed rather than dropping a
constraint. The supported typed subset handles properties, required fields, additional-property
refusal, arrays, scalar types, enums/constants and numeric/string/array bounds.

Any enabled matching deny blocks admission, including an ancestor deny and a deny for an older
pin. Denies remain until explicitly disabled; grant expiry does not silently expire a deny.
Otherwise the most-specific matching allow wins, with intersected constraints when multiple
allows share that specificity. A trusted session approval can only narrow these grants.
Destination and cost bounds require trusted execution metadata; missing values refuse use.
Expiry is checked again when authorizing, not only at snapshot construction. Call/spend values
are trusted inputs to admission, not durable reservations or a remote executor.

Canonical state must be loaded before new use and invalidated through the actor revision hook.
This part proves rebuilt admission from PostgreSQL (including drift of one of two HTTP-discovered
tools); it does not wire that loader or hook into deployed actors. A retained admission snapshot
cannot establish immediate revocation by itself. Runtime wiring, atomic execution reservations,
approval persistence and the complete actor/browser proof remain final-part work.

## Owned credential-backed discovery

`McpCredentialInstallation` owns one new installation attempt and one isolated credential
provider. It checks canonical installation authority before opening that provider, fixes the
operator and complete scope before asynchronous work, and retains only an opaque reference.
The provider stays open across OAuth begin/callback, token refresh and discovery. The
`McpInstallationService` optional trusted authorization callback passes the bearer directly to
discovery inside `McpCredentialVault.use`, preserving raw and decoded credential-echo refusal.
No bearer is sent to OAuth metadata endpoints. A static token uses the same discovery path.

Installation is committed only after credential connection and safe discovery. Failed or
uncertain install closes the provider. OAuth refresh failure disables the installation through
the Journal and closes the provider; discovery refresh failure does likewise. Revocation commits
canonical revocation before contacting the remote OAuth revocation endpoint, so an uncertain
remote response cannot restore canonical enablement. Authorized cleanup also accepts an externally
disabled or already revoked installation, preserving owner/endpoint/space checks and skipping
a redundant canonical revoke. A failed cleanup preflight still closes the owned provider without
making an unauthorized remote request. Credential failures contain no remote text.
Credential-backed discovery preserves only enumerated network-policy refusal codes, reconstructed
as fixed errors without the original message or cause, so an operator can distinguish a private
target, unsafe redirect or DNS change. Unknown refusal codes and credential/provider failures
remain the generic credential-unavailable error. Explicit close terminates the provider; the PostgreSQL adapter's existing takeover fence
requires reconnect rather than silently reopening an old reference.

The handle is internal and session-owned. It is not a durable directory of installation-to-secret
references or an authenticated HTTP route. Production must supply a dedicated provider owner,
durable reference linkage, callback routing and cleanup/reconnect procedures before activation.
The real PostgreSQL/HTTP journey proves static/OAuth connection, refresh, failure, echo refusal
and revoke at this boundary. Whole-runtime canary exclusion (logs, traces, prompts, evidence,
R2 keys and Durable Object names) and the operator browser journey remain pending.

Hosted egress is still uncomposed. Cloudflare's [strict public fetch documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)
and [request routing documentation](https://developers.cloudflare.com/workers/runtime-apis/request/)
were checked on 2026-11-10: public routing is a platform boundary, while DNS preflight alone
cannot pin an independently resolved connection. No global-fetch adapter or production network
switch is introduced here. The final consumer must verify and prove the owner-decided hosted
private-egress protection and document residual rebinding behavior before exposing endpoints.

## Hosted evidence ownership

Owner amendment (2026-11-10, issue 164): the hosted private-egress verification belongs to
issue 3 and runs on staging after issue 2's first successful deployment. Local operator,
credential and actor integration does not wait for that receipt. Production remote MCP
composition remains disabled until that candidate-bound hosted receipt exists; local fixture
results do not substitute for it. The required checks include private/metadata destinations,
redirect admission and DNS rebinding with the platform's public-egress boundary. Any residual
hole still requires pinned egress under the original decision.

Bearer-bearing endpoint or redirect URLs are refused, including decoded URL matches, before
outbound requests. This keeps credentials out of URL-derived evidence as well as response data;
operators receive the fixed `credential_url_refused` code.

## Local runtime composition

`McpRuntimeOperator` retains isolated provider ownership across authenticated operator requests,
including OAuth begin/callback, refresh and revoke. It performs canonical installation-authority
checks before outbound work and Journal commits. Anonymous discovery uses the same safe HTTP
policy. Static/OAuth bearer values are supplied only inside the vault callback. The browser sees
sanitized fixed refusal codes, discovery data and canonical policy state, never a credential
reference or provider exception text. Listing returns tool/resource/prompt candidates; review
and binding changes use exact pins and the attributed Journal path.

`composeMcpOperator` requires a separate direct secret database connection, a dedicated versioned
keyring and trusted network/OAuth configuration. Local Workers forward authenticated operator
requests over the internal `MCP_OPERATOR_DO` binding to `McpOperatorDO`. This Durable Object owns
the retained sockets, so OAuth callbacks and refreshes may use them from later requests. One
local owner preserves the configured installation capacity across all scoped installations;
its fixed non-secret name contains no credential, endpoint or installation data. It writes no
Durable Object storage; PostgreSQL remains canonical. The runtime retains its owner across requests;
provider close disables credential installations. Lost owners cannot be transparently recreated
from a pooled connection: refresh fails closed and reconnect uses a new installation identifier.
These are local composition boundaries, not permission to expose a production network adapter.
`RuntimeComposition.mcpConfiguration` wires local owner lifetime and actor revision notification;
non-local composition is guarded off pending the hosted receipt owned by issue 3.

`actor_mcp_admission` reads the canonical live participant and membership before returning a scoped
registry snapshot without endpoint, owner or secret metadata. Installation and binding scope is
tenant/world/timeline, so admission and revision notifications span spaces within that scope;
the participant still needs live membership in the session's own space. Actor owners reload before claim,
model context and proposal and reconcile the revision hook. Revocation therefore stops new
admission without cognition, including after a missed notification. RW-0508 now connects local
read execution and canonical call/spend reservations through the governed research composition below. The
[runtime runbook](../runbooks/runtime.md#local-operator-lifecycle) describes install, review, bind,
refresh, reconnect and revoke.

## Effect ledger foundation (issue 165, part 1)

Migration `0056_effect_ledger.sql` introduces canonical `effect_intents` and `effect_attempts`.
This is the first delivery part of read-only research, not a callable MCP execution path.
The ordinary runtime can read ledger metadata only with current scoped MCP installation
authority and an operator-evidence privacy ceiling. It cannot insert, update or delete ledger
rows. A later part must supply the governed reservation and execution port before any
actor can use these records. Installation and binding authority alone never authorizes a call.

Intent identity and the scoped idempotency key survive for world lifetime. Each intent permits
one attempt: an interrupted read cannot be resent automatically under that identity. Attempts
retain an explicit terminal disposition, including uncertainty; an uncertain remote outcome is never
guessed into success or failure. A terminal attempt may precede settlement of its started
intent; recovery must read that attempt and settle the matching intent without another call.
A successful attempt requires a recorded encrypted result. Unknown cost remains distinct from a
known zero. Arguments and results belong in encrypted artifacts, rather than plaintext ledger
payloads. The
[database runbook](../runbooks/database.md#preview-effect-policy) describes the unchanged
`external-effects` dispatch gate: non-live timelines cannot enqueue external calls.

Remaining delivery parts supply atomic grant and budget reservation, Queue execution and
dead-letter handling, immediate global/world/installation kill switches, durable
`tool_waiting`/`tool_completed` recovery, the bounded model loop, safe MCP execution and result
sanitization, citations and the scripted browser journey. Historical replay must consume the
recorded result without contacting a server. Preview work must remain blocked or simulated.
None of those execution guarantees is established by the schema foundation alone.

### Internal attempt persistence (delivery part 2)

`PostgreSqlEffects` in `packages/persistence/src/postgres-effects.ts` provides the internal
attempt lifecycle on an existing intent. Its client must already possess trusted ledger-write
authority. These lifecycle methods operate on existing intents; the part 3 `reserve` method
described below creates already-admitted intents atomically with their outbox rows. The adapter
is not composed into the actor runtime, does not enforce turn budgets and grants no SQL
permissions. The ordinary runtime role still cannot write the ledger.
Future Queue composition must complete installation, binding, member-grant, argument, network
and budget admission before invoking this adapter.

Claiming locks the complete tenant/world/timeline/effect identity. Only the transaction that
moves a pending intent to started may begin its one attempt. Duplicate deliveries read the
existing state and receive no execution claim. A started attempt remains in flight until an
explicit outcome is recorded; elapsed time alone does not turn it into failure or permit retry.
Completion records the attempt and settles the intent in one transaction. Recovery can also
settle a started intent from its previously recorded terminal attempt, preserving its exact
outcome and timestamp. An uncertain outcome stays terminal. Scoped reads return encrypted
result references for future replay consumers; they never contact a server. Accounting keeps
known cost and the number of terminal attempts with unknown cost separate.

These PostgreSQL guarantees do not yet establish Queue delivery, actor recovery, admission,
remote execution, result screening or browser research acceptance. Those remain later parts.

### Internal read-execution transport (delivery part 2)

Issue 165's second delivery part adds an internal HTTP execution boundary in
`packages/application/src/mcp-execution.ts`. It is a prerequisite for governed Queue
execution, not an actor-callable capability or a deployed service. Trusted composition
must resolve the enabled installation, exact binding and member grant, validate the pinned
schema and normalized arguments, apply policy, reserve budgets and create the intent before
using it. Server read-only hints do not supply authority. The existing `McpTransportPort`
and discovery API stay compatible.

The adapter reuses `SafeMcpHttpClient` and the pinned 2025-11-25 initialization lifecycle.
It initializes a connection, acknowledges initialization and issues one `tools/call` request,
without retries. Execution refuses every tools/call redirect, including same-origin 307/308,
and records uncertainty without sending to the redirect target. Discovery retains its existing
safe-redirect policy. The credential is obtained inside the adapter through the vault callback;
callers provide only the scoped opaque credential reference. The network policy still
requires HTTPS, admitted public addresses, pinned connections, safe redirects, bounded
responses and DNS checks. Test-owned public-name mappings to a loopback HTTP fixture
prove adapter behavior, not hosted egress safety.

`RemoteHttpMcpReadAdapter` accepts an explicitly admitted read request and returns
`McpReadEvidence` with `trust: untrusted_evidence`, a success or tool-error status,
text content and unknown cost. Fixed `McpReadFailure` codes distinguish `not_sent`,
`uncertain` and `result_refused`; none means that an interrupted call is safe to resend.

Engineering limits are 64 KiB of normalized argument JSON, 64 KiB of output text
(configurable downward), 32 text blocks, nesting depth 16 and 16,384 JSON nodes. These
are conservative memory/context bounds, not MCP protocol requirements or turn budgets.
The existing HTTP layer independently allows at most 1 MiB and 15 seconds per request.

Only bounded text evidence may cross the result boundary. Results remain explicitly
untrusted evidence, never facts or capability proposals. Embedded instructions have no
policy, catalog or grant dispatch path. Control and bidirectional override characters are
replaced and the resulting text is size-checked again; metadata and annotations are discarded. Unsupported content and
malformed/oversized results are refused before model inclusion; server error text and
credential echoes are never exposed as diagnostics. Echo screening uses the normalized
Authorization header token actually transmitted, including when the stored credential is padded. Tool cost remains unknown rather than inferred as zero.
The owner-deferred shadow judge is not added here.

The transport alone supplies neither tenant/grant admission nor a crash-safe call.
The final local composition below adds ledger admission, Queue/DLQ, kill switches,
durable waits, model steps, replay, citations and browser research. It claims the durable
attempt before invocation and records explicit uncertainty after interrupted transport,
with no automatic resend.

### Internal intent and outbox persistence (delivery part 3)

`PostgreSqlEffects` can atomically persist already-admitted effect metadata and its
`external-effects` outbox row. This remains an internal privileged storage boundary;
ordinary runtime SQL permissions are unchanged. It does not resolve grants, enforce turn
budgets, expose a capability or invoke the MCP transport. Trusted admission must still
perform the preceding execution-order checks before using it.

An executable intent requires an existing conversation event in the exact tenant, world,
timeline and space. The adapter derives the dispatch partition from that event, and writes
only the effect identifier into the conversation-class payload. The existing outbox permits
one external-effects dispatch per event, so each admitted call needs its own canonical event.
Intent and dispatch either both commit or neither does. The preview dispatch gate remains
unchanged. Blocked, simulated and refused intents record their reason without an outbox row.

An identical retry returns the recorded effect, including a completed attempt. A changed
argument hash, identity, attribution, reservation or dispatch reference fails closed, preserving
the first record. An existing intent with a missing or inconsistent dispatch is not repaired:
that could enqueue historical work again. Callers must reconcile such inconsistencies rather
than retry execution. Argument content remains in encrypted scoped artifacts; credential
values and remote error bodies have no place in the reservation metadata or queue payload.

This persistence API does not establish atomic policy/budget admission or Queue execution.
The real consumer, kill switches, durable actor waits, tool loop and integrated research
experience remain subsequent delivery parts of issue 165.

### Internal Queue execution boundary (delivery part 4)

`apps/runtime/src/external-effects.ts` supplies an internal `external-effects`
consumer using `TypedQueueConsumer`. It accepts an identity-only queue payload,
then verifies the dispatch against canonical PostgreSQL event and intent metadata.
Tenant, world, timeline, source event, correlation, space, partition and conversation
privacy must agree. A transport attempt hint is not an execution fence. Queue
payloads never supply endpoint, arguments, grant, policy or credential authority.
The admitted request is cloned and its argument hash checked again before adapter use.
Argument identity is the lowercase SHA-256 of UTF-8 JSON with recursively sorted
object keys and preserved array order; finite decimal values remain valid.
Non-JSON values are refused rather than silently changed by serialization.

Trusted composition must supply fresh admission and request loading, the read
adapter, and encrypted result-artifact persistence. These are required internal
ports, not optional bypasses. This boundary does not implement canonical grant or
budget admission itself. The final local composition connects these ports to canonical
admission and the existing Queue factory. Hosted composition remains disabled.

The consumer claims the ledger attempt before calling its adapter. Only the winner
may execute. Terminal duplicates reconcile and return without another adapter call;
a duplicate of a started attempt fails visibly rather than acknowledging unfinished
work or resending. Successful evidence must be saved as an encrypted scoped artifact
before the attempt can succeed. Tool failures and interrupted execution record fixed
outcome codes, never exception text. Unknown cost remains null and is counted by the
ledger's accounting query. A storage failure is retried as recovery, never as a second
remote call under the same identity.

The retained PostgreSQL proof exercises the typed consumer with a deterministic fake
adapter. It does not establish hosted Queue delivery, DLQ routing or an actor turn.
Parts 5–6 add canonical admission and kill switches, local publication/Queue/DLQ composition,
turn waits, the model loop, citations and native/browser proofs. External-effect dead-letter
and exhausted-publication diagnostics now settle unsent effects visibly and resume waiting
turns; the provider Queue retry policy is unchanged.


### Internal canonical read admission (delivery part 5)

`PostgreSqlMcpReadAdmission` supplies a privileged persistence boundary before the
internal Queue consumer. It is not an actor-callable tool and adds no runtime SQL
privilege. Admission reloads the canonical installation and exact reviewed read pin,
resolves matching binding policy through the capability registry, and normalizes the
arguments through that pin's schema. A member turn additionally needs the exact
version-specific MCP capability name in its current world membership grants. The
binding alone cannot supply that member grant. Proactive admission uses the canonical
installation owner's current installation authority. No model or tool result can
select authority, change policy or alter the catalog.

Capacity belongs to the canonical turn, across retries and run segments. A serialized
transaction records call, time, output and conservative cost reservations together
with the intent and its conversation outbox. Identical retries consume no additional
capacity; conflicting identities fail closed. A separate immutable retry-refusal receipt
records the presented identity hash and `arguments_changed` or `retry_conflict`,
without storing the presented arguments. The refusal commits before the caller receives
the fixed error; it neither replaces the original effect nor adds dispatch or capacity.
Identical conflicting retries reuse that receipt. Reservations are retained, including
when actual cost is unknown. Actual cost still comes from the attempt ledger and
remains NULL when unknown; reserved money is not a price observation. The owner's
defaults are three tool calls, four model steps and a separately configured 250000
microusd tool-turn envelope (2026-11-09). The internal reservation uses the full transport maxima: 45 seconds for initialize,
notification and call (three 15-second HTTP deadlines) and 64 KiB of result text per
call. The default turn therefore reserves at most 135 seconds and 192 KiB. Smaller
remaining capacity refuses a new call rather than weakening the adapter limit.
The final research loop reserves model steps before cognition and includes their capacity
in the same envelope, pinned to the turn across recovery.

Global, world and installation kill switches are checked during reservation and
fresh pre-execution admission. The latter reloads persisted identity and current
canonical grants, pins and bindings. A committed revocation or disabled switch
refuses the next admission without actor cognition. It does not pretend to cancel
an already-sent call: the one-attempt ledger must retain its result or explicit
uncertainty. Switch administration requires a privileged operator connection;
there is no actor capability or HTTP switch endpoint.

The admission class alone does not activate a Queue handler. The trusted final composition
applies network admission before reservation, loads and verifies encrypted arguments,
enforces time/output bounds, resolves credentials only through the retained installation
provider inside the adapter, and saves encrypted results.
Canonical installation rows do not yet contain a credential-reference directory;
this admission API never accepts a credential supplied by a queue message or model.
It does not establish authenticated remote execution by itself. The final delivery part
below connects local Queue publication/DLQ, durable actor waits and bounded model loop,
run evidence/citations, malicious fixtures and the scripted browser research proof. Hosted remote activation retains issue 3's egress gate.

## Local governed research (issue 165, final integration)

`apps/runtime/src/research.ts` composes the merged admission, effect ledger, encrypted artifact
store and typed Queue consumer. This local path supersedes the pending local-integration notes
in delivery parts 1–5 above. Hosted MCP stays disabled pending issue 3's accepted egress receipt;
local fixture routing is not evidence of hosted SSRF or DNS-pinning safety.

Every call resolves the current installation, reviewed pin, binding and member grant (or the
canonical installing owner for an admitted proactive turn). Normalized arguments and network
preflight precede durable capacity reservation. The canonical effect has a stable call/idempotency
identity, argument hash and encrypted argument artifact. Its conversation event/outbox publishes
only an effect reference on `external-effects`, using the ordinary publication/retry/DLQ path.
Fresh pre-execution admission checks revocation and global/world/installation fences again.
The adapter resolves credentials through the retained installation owner; no queue field supplies
a credential, endpoint, grant or execution authority.

Only one attempt may send. Sanitized text evidence is encrypted before a terminal success is
recorded. Queue redelivery reads that result without contacting the MCP server. A started attempt
is never reset to pending: after three 15-second transport deadlines plus a 15-second persistence
allowance, reconciliation uses an already sealed result or records explicit uncertainty.
Late or duplicated completion cannot overwrite an earlier terminal disposition. A completed
call wakes the same turn through `tool_completed`, rather than opening another conversation.

The policy configures calls, model steps, cost and conservative per-call/model reservations.
Owner defaults are three calls, four model steps and 250000 microusd per tool-using turn.
Reservations are capacity, not observed prices; unknown actual cost remains null and counted.
Model retries retain earlier capacity. Internal `inspect` and `why` use this loop too, under
ordinary current member authority. Bounds, revoked grants, changed arguments, unsafe targets,
preview blocks and unavailable dependencies are recorded rather than treated as actor behavior.

Tool results remain untrusted evidence. The transport refuses malformed/oversized content,
unsafe redirects, SSRF and DNS changes; a tool cannot widen policy or the catalog. A bounded,
labelled excerpt enters model context; the complete sanitized result remains protected.
`[tool:<callId>]` citations and structured run-step evidence join message, turn, run, call, grant,
effect and result. See [turn recovery](conversation-fibers.md#governed-research-turns-issue-165),
[run evidence](runs.md#research-evidence-issue-165) and the
[operator procedure](../runbooks/runtime.md#internal-external-effects-recovery).

A real-model run against the fixture remains a maintainer action when a key is available.
CI and the default local proofs use deterministic scripted models; they never call a real provider.
The tool-result shadow judge remains the owner's separate follow-up to issue 162.

## Internal approval ledger (issue 166, part 1)

The first delivery part adds canonical approval persistence as a prerequisite for
protected writes. It does not activate MCP writes, expose an approval endpoint or
change the actor's existing read-only research path. The actor wait, person/operator
controls, dispatch integration, uncertainty resolution and browser journey remain
subsequent parts of issue 166.

The privileged persistence boundary stores exact scoped approval identities and
argument/effect hashes. Argument content belongs in encrypted conversation artifacts,
never approval metadata. Trusted application composition must normalize arguments,
compute the binding and authenticate the designated person before recording a decision;
a model proposal, tool result or claimed principal identifier cannot establish that
authority. Runtime SQL receives no approval mutation privilege.

Approval consumption must share the future dispatch admission transaction: spending
an approval separately from creating the intent/outbox cannot prove approval before
dispatch. That composition must also reload current grants, revocations, kill switches
and budgets, and preserve the live-timeline preview gate. A stored approval alone is
not a capability grant or permission to invoke the transport. Existing effect attempts
remain single-use and terminal uncertainty is never reset by approval persistence.

`PostgreSqlEffectApprovals` uses one `effect_approvals` row per scoped approval ID.
Its immutable binding includes the proposed effect ID, space, requesting and designated
approver principals, argument/effect hashes, optional encrypted argument-artifact
reference, configured lifetime and exact database expiry. Repeating a request preserves
its original expiry; changed bindings conflict. The default lifetime is 600 seconds,
from the owner's ten-minute decision. Expiry is checked with the database wall clock
after locking the row, including when another transaction delayed the caller.

Only the designated principal may decide or revoke through this privileged adapter.
Approval and denial are immutable decisions; revocation or consumption retains their
original attribution. Pending or approved requests may be revoked. Consumption requires
an approved, unexpired, exact binding on a live timeline and succeeds once; the
`consumeInTransaction` method allows later composition with intent/outbox creation.
Denied, expired, revoked and consumed rows cannot become approved again. Operator-only
RLS and runtime read-only privileges follow the existing effect-ledger inspection policy;
member-facing projections are not provided by this foundation.

`apps/runtime/test/effect-approvals.postgres.test.ts` exercises real PostgreSQL, independent
connections, request/decision deduplication, binding conflicts, rollback, reconnect,
expiry during a lock wait, preview refusal and encrypted artifact scope. It also runs
`tests/database/effect-approvals.sql` for scope/privacy and runtime mutation attacks.
These are storage proofs; they do not establish actor execution or a browser journey.


## Atomic approved-effect reservation (issue 166, part 2)

The internal `PostgreSqlApprovedEffects` composition joins exact approval consumption
and the existing effect intent/outbox reservation in one PostgreSQL transaction. A
failed reservation rolls back both. This remains privileged persistence: it supplies
no human authentication, grants, current-policy admission, model tool or transport
activation. MCP research remains read-only. Actor waits and person/operator controls
are still pending.

A versioned effect hash binds all intent metadata and dispatch/event identity. The
argument digest is recomputed from the supplied normalized arguments with the existing
canonical JSON hashing rules; approval scope, principal, artifact and expiry must also
match. The normalized arguments must come from trusted schema/grant admission, not a
model's assertion that its input is approved. Argument content is not stored by this
composition. `approvedEffectIdempotencyKey` hashes the versioned approval address;
the new port requires that value as the immutable ledger key, durably associating
recovery with the original approval. Existing read and generic effect keys are unchanged.

Reservation serializes on the scoped effect identity before spending approval. An
identical retry using the consumed approval returns the existing ledger outcome and
validates the original outbox identity. It cannot consume another approval for an
existing effect, reset a terminal outcome or create another dispatch. This is recovery
of a reservation, not retry of an uncertain remote write. The caller-owned transaction
entry point lets later admission reserve budgets and recheck current authority in the
same transaction. Its caller must propagate every error and roll back the entire
transaction; the convenience `reserve` method owns that rollback. A future explicitly
approved safe retry needs fresh approval, effect and call identities; it cannot reset
the old uncertain record. That integration must use a consistent lock order, recheck authority
before transport, and preserve the existing preview/replay fences.

The real PostgreSQL proof is `apps/runtime/test/approved-effects.postgres.test.ts`.
It establishes atomic storage reservation and recovery, not actor execution, a remote
write or a browser approval journey.
