# Remote MCP installation

Issue 164's first part provides discovery and isolated credential foundations. It does not yet
install a server into a world, write canonical installation events, register actor capabilities,
or expose operator HTTP routes. Those consumers must preserve the contract below before remote
capabilities become usable. The existing [capability registry](capabilities.md) remains unchanged.

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
evidence; durable version pins and drift disabling require canonical integration.

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
reconciled; an adapter that simply throws and later returns the old unfenced row is invalid. This part proves encryption
and lifecycle behavior through fixture HTTP and an isolated memory implementation of that port;
it does **not** prove PostgreSQL persistence, RLS, canonical attribution or deployed durability.
OAuth state expires after ten minutes (an engineering limit); the storage adapter must retire
expired pending/blocked rows and token-free revoked tombstones under the canonical retention
policy when that adapter is introduced. Keys must remain available for referenced older key
versions until those rows have been retired or re-encrypted. Do not compose a memory store in
production. Do not place plaintext in events, run evidence,
logs, traces, prompts, R2 keys or Durable Object names.

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
In particular, address admission is not hosted installation safety; a discovery snapshot is not
a canonical installation or registry version; a schema hash is not drift detection; ciphertext
owner binding is not installation authorization; and credential fencing is not actor grant
revocation. The memory-store journeys do not establish durable secret isolation or the
PostgreSQL/runtime/browser path. No operator installation procedure is available yet.
All of those obligations remain in the canonical integration below before deployment.

## Canonical integration still required

Installation, binding, grant and review changes must be attributed Journal events, backed by
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
