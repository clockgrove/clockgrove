import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { environmentSchema, environments, secretSchema } from "./environment-schema.ts";

export async function readJson(root, relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

// Parse only literal data; never evaluate or import the native Cloudflare module.
export function deploymentSurface(source) {
  const file = ts.createSourceFile("cloudflare-entry.ts", source, ts.ScriptTarget.Latest, true);
  function literal(node) {
    if (ts.isAsExpression(node)) return literal(node.expression);
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
    if (ts.isObjectLiteralExpression(node))
      return Object.fromEntries(
        node.properties.map((property) => {
          assert(ts.isPropertyAssignment(property), "deployment manifest must be literal data");
          return [property.name.getText(file).replaceAll('"', ""), literal(property.initializer)];
        }),
      );
    throw new Error("deployment manifest must be literal data");
  }
  const exports = new Set();
  let manifest;
  for (const statement of file.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) exports.add(element.name.text);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (declaration.name.getText(file) === "runtimeBindingManifest")
          manifest = literal(declaration.initializer);
  }
  assert(manifest, "runtime deployment manifest missing");
  return { manifest, exports };
}

export function verifyWrangler(config, manifest, surface, root, configPath) {
  assert.equal(
    path.resolve(root, path.dirname(configPath), config.main),
    path.join(root, "apps/runtime/src/cloudflare-entry.ts"),
  );
  assert.equal(config.name, manifest.resources.worker);
  assert.equal(config.compatibility_date, manifest.compatibilityDate);
  assert.deepEqual(config.compatibility_flags, ["nodejs_compat"]);
  const pairs = (items, key) => {
    assert.equal(new Set(items.map((item) => item[key])).size, items.length, "duplicate binding");
    return Object.fromEntries(items.map((item) => [item[key], item.class_name]));
  };
  const localObjects = manifest.environment === "local" ? surface.manifest.localDurableObjects : {};
  assert.deepEqual(pairs(config.durable_objects.bindings, "name"), {
    ...surface.manifest.durableObjects,
    ...localObjects,
  });
  assert.deepEqual(pairs(config.workflows, "binding"), surface.manifest.workflows);
  const classes = Object.values(surface.manifest.durableObjects);
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: classes },
    ...(Object.keys(localObjects).length > 0
      ? [{ tag: "v2", new_sqlite_classes: Object.values(localObjects) }]
      : []),
  ]);
  for (const name of [...classes, ...Object.values(localObjects), ...Object.values(surface.manifest.workflows)])
    assert(surface.exports.has(name), `${name} must be exported`);
  assert.equal(new Set(config.workflows.map(({ name }) => name)).size, config.workflows.length);
  assert.deepEqual(Object.keys(config.vars).sort(), [...surface.manifest.variables].sort());
  assert.deepEqual(
    config.queues.producers.map(({ binding }) => binding).sort(),
    [...surface.manifest.queues].sort(),
  );
  assert.deepEqual(
    config.analytics_engine_datasets,
    surface.manifest.analyticsEngine.map((binding) => ({
      binding,
      dataset: manifest.resources.analytics,
    })),
  );
  // Each R2 binding names the bucket its environment declares (and OpenTofu creates) for its key.
  assert.deepEqual(
    config.r2_buckets,
    Object.entries(surface.manifest.r2Buckets).map(([binding, bucket]) => {
      assert(bucket in manifest.resources.buckets, `${binding} names an undeclared bucket`);
      return { binding, bucket_name: manifest.resources.buckets[bucket] };
    }),
    "R2 bindings must name the environment's declared buckets",
  );
  // `scheduled` dispatches on the cron expression, so each trigger must be one the entry names.
  assert.deepEqual(
    config.triggers.crons,
    Object.values(surface.manifest.crons),
    "Cron Triggers must match the runtime entry",
  );
  assert.equal(config.vars.AUTH_ORIGIN, manifest.authentication.origin);
  assert.equal(config.vars.PROVIDER_ENVIRONMENT, manifest.authentication.providerEnvironment);
  const queues = Object.values(manifest.resources.queues);
  assert.equal(new Set(config.queues.producers.map(({ queue }) => queue)).size, queues.length);
  assert.equal(config.queues.consumers.length, queues.length);
  for (const [index, binding] of surface.manifest.queues.entries()) {
    const producer = config.queues.producers.find((producer) => producer.binding === binding);
    assert.equal(producer.queue, queues[index].name);
    assert.equal(config.vars[`${binding}_NAME`], producer.queue);
    assert.deepEqual(
      config.queues.consumers.filter(({ queue }) => queue === producer.queue),
      [
        {
          queue: producer.queue,
          dead_letter_queue: queues[index].deadLetter,
          max_retries: 3,
        },
      ],
    );
  }
}

// The zone's rate-limiting rule for an environment, as OpenTofu must choose it from the manifest's
// zone plan. Cloudflare Free allows only the Path field and 10-second periods and timeouts
// (https://developers.cloudflare.com/waf/rate-limiting-rules/#availability); Pro and up also allow
// the Host field and 60-second periods.
export function expectedRateLimitRule(manifest) {
  const perMinute = manifest.budgets.requestsPerMinute;
  return manifest.cloudflareZonePlan === "free"
    ? {
        expression: 'http.request.uri.path wildcard "/v1/*"',
        period: 10,
        requests: Math.ceil(perMinute / 6),
        mitigation_timeout: 10,
      }
    : {
        expression: `http.host eq "${manifest.domains.runtime}"`,
        period: 60,
        requests: perMinute,
        mitigation_timeout: 60,
      };
}

export const requiredSecrets = Object.fromEntries([
  ["CLOUDFLARE_API_TOKEN", "opentofu/cloudflare"],
  ["NEON_API_KEY", "opentofu/neon"],
  ["INFRA_STATE_ACCESS_KEY_ID", "opentofu/state"],
  ["INFRA_STATE_SECRET_ACCESS_KEY", "opentofu/state"],
  ["DATABASE_URL", "hyperdrive/runtime-role"],
  ["MIGRATION_DATABASE_URL", "database/migrations"],
  ["SUPPORT_DATABASE_URL", "database/support"],
  ["BACKUP_DATABASE_URL", "database/backup-verification"],
  ["BETTER_AUTH_SECRET", "runtime/authentication"],
  ["AUTH_DATABASE_URL", "runtime/session-verification"],
  ["MANAGEMENT_DATABASE_URL", "runtime/management-readers"],
  ["WORLD_AUTHORIZATION_DATABASE_URL", "runtime/world-authorization"],
  ["MODEL_PROVIDER_API_KEY", "ai-gateway/provider"],
  ["TURNSTILE_SECRET_KEY", "runtime/turnstile"],
  ["CF_ACCESS_CLIENT_SECRET", "operations/access"],
  ["SENTRY_OTLP_TOKEN", "observability/sentry"],
  ["ARTIFACT_KEYRING", "runtime/artifact-encryption"],
]);

// Development and staging keep OpenTofu state in an R2 bucket reached with these credentials.
// Production's state design is decided before production is enabled, so it declares neither.
const productionSecrets = Object.fromEntries(
  Object.entries(requiredSecrets).filter(([name]) => !name.startsWith("INFRA_STATE_")),
);

export async function checkInfrastructure(root) {
  const surface = deploymentSurface(
    await readFile(path.join(root, "apps/runtime/src/cloudflare-entry.ts"), "utf8"),
  );
  assert.deepEqual(surface.manifest.secrets, [
    "BETTER_AUTH_SECRET",
    "AUTH_DATABASE_URL",
    "MANAGEMENT_DATABASE_URL",
    "WORLD_AUTHORIZATION_DATABASE_URL",
    "ARTIFACT_KEYRING",
  ]);
  const allQueues = [];
  for (const environment of environments) {
    const manifest = environmentSchema.parse(
      await readJson(root, `infra/environments/${environment}.json`),
    );
    assert.equal(manifest.environment, environment);
    const declaration = secretSchema.parse(
      await readJson(root, `infra/environments/${environment}.secrets.json`),
    );
    assert.equal(declaration.environment, environment);
    assert.deepEqual(
      Object.fromEntries(declaration.secrets.map(({ name, consumer }) => [name, consumer])),
      ["local", "ci"].includes(environment)
        ? {}
        : environment === "production"
          ? productionSecrets
          : requiredSecrets,
    );
    const configPath = `infra/wrangler/${environment}.json`;
    verifyWrangler(await readJson(root, configPath), manifest, surface, root, configPath);
    allQueues.push(
      ...Object.values(manifest.resources.queues).flatMap(({ name, deadLetter }) => [
        name,
        deadLetter,
      ]),
    );
  }
  assert.equal(
    new Set(allQueues).size,
    allQueues.length,
    "environments must isolate physical queues",
  );
}
