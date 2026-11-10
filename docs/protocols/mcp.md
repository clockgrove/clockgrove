# Remote MCP installation

Issue 164 provides discovery, isolated PostgreSQL credentials, internal canonical installation
governance, scoped binding policy, reviewed-version registry admission and an owned credential-backed
discovery coordinator. It does not yet compose production installation, wire remote actor capabilities or expose
operator HTTP routes. Those consumers must preserve the contract below before remote capabilities
become usable. The existing [capability registry](capabilities.md) accepts additive remote admission snapshots; deployed actors still use the internal capabilities.

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
instructions never enter policy. There is no tools/call or resources/read execution method.

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
making an unauthorized remote request. Fixed credential errors contain no remote
text. Explicit close terminates the provider; the PostgreSQL adapter's existing takeover fence
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
