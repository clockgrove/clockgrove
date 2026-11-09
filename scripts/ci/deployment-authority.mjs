import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { cp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertNoSecretValues } from "../check-secrets.mjs";
import { digest, root } from "./evidence.mjs";

export const reviewScope = [
  "credential exposure",
  "protected approval/candidate binding",
  "encrypted persisted state and recovery",
  "effective database-role isolation",
  "provisioning/activation ownership",
  "provider-neutral identity",
  "Management/World ownership",
  "effective least privilege/RLS",
  "request cleanup",
  "coherent provisioning consumers",
];

// The key and its digest are appointed through protected operator configuration.
// Local tests and source-controlled statements cannot appoint a reviewer.
export async function authenticatedFact(file, keyFile, keyDigest) {
  const key = await readFile(keyFile);
  assert(digest(key) === keyDigest, "operator acceptance public key mismatch");
  const envelope = JSON.parse(await readFile(file, "utf8"));
  const bytes = Buffer.from(envelope.payload, "base64");
  assert(
    verify(null, bytes, key, Buffer.from(envelope.signature, "base64")),
    "external acceptance signature invalid",
  );
  return JSON.parse(bytes.toString("utf8"));
}

// An owner-approved location named by a protected variable: absolute and outside the checkout.
export async function externalPath(env, name) {
  const value = env[name];
  assert(value?.trim(), `missing ${name}`);
  assert(path.isAbsolute(value), `${name} must be an absolute owner-approved external path`);
  const resolved = await realpath(value);
  assert(resolved !== root && !resolved.startsWith(`${root}/`), `${name} must be outside checkout`);
  return resolved;
}

// The zero account/zone IDs and example.org domains are publication-safe placeholders.
export function assertRoutingMetadata(config, target) {
  for (const [name, value] of Object.entries(config.safeIds))
    assert(!/^0+$/u.test(value), `missing routing metadata ${target}.${name}`);
  for (const [name, value] of Object.entries(config.domains))
    assert(!/(?:^|\.)example\.org$/u.test(value), `missing routing metadata ${target}.${name}`);
}

// The owner-approved external state configuration: INFRA_CONFIGURATION_DIGEST pins the backend
// file's bytes followed by the encryption file's bytes. Both name the target environment, the
// backend is not local, and state and plans are AES-GCM encrypted with no plaintext fallback.
export async function externalStateConfiguration(target, backendFile, encryptionFile, pinned) {
  const backendBytes = await readFile(backendFile);
  const encryptionBytes = await readFile(encryptionFile);
  assert.equal(
    configurationDigest(backendBytes, encryptionBytes),
    pinned,
    "owner-approved encrypted external-state configuration mismatch",
  );
  const backend = JSON.parse(backendBytes);
  const encryption = JSON.parse(encryptionBytes);
  assertNoSecretValues(backendBytes.toString(), "external backend configuration");
  assertNoSecretValues(encryptionBytes.toString(), "external encryption configuration");
  assert.equal(backend.environment, target, "external backend environment isolation mismatch");
  assert.equal(
    encryption.environment,
    target,
    "external encryption environment isolation mismatch",
  );
  assert(
    backend.terraform?.backend && Object.keys(backend.terraform.backend).length === 1,
    "missing owner-approved external backend destination",
  );
  assert(!backend.terraform.backend.local, "external persisted-state backend required");
  const crypt = encryption.terraform?.encryption;
  assert(
    crypt?.key_provider && crypt?.method?.aes_gcm,
    "missing owner-approved external encryption key provider and AES-GCM method",
  );
  assert(
    Object.keys(crypt.key_provider).every((name) =>
      ["aws_kms", "gcp_kms", "azure_key_vault", "openbao"].includes(name),
    ),
    "external encryption must use owner-managed key identity; no new static credential catalog entry",
  );
  assert.equal(Object.keys(crypt.method).length, 1, "unencrypted encryption methods forbidden");
  for (const name of ["state", "plan"]) {
    assert.equal(crypt[name]?.enforced, true, `${name} encryption must be enforced`);
    assert(
      !crypt[name].fallback &&
        typeof crypt[name].method === "string" &&
        crypt[name].method.includes("method.aes_gcm."),
      `${name} encryption method required without plaintext fallback`,
    );
  }
  return { backend, encryption };
}

export const configurationDigest = (backendBytes, encryptionBytes) =>
  digest(Buffer.concat([backendBytes, encryptionBytes]));

// An OpenTofu working directory outside the checkout, wired to the external backend and encryption.
export async function prepareStateWorkspace(work, backend, encryption) {
  await cp(path.join(root, "infra/opentofu"), work, { recursive: true });
  await cp(path.join(root, "infra/environments"), path.join(work, "environments"), {
    recursive: true,
  });
  // Keep the original manifest path semantics when running outside checkout.
  const source = (await readFile(path.join(work, "main.tf"), "utf8")).replace(
    "/../environments/",
    "/environments/",
  );
  await writeFile(path.join(work, "main.tf"), source);
  await writeFile(
    path.join(work, "external-backend.tf.json"),
    JSON.stringify({ terraform: backend.terraform }),
  );
  await writeFile(
    path.join(work, "external-encryption.tf.json"),
    JSON.stringify({ terraform: encryption.terraform }),
  );
}

// The provider credentials OpenTofu reads: the Cloudflare provider reads CLOUDFLARE_API_TOKEN
// itself, and the Neon provider reads NEON_TOKEN, which carries the declared NEON_API_KEY.
export const hostedTofuEnv = (env, ipc, work) => ({
  ...env,
  TMPDIR: ipc,
  TF_DATA_DIR: path.join(work, ".terraform"),
  TF_ENCRYPTION: "",
  NEON_TOKEN: env.NEON_API_KEY,
});

export function verifyReview(fact, candidate, tree, reviewer) {
  assert(fact.outcome !== "refused", "independent review refused candidate");
  assert(fact.outcome === "passed", "independent review remains needs-human");
  assert(fact.commit === candidate && fact.tree === tree, "independent review candidate mismatch");
  assert(
    fact.reviewer === reviewer && fact.evidence && fact.independent === true,
    "operator-appointed independent reviewer evidence missing",
  );
  assert(
    reviewScope.every((scope) => fact.scope?.includes(scope)),
    "independent review scope missing",
  );
}

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

export async function cloudflareFact(_config, token, suffix) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${suffix}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, "authenticated Cloudflare activation facts unavailable");
  const body = await response.json();
  assert(body.success, "authenticated Cloudflare activation facts refused");
  return body.result;
}

export async function verifyPriorActivation(config, token, inventory, activation) {
  const route = inventory.find(
    (resource) => resource.address === "cloudflare_workers_route.runtime[0]",
  );
  const dns = inventory.find((resource) => resource.address === "cloudflare_dns_record.runtime[0]");
  if (!route && !dns) {
    assert(!activation, "activation evidence contradicts owned state");
    return false;
  }
  assert(
    route && dns && activation?.workerVersionId,
    "public routing effects unknown; authenticated activation evidence required",
  );
  assert(
    activation.routeId === route.id && activation.dnsId === dns.id,
    "activation resource identity mismatch",
  );
  const prefix = `zones/${config.safeIds.cloudflareZoneId}`;
  const actualRoute = await cloudflareFact(config, token, `${prefix}/workers/routes/${route.id}`);
  const actualDns = await cloudflareFact(config, token, `${prefix}/dns_records/${dns.id}`);
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
  const versions = await cloudflareFact(
    config,
    token,
    `accounts/${config.safeIds.cloudflareAccountId}/workers/scripts/${config.resources.worker}/deployments`,
  );
  assert(
    versions.deployments?.[0]?.versions?.length === 1 &&
      versions.deployments[0].versions[0].version_id === activation.workerVersionId &&
      versions.deployments[0].versions[0].percentage === 100,
    "authenticated Worker activation version mismatch",
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
