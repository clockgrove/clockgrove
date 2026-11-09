import assert from "node:assert/strict";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root } from "./evidence.mjs";

// The state backend's settings, read from the protected environment at job start: the bucket is
// the environment variable INFRA_STATE_BUCKET, and its bucket-scoped R2 credentials are the
// environment secrets INFRA_STATE_ACCESS_KEY_ID and INFRA_STATE_SECRET_ACCESS_KEY.
export const stateSecrets = ["INFRA_STATE_ACCESS_KEY_ID", "INFRA_STATE_SECRET_ACCESS_KEY"];

// OpenTofu state in a Cloudflare R2 bucket through the S3-compatible backend, one object per
// environment, locked with a conditional-write lock object. R2 encrypts objects at rest; state
// carries no OpenTofu encryption. Credentials stay out of the file: the backend reads them from
// hostedTofuEnv.
export function stateBackend(target, config, bucket) {
  assert(
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket ?? ""),
    "INFRA_STATE_BUCKET must name an R2 bucket",
  );
  return {
    terraform: {
      backend: {
        s3: {
          bucket,
          key: `${target}/terraform.tfstate`,
          region: "auto",
          endpoints: {
            s3: `https://${config.safeIds.cloudflareAccountId}.r2.cloudflarestorage.com`,
          },
          use_path_style: true,
          use_lockfile: true,
          skip_credentials_validation: true,
          skip_metadata_api_check: true,
          skip_region_validation: true,
          skip_requesting_account_id: true,
          skip_s3_checksum: true,
        },
      },
    },
  };
}

// A new temporary copy of infra/ wired to the environment's R2 state. Saved plans hold sensitive
// values, so callers remove the whole directory when done. Returns it and its OpenTofu directory.
export async function stateWorkspace(target, config, env) {
  for (const name of stateSecrets) assert(env[name]?.trim(), `missing ${name}`);
  const backend = stateBackend(target, config, env.INFRA_STATE_BUCKET);
  const temporary = await mkdtemp(path.join(os.tmpdir(), `clockgrove-${target}-`));
  await cp(path.join(root, "infra"), path.join(temporary, "infra"), {
    recursive: true,
    filter: (source) =>
      ![".terraform", "node_modules"].includes(path.basename(source)) &&
      !/\.tfstate|\.tfplan/u.test(source),
  });
  const work = path.join(temporary, "infra/opentofu");
  await writeFile(path.join(work, "backend.tf.json"), JSON.stringify(backend));
  return { temporary, work };
}

// The credentials OpenTofu reads: the Cloudflare provider reads CLOUDFLARE_API_TOKEN itself, the
// Neon provider reads NEON_TOKEN, which carries NEON_API_KEY, and the S3 backend reads the R2 state
// credentials under its AWS_* names. TF_ENCRYPTION is cleared: state is not OpenTofu-encrypted.
export const hostedTofuEnv = (env, ipc, work) => ({
  ...env,
  TMPDIR: ipc,
  TF_DATA_DIR: path.join(work, ".terraform"),
  TF_ENCRYPTION: "",
  NEON_TOKEN: env.NEON_API_KEY,
  AWS_ACCESS_KEY_ID: env.INFRA_STATE_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: env.INFRA_STATE_SECRET_ACCESS_KEY,
});

export function ownedInventory(state) {
  const resources = [];
  function walk(module) {
    for (const resource of module?.resources ?? []) {
      assert(resource.mode === "managed", "unexpected state resource mode");
      resources.push({ address: resource.address, id: resource.values.id });
    }
    for (const child of module?.child_modules ?? []) walk(child);
  }
  walk(state.values?.root_module);
  return resources.sort((a, b) => a.address.localeCompare(b.address));
}

export function resourceAddresses(config) {
  return new Set([
    ...Object.keys(config.resources.queues).flatMap((key) => [
      `cloudflare_queue.runtime["${key}"]`,
      `cloudflare_queue.runtime["${key}-dlq"]`,
    ]),
    ...Object.keys(config.resources.buckets).flatMap((key) => [
      `cloudflare_r2_bucket.artifacts["${key}"]`,
      `cloudflare_r2_bucket_lifecycle.retention["${key}"]`,
    ]),
    ...Object.keys(config.resources.database.roles).map((key) => `neon_role.database["${key}"]`),
    "neon_project.world[0]",
    "neon_database.world[0]",
    "cloudflare_hyperdrive_config.world[0]",
    "cloudflare_ai_gateway.models[0]",
    "cloudflare_turnstile_widget.public[0]",
    "cloudflare_zero_trust_access_service_token.operations[0]",
    "cloudflare_dns_record.runtime[0]",
    "cloudflare_workers_route.runtime[0]",
    "cloudflare_ruleset.rate_limit[0]",
    "cloudflare_ruleset.waf[0]",
  ]);
}

export function verifyPlan(plan, config, stage, preservePublic) {
  const allowed = resourceAddresses(config);
  const changes = plan.resource_changes ?? [];
  assert(changes.length <= allowed.size, "infrastructure resource bound exceeded");
  for (const change of changes) {
    assert(allowed.has(change.address), "undeclared infrastructure resource");
    assert(!change.change.actions.includes("delete"), "destructive infrastructure plan refused");
    if (stage === "provision" && change.address === "cloudflare_hyperdrive_config.world[0]") {
      assert(
        change.change.actions.every((action) => action === "no-op"),
        "binding mutation before current database isolation checks refused",
      );
    }
    if (
      stage !== "routing" &&
      /^(?:cloudflare_dns_record|cloudflare_workers_route)\./u.test(change.address)
    ) {
      assert(
        preservePublic && change.change.actions.every((action) => action === "no-op"),
        "public activation before qualified Worker publication refused",
      );
    }
  }
}

export async function cloudflareFact(token, suffix) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${suffix}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, "authenticated Cloudflare activation facts unavailable");
  const body = await response.json();
  assert(body.success, "authenticated Cloudflare activation facts refused");
  return body.result;
}

// Public routing in state is preserved only when Cloudflare's current route and DNS record are the
// ones state names, with this environment's identity. State holding only one of them is refused.
export async function verifyPriorActivation(config, token, inventory) {
  const route = inventory.find(
    (resource) => resource.address === "cloudflare_workers_route.runtime[0]",
  );
  const dns = inventory.find((resource) => resource.address === "cloudflare_dns_record.runtime[0]");
  if (!route && !dns) return false;
  assert(route && dns, "partial public routing in state refused");
  const prefix = `zones/${config.safeIds.cloudflareZoneId}`;
  const actualRoute = await cloudflareFact(token, `${prefix}/workers/routes/${route.id}`);
  const actualDns = await cloudflareFact(token, `${prefix}/dns_records/${dns.id}`);
  assert(
    actualRoute.script === config.resources.worker &&
      actualRoute.pattern === `${config.domains.runtime}/*`,
    "authenticated Worker routing identity mismatch",
  );
  assert(
    actualDns.name === config.domains.runtime &&
      actualDns.type === "CNAME" &&
      actualDns.content === config.domains.dnsTarget &&
      actualDns.proxied === true,
    "authenticated DNS identity mismatch",
  );
  return true;
}

export function roleConnections(credentials, config) {
  assert(
    credentials?.project_id &&
      credentials.branch_id &&
      credentials.host &&
      credentials.database === config.resources.database.database,
    "owned database identity missing",
  );
  assert.deepEqual(
    credentials.authentication,
    config.authentication,
    "generated authentication configuration mismatch",
  );
  assert.equal(
    config.authentication.transport,
    "direct-postgresql",
    "unsupported authentication transport",
  );
  const connections = {};
  for (const [key, canonical] of [
    ["runtime", "DATABASE_URL"],
    ["migrations", "MIGRATION_DATABASE_URL"],
    ["authentication", "AUTH_DATABASE_URL"],
    ["management", "MANAGEMENT_DATABASE_URL"],
    ["worldAuthorization", "WORLD_AUTHORIZATION_DATABASE_URL"],
  ]) {
    const role = credentials.roles?.[key];
    assert(
      role?.name === config.resources.database.roles[key] && role.password,
      `missing generated ${canonical} role credential`,
    );
    const url = new URL(`postgresql://${credentials.host}:5432`);
    url.username = role.name;
    url.password = role.password;
    url.pathname = `/${credentials.database}`;
    url.searchParams.set("sslmode", "verify-full");
    connections[canonical] = url.toString();
  }
  return connections;
}
