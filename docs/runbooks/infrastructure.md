# Infrastructure and environments

W0-008 defines configuration only. Start with the [documentation index](../clockgrove-documentation-index.md), [development reference](development.md), [Wave 0 environment and release contracts](../waves/clockgrove-wave-0-project-foundation-implementation-plan.md#16-environment-and-infrastructure-contract), and [architecture §22](../clockgrove-cloudflare-implementation-plan.md#22-infrastructure-architecture).

Use Node 24.21.0, pnpm 12.9.1, OpenTofu **1.13.1** on PATH and the lockfile-pinned Wrangler **4.147.0**. All five canonical Wrangler configurations enable `nodejs_compat`, required by the runtime's `pg` 8.23.1 driver, and the infrastructure check enforces it. Hyperdrive owns one connection per operation with rollback/close cleanup; Better Auth uses Kysely's built-in `PostgresDialect` and a separate request-owned pg pool limited to one connection and destroyed in `finally`. Both adapters own asynchronous driver errors and retain failures through cleanup before returning a result. Local PostgreSQL 18.6/pgvector 0.8.7 verification retains the isolated abstract socket using pg's declared stream configuration and a real Node socket; ordinary Hyperdrive URLs keep default transport. Infrastructure is outside the workspace; it adds no runtime dependencies. `pnpm run infra:validate` type-checks the strict Zod schema, runs the infrastructure tests, installs pinned Cloudflare 5.27.0 and Neon 0.1.15 providers into a new temporary directory, runs backend-free OpenTofu formatting/validation, and bundles all five Wrangler configurations with `--dry-run`. Providers come from the mirror that `scripts/ci/toolchain.sh opentofu-providers` fills beside the `tofu` on PATH when it holds every locked version, offline; otherwise directly from the public OpenTofu registry and its public release/signature URLs. Either way `tofu init -lockfile=readonly` refuses any package whose hash the committed lock file lacks, so the mirror cannot substitute a provider. It uses no other mirror, provider cache, user CLI configuration or credentials, and removes its temporary storage. Validation after installation needs no cloud API access. No plan, refresh, apply or deployment is part of validation. `pnpm check` also checks all manifests and scans HEAD, every indexed and non-ignored working repository path for secret-shaped values; it has no fixture or binary-path exemptions.

The exact deployment authority is [`runtimeBindingManifest`](../../apps/runtime/src/cloudflare-entry.ts): three SQLite Durable Objects, seven Workflows, three queue producers/consumers and their distinct physical queue-name variables. Wrangler owns these, the `ARTIFACTS_BUCKET` and `ASSETS_BUCKET` R2 bindings, the `METRICS` Workers Analytics Engine dataset binding (created on first write; the Cloudflare OpenTofu provider has no dataset resource) and cron/Worker observability. OpenTofu owns three queues plus three dead-letter queues, three R2 buckets, Hyperdrive, authenticated AI Gateway with spend/rate limits, Turnstile, an operations service token, DNS/Worker route, public WAF/rate-limit policies, the Neon project/branch/database and the Neon migration role, and generates the passwords of the other database roles. R2 expiration applies only to `ephemeral/`; canonical artifacts and backups are never expired by this rule. PostgreSQL grants, schema, pgvector and reviewed migrations stay with the [database workstream](database.md#migration-ownership-and-roles). Database-local roles preserve the existing SQL names `clockgrove_migrator` and `clockgrove_runtime`, plus `clockgrove_support`, `clockgrove_backup`, `clockgrove_auth_verifier`, `clockgrove_management_reader` and `clockgrove_world_reader`; project/branch/database isolation separates environments. Only `clockgrove_migrator` is a Neon API role: Neon makes every role created through its Console, CLI or API a member of `neon_superuser`, which reads and writes all data and which a non-superuser cannot revoke ([Neon roles](https://neon.com/docs/manage/roles)). The deploy's migration connection creates the other six, and the NOLOGIN `clockgrove_mcp_secrets`, with SQL, as [Database roles](#database-roles) describes, then verifies runtime/support/backup isolation before activating Hyperdrive or exposing a Worker. Fresh isolates now compose real verification and durable readers without an initializer. Missing/invalid authentication configuration fails closed; composition does not establish enrollment or activation readiness.

| Environment | Infrastructure operation |
| --- | --- |
| `local` | Local Wrangler, isolated local PostgreSQL/pgvector and fixture models; zero cloud resources and no required secrets. |
| `ci` | Local Wrangler, ephemeral isolated PostgreSQL and fixture models; zero cloud resources and no required secrets. |
| `development` | Dedicated `rw-development-*` cloud resources, Neon project and branch; qualified main integration. |
| `staging` | Dedicated `rw-staging-*` resources/project/branch and sanitized data; protected release candidate qualification. |
| `production` | Dedicated `rw-production-*` resources/project/branch; protected credentials and explicit human approval. |

Each `infra/environments/<environment>.json` permits only resource names, domains, the zone's Cloudflare plan, documented-safe Cloudflare account/zone IDs, retention, budgets, compatibility date and model aliases. Resource names include the public provider region name and canonical database-local role names. Objects reject unknown fields at every level. Zero account/zone IDs and `example.org` domains are publication-safe placeholders; replace them with reviewed non-secret routing metadata for your installation before planning a hosted environment. Use separate account/zone ownership for isolated staging and production; avoid combining zone-wide entrypoint rulesets with unrelated applications. Each hosted environment creates its zone's entry-point rulesets for the `http_ratelimit` and `http_request_firewall_custom` phases, and a zone allows one per phase, so development needs its own zone. Resources use the full canonical environment name. Local/CI cloud resource counts are zero even when a plan is requested; ordinary local use needs no cloud credentials or OpenTofu plan.

Each manifest's `cloudflareZonePlan` (`free`, or `paid` for Pro and up) chooses the zone's rate-limiting rule, since Free rules allow only the Path field with 10-second counting periods and mitigation timeouts ([Cloudflare rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability)):

| Zone plan | Environments | Rule |
| --- | --- | --- |
| `free` | `staging` (the `clockgrove.dev` zone), `development`, `local`, `ci` | `http.request.uri.path wildcard "/v1/*"`, the runtime API on every host of the zone; blocks a client IP for 10 seconds after `ceil(budgets.requestsPerMinute / 6)` requests in 10 seconds. |
| `paid` | `production` | `http.host eq "<runtime host>"`; blocks a client IP for 60 seconds after `budgets.requestsPerMinute` requests in 60 seconds. |

`pnpm infra:validate` has OpenTofu evaluate each hosted environment's rule from its manifest, offline, and fails unless it is the one the zone plan allows. The WAF rule matches the runtime host on every plan.

`retention.databaseSeconds` is the Neon project's `history_retention` (restore window). Staging's Neon organization is on the Free plan, which allows at most 6 hours ([Neon plans](https://neon.com/docs/introduction/plans)), so `staging.json` sets 21600; development and production keep 604800 (7 days, the Launch maximum). Raise staging back to 604800 when it moves to a paid Neon plan (Launch).

Secret names and consumers are declared in `infra/environments/<environment>.secrets.json`. Local/CI declare none. Each hosted environment declares the following, except that production declares neither `INFRA_STATE_*` name:

| Name | Consumer / source |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | OpenTofu Cloudflare provider; narrowly scoped operator credential. |
| `NEON_API_KEY` | OpenTofu Neon provider; isolated operator credential. |
| `INFRA_STATE_ACCESS_KEY_ID` | OpenTofu R2 state backend, development and staging only; the bucket-scoped R2 API token's access key ID. |
| `INFRA_STATE_SECRET_ACCESS_KEY` | OpenTofu R2 state backend, development and staging only; the bucket-scoped R2 API token's secret access key. |
| `DATABASE_URL` | Hyperdrive runtime-role connection; constructed securely from provisioned Neon runtime credentials. |
| `MIGRATION_DATABASE_URL` | Controlled direct database migration connection. |
| `SUPPORT_DATABASE_URL` | Read-only support connection. |
| `BACKUP_DATABASE_URL` | Backup verification connection. |
| `BETTER_AUTH_SECRET` | Runtime stored-session verification. |
| `AUTH_DATABASE_URL` | Generated direct PostgreSQL `clockgrove_auth_verifier` connection. |
| `MANAGEMENT_DATABASE_URL` | Generated direct PostgreSQL `clockgrove_management_reader` connection. |
| `WORLD_AUTHORIZATION_DATABASE_URL` | Generated direct PostgreSQL `clockgrove_world_reader` connection. |
| `MODEL_PROVIDER_API_KEY` | AI Gateway stored provider key; never an ordinary Worker variable. |
| `TURNSTILE_SECRET_KEY` | Public abuse verification consumer, once composed; provisioned widget secret. |
| `CF_ACCESS_CLIENT_SECRET` | Operations Access service-token consumer; provisioned service-token secret. |
| `SENTRY_OTLP_TOKEN` | Observability exporter, once composed. |
| `ARTIFACT_KEYRING` | Artifact encryption KEKs, consumed by private conversations only: format `{"version":1,"current":"<kekId>","keys":{"<kekId>":"<base64url 32 bytes>"}}`. Rotate per [database.md](database.md#artifact-key-rotation). Without it, [conversations](../protocols/conversations.md) answer `503 conversation_unavailable`. Every other artifact producer still composes `ArtifactStore` with no keyring, so every class but `public_scene` fails closed with `ArtifactKeyUnavailableError`. The hosted deploy does not yet push this secret to the Worker (issue 3). |

The repository root lists these names, without values, in two examples generated from the catalog `requiredSecrets` in [`infra/check-configuration.mjs`](../../infra/check-configuration.mjs) and this table: [`.dev.vars.example`](../../.dev.vars.example) holds the four Worker secret bindings `runtimeBindingManifest` declares, and [`.env.example`](../../.env.example) the other operator and tooling names. Each name's comment gives its catalog consumer and the first clause of its row above. Read them to see which names an environment needs; never write a value into them. A hosted environment receives the four Worker secret bindings as Worker secrets set from the operator's secret manager session (for example `wrangler secret put <NAME> --config infra/wrangler/<environment>.json`), never through a `.dev.vars` file. Wrangler reads `infra/wrangler/.dev.vars` only for local `wrangler dev` and `wrangler types`, and `local` needs none of these names, so never write a hosted value into it. `.env`, `.dev.vars` and their variants are git-ignored everywhere in the checkout. `pnpm check` refuses an example that drifts from the catalog or this table; `node scripts/check-env-examples.mjs --write` regenerates both after a reviewed catalog change.

Supply credentials through the operator's external secret manager/session, never shell literals, committed `.env` files, manifest values, logs or plan outputs. Generated role passwords, widget and Access secrets enter OpenTofu state even when marked sensitive. Development and staging keep state in a Cloudflare R2 bucket, described under [OpenTofu state](#opentofu-state); saved plans live only in a temporary directory that is removed after use. Do not reuse production secrets in nonproduction. Rotate through the owning consumer with a reviewed dual-key transition. Subsequent runtime/model/observability composition must consume these names explicitly; declarations do not add undeclared runtime bindings today.

`pnpm infra:plan <environment>` makes a read-only plan of one environment and never applies it. It prints only resource addresses, actions, the planned resource count and a digest of the change set, and fails on a planned deletion (other than of a [retired Neon API role](#database-roles)) or an undeclared resource, as the deploy does.

- `local` and `ci` own no cloud resources. Their plan runs in a new temporary directory with the lock-file-verified providers, no credentials and no backend, with HTTP refused while planning, and fails unless it is empty. Quality's `checks` job runs it for `ci`.
- `development` and `staging` need `CLOUDFLARE_API_TOKEN`, `NEON_API_KEY`, reviewed routing metadata and the environment's [R2 state](#opentofu-state) (`INFRA_STATE_BUCKET`, `INFRA_STATE_ACCESS_KEY_ID`, `INFRA_STATE_SECRET_ACCESS_KEY`) in the shell. Like the deploy, it first refuses a held state lock and state that lost a duplicable resource (see [OpenTofu state](#opentofu-state)). The plan covers the full configuration a completed deploy owns, so an applied environment plans with no pending change. It runs in a new temporary directory, removed afterwards with its saved plans; OpenTofu's own output is withheld. Production planning is disabled, as production deployment is.

`pnpm test:cloud [environment]` (default `staging`) runs `tests/cloud`: the environment plans twice with the same change-set digest and no pending change, and a hosted environment's deployed origin serves the web shell over HTTPS and refuses an unauthenticated runtime request with 401. It needs what `infra:plan` needs. Quality runs it for `ci`; the staging pass needs a staging deploy (issue 2).

The Worker route requires the named Worker to exist before route application; coordinate its dependency order with the later release workstream. OpenTofu creates shared resources; Wrangler later owns Worker publication and Queue consumers. Keep queue names, DLQ targets and names in `_QUEUE_NAME` variables identical. The runtime binds the artifacts and assets buckets (`resources.buckets.artifacts`, `resources.buckets.assets`) as `ARTIFACTS_BUCKET` and `ASSETS_BUCKET` in every Wrangler manifest, as `runtimeBindingManifest.r2Buckets` declares and `pnpm check` verifies; the backups bucket and Hyperdrive remain unbound until the runtime exposes their composition contract. Do not add bindings or deploy from this runbook to bypass that missing prerequisite.

Development may deploy a qualified main commit. Staging requires a protected release candidate and production-shaped qualification. Production requires explicit human approval under the release policy in force. A release pins commit/build digest, toolchain/lockfile, compatibility and migration versions, wire/event schemas, future world/policy versions and infrastructure revision. W0-009 owns release automation; this packet creates no workflows or cloud resources. Preserve canonical history: use compatible rollback or forward fixes rather than deletion. Implemented configuration and local validation do not constitute staging acceptance, full Wave 0 qualification or release approval.

## W0-009 protected deployment and recovery

The repository-scoped variable `REPOSITORY_DEPLOYMENT_ENABLED` must equal the literal `true`
before the credential-free release selector emits any deployment outputs. The reusable
deployment's separate admission job repeats the check before any development/staging
environment-declaring job is admitted; neither admission job declares an environment, so
environment variables cannot supply this opt-in. Both consumers use the repository-bound
`GITHUB_TOKEN` with `actions: read` for an authenticated read-only
[GET of the exact existing environment](https://docs.github.com/en/rest/deployments/environments#get-an-environment).
Staging must return exactly one required-reviewers protection with valid reviewers. Missing,
inaccessible, malformed or unknown environment/protection configuration fails by name without
an admitted target. This prevents the [implicit creation of unprotected environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
The deploy then requires the environment variables `OWNER_SETUP_READY` (issue 1) and
`ACTIVATION_PREREQUISITES_READY` (issue 2) to equal `true`. Production remains disabled.
The release workflow calls the deployment with `secrets: inherit`: a called workflow otherwise
gets no secrets, not even its own environment's, and the deploy step sees them as empty. Only
the provisioning step maps secrets, and only the five declared in
`infra/environments/staging.secrets.json`; the job never references the organization's other secrets.

The release workflow selects an exact successful main-push Quality run and its candidate-bound
artifact. A main push deploys to development only once `infra/environments/development.json`
carries development's own routing metadata; until then the selector names no environment and no
development deploy is queued. Staging is dispatched with the exact candidate and Quality run and
waits on the protected staging environment, whose approval URL names the candidate. Deployments
serialize per environment and are never cancelled to supersede persisted-state mutations.
Pull-request jobs receive no deployment credentials. This workflow creates no environments,
accounts, secrets or state buckets.

### Staging sign-off

The required reviewer's approval of the protected `staging` environment is the only sign-off for a
staging deploy: approving the waiting job approves that exact candidate, a qualified main commit
whose Quality evidence the deploy verifies before it changes anything. There is no separate
independent reviewer, signed review, signed recovery file or acceptance key. Development deploys
the same way, gated by its own environment's protection rules.

Production keeps a stricter design, to be implemented before it is ever enabled: an independent
reviewer's signed review of the exact candidate, verified against an offline Ed25519 acceptance
key; signed recovery evidence for persisted state; and OpenTofu state and plans encrypted with a
managed key, pinned by a configuration digest.

### Runner

The deploy job runs on a GitHub-hosted `ubuntu-26.04` runner, a fresh VM per job that is discarded
afterwards, only after the approval above. It installs Node 24.21.0, the committed pnpm 12.9.1,
OpenTofu 1.13.1 and the PostgreSQL 18.6 client with `scripts/ci/toolchain.sh`, restores no cache,
and reads nothing from the runner's disk but the candidate checkout and its Quality artifact.

### OpenTofu state

Development and staging keep OpenTofu state in a Cloudflare R2 bucket through OpenTofu's
S3-compatible backend, one object per environment at `<environment>/terraform.tfstate`. The
backend's endpoint is `https://<cloudflareAccountId>.r2.cloudflarestorage.com` from the
environment manifest, and a lock object written with R2's conditional writes stops two runs
changing the same state. State carries no OpenTofu encryption: R2 encrypts objects at rest, and
the only credential that reaches the bucket is an R2 API token scoped to it. Nothing uses AWS or a
KMS. The settings come from the protected environment at job start:

| Name | Kind | Value |
| --- | --- | --- |
| `INFRA_STATE_BUCKET` | Environment variable | The R2 bucket's name. |
| `INFRA_STATE_ACCESS_KEY_ID` | Environment secret | The bucket-scoped R2 API token's access key ID. |
| `INFRA_STATE_SECRET_ACCESS_KEY` | Environment secret | The bucket-scoped R2 API token's secret access key. |

The deploy and `infra:plan` copy `infra/` into a new temporary directory, add the generated
backend there and remove the directory when done; saved plans hold generated credentials and
never leave it. The bucket is not an OpenTofu resource, so no plan can change it. R2 keeps no
object versions, so the deploy keeps its own copies: after every successful apply it writes the
state object to `<environment>/backups/<UTC time>-<stage>-<commit>.tfstate` in the same bucket,
never overwriting one. Each backup holds the generated database passwords and the Access service
token secret, so they are bounded: after writing one, the deploy deletes all but the newest 15 of
the environment's backups (five deploys of three stages), never the one it just wrote. A
`restore --replace` saves the replaced object the same way and never deletes the backup it
restores from.

`pnpm infra:state <command> <environment>` is the owner's tool for the bucket. It takes
`development` or `staging`, needs the three settings above in the shell, and prints keys, lock
holders and ages, never state:

| Command | Effect |
| --- | --- |
| `lock <environment>` | Names the held lock's object, holder's user name, operation, age and lock ID, or says the state is not locked. |
| `unlock <environment> <lock ID>` | Deletes the lock object. Refuses unless the ID is the held lock's and the lock is at least 60 minutes old by the owner's clock. It first overwrites the lock it checked with its own record, only if the object is unchanged since the read, then deletes that record, so a lock taken in between is never deleted. |
| `backups <environment>` | Lists the dated backups, oldest first. |
| `restore <environment> <key> [--replace]` | Copies one backup, a file name directly under `<environment>/backups/`, to `<environment>/terraform.tfstate`, holding the state lock meanwhile. Refuses while the state is locked. Refuses when a state object exists unless `--replace` is given; then it first saves that object as a `-replaced` backup and overwrites it only if it is unchanged since the save. |

Lock holders are named by user name only: OpenTofu records `user@hostname`, and deploy logs are
public.

#### Lost state

Most owned resources have unique names, so a create with lost state fails on the existing name.
The Neon project, the Turnstile widget and the Access service token do not: a create would make a
second copy. So before anything is planned, the deploy and `infra:plan` look each of these up by
name with the environment's Cloudflare and Neon credentials when state does not record it, and
refuse by name and ID if one exists. This catches a missing, empty or older state object alike.

To recover, list the backups and restore the newest: `pnpm infra:state backups staging`, then
`pnpm infra:state restore staging <key> --replace`. This works whether the state object is
missing, empty or older; an existing object is kept as the newest backup, so the replace can be
undone the same way. The restored state equals the state after the last successful apply. If
a later deploy failed mid-apply, resources it created are not in that backup: the deploy then
refuses again for a duplicable resource, or fails on the existing name for any other, and each
such resource must be imported with `tofu import` into the bucket's state before deploying. Never
delete a resource to get past the refusal.

#### Held lock

OpenTofu writes `<environment>/terraform.tfstate.tflock` while it plans or applies and deletes it
when done. A run cut off mid-apply, by the job timeout, a runner teardown or the deploy's own kill
after an OpenTofu call overran its limit (see [Deploy phases](#deploy-phases)), leaves it behind,
and every later plan would fail with its output withheld. So the deploy and `infra:plan` read the
lock first and refuse with its holder, operation, age and lock ID; a failed or timed-out OpenTofu
phase also names a lock it leaves. Nothing clears a lock automatically.

A lock is safe to clear only when no deploy is running in Actions and no owner's `infra:plan` or
`test:cloud` against that environment is running. Then the owner clears it with
`pnpm infra:state unlock staging <lock ID>` and dispatches the deploy again. The 60-minute age
check is a backstop, not the proof: it covers the deploy job's 45-minute timeout plus clock skew
and OpenTofu's shutdown, but owner-run plans and cloud tests have no time limit. An
interrupted apply's effect is unknown: the next deploy plans against what state recorded, and
anything the apply created without recording it is handled as under [Lost state](#lost-state).

After a deploy that stopped at an OpenTofu time limit (`stopped: no result within <n> s` in the
log; the phase is `unknown` with reason `timeout` in the evidence, and so is the deployment):

1. If the log says OpenTofu was killed after the grace, the lock is held: the deploy names it.
   This is the expected end when the Neon provider waits on a failed operation, since it ignores
   OpenTofu's stop (see [Deploy phases](#deploy-phases)). Clear it as above once no other run is
   active. `unlock` refuses until the lock is 60 minutes old, so that is the earliest the deploy
   can run again. If the log says OpenTofu exited within the grace, it saved state and released
   the lock; confirm with `pnpm infra:state lock staging`.
2. Find what did not return. For a provision call, open the Neon project's operations (console or
   `GET /projects/<id>/operations`): the Neon provider waits for the latest one to finish and never
   stops when it ends `failed`, `cancelled` or `skipped`, so the next deploy would wait on it again.
   Dispatch again only once a later operation has finished or Neon has resolved the failed one.
3. Dispatch the deploy again. It plans against what state recorded; a timed-out call is never
   retried within a deploy.

A deploy that ran out of its OpenTofu budget (`not started: ... OpenTofu budget` in the log; the
phase is `failed` with reason `budget`) started nothing more and holds no lock: find what made the
earlier calls slow, then dispatch it again.

### Database roles

`clockgrove_migrator` is the only Neon API role (`neon_role.database["migrations"]`), and it owns the
database. After the provision apply, the deploy waits until the Neon project has no operation in
progress, then runs [`deployment-grants.sql`](../../scripts/database/deployment-grants.sql) as
`clockgrove_migrator` in one transaction (phase "reviewed database-role grants"). The SQL:

1. refuses, by name, a restricted role that already exists but is a member of any role (a Neon API
   role is a member of `neon_superuser`) or that `clockgrove_migrator` does not administer;
2. creates each missing role among `clockgrove_runtime`, `clockgrove_support`, `clockgrove_backup`,
   `clockgrove_auth_verifier`, `clockgrove_management_reader`, `clockgrove_world_reader` and
   `clockgrove_mcp_secrets`, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOREPLICATION and
   NOBYPASSRLS. On PostgreSQL 16 and later the creating role administers the roles it creates, so
   every later deploy can alter them;
3. sets LOGIN and each login role's password from `database_credentials` (OpenTofu's
   `random_password.database["<key>"]`, 48 letters and digits), and NOLOGIN with no password for
   `clockgrove_mcp_secrets`. Neon accepts plain-text passwords only, not SCRAM verifiers;
4. refuses, by name, any restricted role left with a role membership or an elevated attribute, then
   revokes `CREATE` on schema `public` and on the database from `PUBLIC`.

The passwords reach `psql` only on standard input, as `\set password_<key>` lines that
[`deployment-roles.mjs`](../../scripts/database/deployment-roles.mjs) prepends after refusing
anything but 32 to 128 letters and digits; never in arguments, the environment, logs or evidence. A
failed check prints as `reviewed database-role grants failed; clockgrove_support is a member of
neon_superuser; other sensitive command output withheld`. Re-running the SQL with the same state
changes nothing but resetting the same passwords. A lost state generates new passwords, which the
next deploy sets.

Before this design the provision stage created all seven roles through the Neon API. Their state
addresses `neon_role.database["<key>"]` for the six restricted keys are now retired
(`retiredResources` in [`deployment-authority.mjs`](../../scripts/ci/deployment-authority.mjs)): the
configuration no longer declares them, so the next provision plan deletes each through the Neon API
(`delete_because_each_key`), which is how Neon's control plane forgets an API role. Plan review
accepts exactly that deletion of exactly those addresses and refuses every other deletion,
replacement or forget. The deploy then waits for Neon's operations and the role SQL creates the six
roles with SQL. An environment provisioned after this change never holds them. If Neon refuses a
deletion (a retired role that owns objects), the provision apply fails with the provider's message:
reassign or drop what it owns and deploy again.

### Deploy phases

Before provisioning, the deploy requires `CLOUDFLARE_API_TOKEN`, `NEON_API_KEY`,
`BETTER_AUTH_SECRET` and the two `INFRA_STATE_*` secrets, each declared in the environment's
`*.secrets.json`, the reviewed routing metadata and the two readiness variables. It then refuses a
held state lock and state that lost a duplicable resource, as [OpenTofu state](#opentofu-state)
describes. The catalog
above remains canonical. `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `AUTH_DATABASE_URL`,
`MANAGEMENT_DATABASE_URL` and `WORLD_AUTHORIZATION_DATABASE_URL` are generated after OpenTofu
provisions the owned Neon project/branch/database and migration role; they are never prerequisites
for first provisioning. Their host, database and role come from the sensitive owned output
`database_credentials`, with the migration role's Neon-generated password and the OpenTofu-generated
(`random_password`) passwords of the others; they
remain in memory and state, and go only to Hyperdrive, the controlled migration connection and the
named runtime verification/reader secret bindings. Authentication uses verified TLS
(`sslmode=verify-full`) direct PostgreSQL transport on the existing owned Neon database; no
additional Hyperdrive, provider, destination or compute budget is introduced. `AUTH_ORIGIN` is the
explicit HTTPS runtime origin and `PROVIDER_ENVIRONMENT` is the canonical manifest environment in
all five Wrangler configurations. Local/CI declare no required secrets and remain refusing until
explicitly composed. Support, backup, model, Turnstile, Access and observability consumers remain
pending unless explicitly composed; declarations alone do not release them.

The deploy hands `NEON_API_KEY` to the Neon provider as `NEON_TOKEN` and the two `INFRA_STATE_*`
secrets to the S3 backend as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, the names they read;
the Cloudflare provider reads `CLOUDFLARE_API_TOKEN` itself. Sensitive outputs and plan contents are
captured in memory and never printed or placed in ordinary artifacts. Only phase names, outcomes and
digests enter deployment evidence. Interrupted apply or publication has an unknown effect and fails
closed; it is never recorded as a successful activation.

Each OpenTofu stage (provision, bindings, routing) plans into a saved plan, reviews it (declared
resources only, no deletion but of a retired resource, the stage's own limits below) and applies
exactly that plan; after a passed apply the state is backed up. The provision stage creates the Neon
project, its database and the migration role, and generates the other roles' passwords. Neon runs one operation per project at a time and answers HTTP 423 (Locked) to
another meanwhile, which its API docs call safe to retry. The Neon provider waits for the project's
latest operation before each create, so provision applies with `-parallelism=1`: each Neon create
then starts after the previous one finished, where parallel ones start together and all but one are
refused. A provision apply that still fails is retried when OpenTofu exited on its own (so it saved
state and released the lock) and every error it reported is at a Neon resource; the provider drops
the HTTP status, so that is the signal rather than 423 itself. It runs at most four times, 15, 30
and 60 seconds apart. Before each retry the deploy refuses a held lock and re-reads state for lost
duplicable resources, as before the first plan, then plans, reviews and applies a new plan; a failed
run's plan is deleted, never applied. A failed create of the Neon project itself is not retried:
Neon may hold the project anyway, and if its name search has not caught up, a retry would make a
second one that state then hides; the per-project lock cannot refuse that create. Any other failed
apply, and any interrupted or timed-out one, stops the deploy at once.

No OpenTofu call can hold the deploy until the job's 45-minute timeout kills it, since that kill
skips the evidence upload and leaves the deploy unexplained. Each call has a wall-clock limit
within a 30-minute budget from the deploy's start. An apply gets 10 minutes and starts only if all
10 fit in what is left of the budget, so no apply starts only to be cut short. Any other call
(init, plan, show, output) gets 5 minutes, cut to what is left, and starts only with at least one
minute left. A call the budget refuses is not started: its phase is `failed` with reason `budget`,
and the deploy stops there and fails.

At its limit OpenTofu gets SIGINT. It asks its providers to stop, waits for their calls in flight
to return, then saves state and releases the lock. A provider that ignores the stop keeps its call
running, and OpenTofu waits with it. The Neon provider 0.1.15 is one: its framework's stop does
nothing, and its wait for a project operation is a loop without a context. So in the case these
limits exist for, a Neon operation that ended `failed`, `cancelled` or `skipped`, OpenTofu does not
exit, its process group is killed 2 minutes later, and the state lock stays held. A call that only
ran long, against a provider that honours the stop, exits within the 2 minutes and leaves no lock.
Either way the phase is `unknown` with reason `timeout`, the deploy stops there and is `unknown`,
and a timed-out provision apply is never retried: the provider may still be waiting on its
operation, which is not the lock the retry is for. Evidence validation accepts reason `timeout`
only on an `unknown` phase with error code `ETIMEDOUT`, and reason `budget` only on a `failed`
phase with no exit code, signal or error code; either must be its deployment's last phase. The
budget plus the grace leaves the job's setup steps and the evidence upload room inside 45 minutes,
and the provision retries' worst case (four runs of state read, plan, review and apply, and 105
seconds of backoff) normally takes minutes. [Held lock](#held-lock) covers what to do after a
timeout.

Every run is recorded with its own state read, plan, review and apply phases; a retry's carry an
`attempt` number from 2. Evidence validation accepts `attempt` only on those four provision phases,
up to four, each retry starting after the previous attempt's apply did not pass and running its
four phases in order. A failed provision apply that a later attempt passed no longer decides the
outcome, since that attempt planned against the state it left: the deploy can still pass, and fails
or is `unknown` only by its other phases. When every attempt fails, the deploy reports the last
attempt's provider diagnostics and is `unknown`.

The resources in state must be ones the configuration declares. A Hyperdrive configuration in state
permits binding preservation only; it never authorizes public activation. Existing DNS and Worker
routing in state is preserved only when Cloudflare's current DNS record and Worker route, read by
their IDs, carry this environment's runtime host, DNS target and Worker; state holding one without
the other fails closed. With completed bindings and incomplete publication, the provision stage
preserves owned bindings without mutation, then applies current role normalization, migrations and
effective-role verification before binding updates and successful qualified Wrangler publication.
Only then may the routing stage introduce DNS or Worker routing. All stages enforce declared
resource bounds and refuse every deletion except a retired resource's (below), and every action
other than create, read, update and no-op, so a plan cannot `forget` an owned resource; previously active public resources must be no-op until
the newly qualified publication. Recovery never destroys resources merely to repeat a phase.

Neon role names or URLs do not prove effective privileges. Beyond the role SQL's own checks, catalog
checks traverse inherited role memberships, forbid runtime/support/backup and verification/reader superuser, bypass, create-role/database authority and
migration inheritance, require forced canonical/Management RLS, read-only support/backup permissions, exact verification/reader
SELECT capabilities, denied cross-plane writes/journal execution/schema creation and migrator ownership. The real runtime connection independently verifies its current identity and absence
of schema-create authority. Missing checks prevent binding activation/publication.

Credential-free infrastructure validation creates a uniquely owned mode-0700 short relative
provider IPC directory within its actual OpenTofu working directory after `-chdir` resolution.
Only anchored OpenTofu/provider operations receive that relative TMPDIR. Private HOME, provider
installation/data storage and Wrangler's default private TMPDIR stay separate; success and
failure remove the IPC directory. Signed pinned providers, readonly lock verification, the sole
public installation network phase and offline schema validation remain unchanged.

No actual CI browser run, hosted deployment, authenticated staging qualification or full Wave 0
exit is established by this source or locally passing commands; issue 2 owns them.

Enrollment/World-participation handoff and hosted configuration remain pending. Authentication
verification and read-only authority schema introduce no signup, invitation, enrollment API,
WorldProvisioningCase or initial grant/privacy policy. Authenticated staging and full Wave 0
qualification require an authorized bounded enrollment/provisioning path with declared grants/privacy,
or the planned provisioning path, before hosted capability claims. Local controlled rows prove readers
only.
