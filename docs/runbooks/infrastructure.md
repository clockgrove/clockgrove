# Infrastructure and environments

W0-008 defines configuration only. Start with the [documentation index](../clockgrove-documentation-index.md), [development reference](development.md), [Wave 0 environment and release contracts](../waves/clockgrove-wave-0-project-foundation-implementation-plan.md#16-environment-and-infrastructure-contract), and [architecture §22](../raccoon-world-cloudflare-implementation-plan.md#22-infrastructure-architecture).

Use Node 24.21.0, pnpm 12.9.1, OpenTofu **1.13.1** on PATH and the lockfile-pinned Wrangler **4.147.0**. All five canonical Wrangler configurations enable `nodejs_compat`, required by the runtime's `pg` 8.23.1 driver, and the infrastructure check enforces it. Hyperdrive owns one connection per operation with rollback/close cleanup; Better Auth uses Kysely's built-in `PostgresDialect` and a separate request-owned pg pool limited to one connection and destroyed in `finally`. Both adapters own asynchronous driver errors and retain failures through cleanup before returning a result. Local PostgreSQL 18.6/pgvector 0.8.7 verification retains the isolated abstract socket using pg's declared stream configuration and a real Node socket; ordinary Hyperdrive URLs keep default transport. Infrastructure is outside the workspace; it adds no runtime dependencies. `pnpm run infra:validate` type-checks the strict Zod schema, runs the infrastructure tests, installs pinned Cloudflare 5.27.0 and Neon 0.1.15 providers into a new temporary directory, runs backend-free OpenTofu formatting/validation, and bundles all five Wrangler configurations with `--dry-run`. Providers come from the mirror that `scripts/ci/toolchain.sh opentofu-providers` fills beside the `tofu` on PATH when it holds every locked version, offline; otherwise directly from the public OpenTofu registry and its public release/signature URLs. Either way `tofu init -lockfile=readonly` refuses any package whose hash the committed lock file lacks, so the mirror cannot substitute a provider. It uses no other mirror, provider cache, user CLI configuration or credentials, and removes its temporary storage. Validation after installation needs no cloud API access. No plan, refresh, apply or deployment is part of validation. `pnpm check` also checks all manifests and scans HEAD, every indexed and non-ignored working repository path for secret-shaped values; it has no fixture or binary-path exemptions.

The exact deployment authority is [`runtimeBindingManifest`](../../apps/runtime/src/cloudflare-entry.ts): three SQLite Durable Objects, seven Workflows, three queue producers/consumers and their distinct physical queue-name variables. Wrangler owns these, the `ARTIFACTS_BUCKET` and `ASSETS_BUCKET` R2 bindings, the `METRICS` Workers Analytics Engine dataset binding (created on first write; the Cloudflare OpenTofu provider has no dataset resource) and cron/Worker observability. OpenTofu owns three queues plus three dead-letter queues, three R2 buckets, Hyperdrive, authenticated AI Gateway with spend/rate limits, Turnstile, an operations service token, DNS/Worker route, public WAF/rate-limit policies and Neon project/branch/database/roles. R2 expiration applies only to `ephemeral/`; canonical artifacts and backups are never expired by this rule. PostgreSQL grants, schema, pgvector and reviewed migrations stay with the [database workstream](database.md#migration-ownership-and-roles). Database-local roles preserve the existing SQL names `clockgrove_migrator` and `clockgrove_runtime`, plus `clockgrove_support`, `clockgrove_backup`, `clockgrove_auth_verifier`, `clockgrove_management_reader` and `clockgrove_world_reader`; project/branch/database isolation separates environments. Neon role creation does not itself prove least privilege: apply the reviewed grants, revoke any provider-default elevated membership and verify runtime/support/backup isolation before activating Hyperdrive or exposing a Worker. Fresh isolates now compose real verification and durable readers without an initializer. Missing/invalid authentication configuration fails closed; composition does not establish enrollment or activation readiness.

| Environment | Infrastructure operation |
| --- | --- |
| `local` | Local Wrangler, isolated local PostgreSQL/pgvector and fixture models; zero cloud resources and no required secrets. |
| `ci` | Local Wrangler, ephemeral isolated PostgreSQL and fixture models; zero cloud resources and no required secrets. |
| `development` | Dedicated `rw-development-*` cloud resources, Neon project and branch; qualified main integration. |
| `staging` | Dedicated `rw-staging-*` resources/project/branch and sanitized data; protected release candidate qualification. |
| `production` | Dedicated `rw-production-*` resources/project/branch; protected credentials and explicit human approval. |

Each `infra/environments/<environment>.json` permits only resource names, domains, documented-safe Cloudflare account/zone IDs, retention, budgets, compatibility date and model aliases. Resource names include the public provider region name and canonical database-local role names. Objects reject unknown fields at every level. Zero account/zone IDs and `example.org` domains are publication-safe placeholders; replace them with reviewed non-secret routing metadata for your installation before planning a hosted environment. Use separate account/zone ownership for isolated staging and production; avoid combining zone-wide entrypoint rulesets with unrelated applications. Resources use the full canonical environment name. Local/CI cloud resource counts are zero even when a plan is requested; ordinary local use needs no cloud credentials or OpenTofu plan.

Secret names and consumers are declared in `infra/environments/<environment>.secrets.json`. Local/CI declare none. Each hosted environment declares:

| Name | Consumer / source |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | OpenTofu Cloudflare provider; narrowly scoped operator credential. |
| `NEON_API_KEY` | OpenTofu Neon provider; isolated operator credential. |
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

Supply credentials through the operator's external secret manager/session, never shell literals, committed `.env` files, manifest values, logs or plan outputs. Generated role passwords, widget and Access secrets can enter OpenTofu state even when marked sensitive. Keep state and saved plans outside the checkout with encryption, access control and environment isolation. No backend is prescribed here; select the approved protected backend before real operations. Do not reuse production secrets in nonproduction. Rotate through the owning consumer with a reviewed dual-key transition. Subsequent runtime/model/observability composition must consume these names explicitly; declarations do not add undeclared runtime bindings today.

After credentials and approved account/domain metadata exist, an authorized operator can plan any canonical environment with the following sequence. Replace the environment with `local`, `ci`, `development`, `staging` or `production`. Choose a separate externally protected state directory for each. No command below was applied as part of W0-008.

```bash
ENVIRONMENT=development
# INFRA_STATE_DIR must be an existing protected absolute directory outside this checkout.
tofu -chdir=infra/opentofu init -backend=false -input=false -lockfile=readonly
tofu -chdir=infra/opentofu plan -input=false -var="environment=$ENVIRONMENT" \
  -state="$INFRA_STATE_DIR/$ENVIRONMENT.tfstate" \
  -out="$INFRA_STATE_DIR/$ENVIRONMENT.tfplan"
# Review the saved plan, identities, grants, policies and destructive changes first.
# Apply only with that environment's release authorization:
tofu -chdir=infra/opentofu apply -input=false \
  -state="$INFRA_STATE_DIR/$ENVIRONMENT.tfstate" \
  "$INFRA_STATE_DIR/$ENVIRONMENT.tfplan"
```

The Worker route requires the named Worker to exist before route application; coordinate its dependency order with the later release workstream. OpenTofu creates shared resources; Wrangler later owns Worker publication and Queue consumers. Keep queue names, DLQ targets and names in `_QUEUE_NAME` variables identical. The runtime binds the artifacts and assets buckets (`resources.buckets.artifacts`, `resources.buckets.assets`) as `ARTIFACTS_BUCKET` and `ASSETS_BUCKET` in every Wrangler manifest, as `runtimeBindingManifest.r2Buckets` declares and `pnpm check` verifies; the backups bucket and Hyperdrive remain unbound until the runtime exposes their composition contract. Do not add bindings or deploy from this runbook to bypass that missing prerequisite.

Development may deploy a qualified main commit. Staging requires a protected release candidate and production-shaped qualification. Production requires explicit human approval under the release policy in force. A release pins commit/build digest, toolchain/lockfile, compatibility and migration versions, wire/event schemas, future world/policy versions and infrastructure revision. W0-009 owns release automation; this packet creates no workflows or cloud resources. Preserve canonical history: use compatible rollback or forward fixes rather than deletion. Implemented configuration and local validation do not constitute staging acceptance, full Wave 0 qualification or release approval.

## W0-009 protected deployment and recovery

Owner activation remains pending. The repository-scoped variable
`REPOSITORY_DEPLOYMENT_ENABLED` must equal the literal `true` before the credential-free
release selector emits any deployment outputs. The reusable deployment's separate admission
job repeats the check before any development/staging environment-declaring job is admitted;
neither admission job declares an environment, so environment variables cannot supply this
opt-in. Both consumers use the repository-bound `GITHUB_TOKEN` with `actions: read` for an
authenticated read-only [GET of the exact existing environment](https://docs.github.com/en/rest/deployments/environments#get-an-environment).
Staging must return an actual required-reviewers protection with valid reviewers. Missing,
inaccessible, malformed or unknown environment/protection configuration fails by name without
an admitted target. This prevents the [implicit creation of unprotected environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
The later environment-scoped `OWNER_SETUP_READY` guard remains required. No flag is enabled
by this implementation; production remains disabled.

The release workflow selects an exact successful main-push Quality run and its candidate-bound
artifact. Development is automatic for that qualified main candidate; staging is dispatched
with the exact candidate and Quality run and waits on the protected staging environment.
The protected job's approval URL names the candidate. Production remains defined and disabled.
Deployments serialize per environment and are never cancelled to supersede persisted-state
mutations. Pull-request jobs receive no deployment credentials. The owner must configure
required environment reviewers and the isolated disposable release runner before activation.
This implementation does not create environments, accounts, secrets, backend destinations,
review appointments or hosted resources.

Before provisioning, the enabled consumers require only `CLOUDFLARE_API_TOKEN`, `NEON_API_KEY`
and `BETTER_AUTH_SECRET`, the approved routing metadata, owner setup/activation prerequisites,
and approved external backend, encryption and recovery authority. The fifteen-name catalog
above remains canonical. `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `AUTH_DATABASE_URL`, `MANAGEMENT_DATABASE_URL`
and `WORLD_AUTHORIZATION_DATABASE_URL` are generated after
OpenTofu provisions the owned Neon project/branch/database/roles; they are never prerequisites
for first provisioning. Their host, database, role and generated password come from sensitive
owned outputs, remain in memory and approved encrypted state, and go only to Hyperdrive,
the controlled migration connection and the named runtime verification/reader secret bindings.
Authentication uses verified TLS (`sslmode=verify-full`) direct PostgreSQL transport on the existing owned Neon database; no additional
Hyperdrive, provider, destination or compute budget is introduced. `AUTH_ORIGIN` is the explicit HTTPS
runtime origin and `PROVIDER_ENVIRONMENT` is the canonical manifest environment in all five Wrangler
configurations. Local/CI declare no required secrets and remain refusing until explicitly composed. No secret-writer permission or additional destination
is granted. Support, backup, model, Turnstile, Access and observability consumers remain pending
unless explicitly composed; declarations alone do not release them.

The runner requires protected metadata naming `INFRA_STATE_DIRECTORY`,
`INFRA_BACKEND_CONFIG_FILE`, `INFRA_ENCRYPTION_CONFIG_FILE`, `INFRA_CONFIGURATION_DIGEST` and
`INFRA_RECOVERY_EVIDENCE_FILE`. These are owner-approved absolute external locations; no backend
or state destination is inferred. Configuration must enforce AES-GCM encryption for state and
plans without plaintext fallback, use the approved managed-key identity, and match the protected
configuration digest. Saved encrypted plans remain external for recovery. Decrypted outputs
and plan contents are captured in memory and never printed or placed in ordinary artifacts.
Only phase names, outcomes and digests enter deployment evidence. Interrupted apply or publication
has an unknown effect and fails closed; it is never recorded as a successful activation.

External acceptance facts use an operator-appointed Ed25519 public key at
`OWNER_ACCEPTANCE_PUBLIC_KEY_FILE`, pinned by `OWNER_ACCEPTANCE_PUBLIC_KEY_DIGEST` in protected
metadata. An envelope contains base64 `payload` bytes and a base64 `signature` over those exact
bytes. The operator verifies reviewer appointment, independence and cited external evidence
before supplying the signed fact; worker-authored files or self-appointed keys are unacceptable.
`INDEPENDENT_REVIEW_EVIDENCE_FILE` must name that external envelope and `INDEPENDENT_REVIEWER`
must name the appointed reviewer. The reviewed payload includes the exact `commit`, `tree`,
`reviewer`, `independent: true`, external `evidence`, `outcome: passed` and the retained scope strings:
credential exposure; protected approval/candidate binding; encrypted persisted state and recovery;
effective database-role isolation; provisioning/activation ownership. Authentication changes additionally require provider-neutral identity;
Management/World ownership; effective least privilege/RLS; request cleanup; coherent provisioning
consumers. Together these cover every changed credential/authority/schema boundary. Missing or HOLD facts
remain needs-human with the operator decision pending; a refused review forbids delivery.
Signing is a transport for operator-verified external facts, not a substitute for that review.

The signed recovery payload binds `environment`, `configurationDigest`, `operator`, `evidence`,
`statePresent`, `restoredStateDigest` and sorted `ownedResources` (exact addresses and IDs) to the
approved backend. Existing resources require `ownershipVerified` and `stateImportVerified` plus
an exact current restored state digest. An owner must verify ownership and import already
provisioned resources into the approved encrypted state before reuse; the runner creates no
manual duplicates or placeholder connections. Fresh provisioning instead requires an empty
owned inventory, null restored digest and `emptyEnvironmentVerified: true`. Recovery evidence
must be renewed when persisted state changes; interrupted or unknown ownership is refused.

A retained Hyperdrive resource permits binding preservation only. It never authorizes public
activation. Existing DNS/Worker routing can be preserved only with signed activation facts
(`routeId`, `dnsId`, `workerVersionId`) independently authenticated against current Cloudflare
DNS, route and fully active Worker deployment records. Partial or conflicting public effects
fail closed. With completed bindings and incomplete publication, the provision stage preserves
owned bindings without mutation, then applies current role normalization, migrations and
effective-role verification before binding updates and successful qualified Wrangler publication.
Only then may the routing stage introduce DNS or Worker routing. All stages enforce declared
resource bounds and refuse every deletion; previously active public resources must be no-op
until the newly qualified publication. Recovery never destroys resources merely to repeat a phase.

Neon role names or URLs do not prove effective privileges. The controlled migration connection
normalizes provider-default memberships and grants; catalog checks traverse inherited role
memberships, forbid runtime/support/backup and verification/reader superuser, bypass, create-role/database authority and
migration inheritance, require forced canonical/Management RLS, read-only support/backup permissions, exact verification/reader
SELECT capabilities, denied cross-plane writes/journal execution/schema creation and migrator ownership. The real runtime connection independently verifies its current identity and absence
of schema-create authority. Missing checks prevent binding activation/publication.

Credential-free infrastructure validation creates a uniquely owned mode-0700 short relative
provider IPC directory within its actual OpenTofu working directory after `-chdir` resolution.
Only anchored OpenTofu/provider operations receive that relative TMPDIR. Private HOME, provider
installation/data storage and Wrangler's default private TMPDIR stay separate; success and
failure remove the IPC directory. Signed pinned providers, readonly lock verification, the sole
public installation network phase and offline schema validation remain unchanged.

No independent focused review, actual CI browser run, hosted deployment, authenticated staging
qualification or full Wave 0 exit is established by this source or locally passing commands.
Those external acceptance facts and owner setup remain pending.

Enrollment/World-participation handoff and hosted configuration remain pending. Authentication
verification and read-only authority schema introduce no signup, invitation, enrollment API,
WorldProvisioningCase or initial grant/privacy policy. Authenticated staging and full Wave 0
qualification require an authorized bounded enrollment/provisioning path with declared grants/privacy,
or the planned provisioning path, before hosted capability claims. Local controlled rows prove readers
only. Integration requires the operator-appointed exact-candidate independent review; final Objective
review verifies final commands and fresh protected Quality/browser/artifact evidence.
