import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deploymentSurface, readJson, verifyWrangler } from "../../infra/check-configuration.mjs";
import { environmentSchema } from "../../infra/environment-schema.ts";
import { stateBackend } from "../../scripts/ci/deployment-authority.mjs";
import { missingRoutingMetadata } from "../../scripts/ci/routing-metadata.mjs";

// infra:validate proves the committed manifests pass; these prove the validator still refuses drift.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = () => readJson(root, "infra/environments/development.json");

describe("infrastructure validator", () => {
  it("rejects unreviewed fields and secret-shaped values in environment manifests", async () => {
    const base = await fixture();
    const unreviewed = structuredClone(base);
    unreviewed.resources.unreviewed = "value";
    expect(() => environmentSchema.parse(unreviewed)).toThrow();
    const secret = structuredClone(base);
    secret.domains[Object.keys(secret.domains)[0]] = "ghp_" + "b".repeat(36);
    expect(() => environmentSchema.parse(secret)).toThrow();
    expect(() =>
      environmentSchema.parse({
        ...base,
        authentication: { ...base.authentication, origin: "http://runtime.example.org" },
      }),
    ).toThrow();
  });
  it("rejects Wrangler deployment drift from the manifest and runtime entry", async () => {
    const surface = deploymentSurface(
      await readFile(path.join(root, "apps/runtime/src/cloudflare-entry.ts"), "utf8"),
    );
    const manifest = await fixture();
    const file = "infra/wrangler/development.json";
    const original = await readJson(root, file);
    for (const change of [
      (config: typeof original) => {
        config.vars.PROVIDER_ENVIRONMENT = "production";
      },
      (config: typeof original) => {
        config.durable_objects.bindings[0].class_name = "Wrong";
      },
      (config: typeof original) => {
        config.queues.consumers[0].dead_letter_queue = "wrong";
      },
      (config: typeof original) => {
        config.analytics_engine_datasets[0].dataset = "rw-production-metrics";
      },
      (config: typeof original) => {
        config.r2_buckets[0].bucket_name = "rw-production-artifacts";
      },
      (config: typeof original) => {
        config.triggers.crons = ["*/5 * * * *"];
      },
    ]) {
      const config = structuredClone(original);
      change(config);
      expect(() => verifyWrangler(config, manifest, surface, root, file)).toThrow();
    }
  });
});

describe("hosted deploy inputs", () => {
  it("keeps state in the account's R2 bucket with no credentials or encryption in the file", async () => {
    const config = await readJson(root, "infra/environments/staging.json");
    const backend = stateBackend("staging", config, "clockgrove-staging-state");
    expect(Object.keys(backend.terraform)).toEqual(["backend"]);
    const { s3 } = backend.terraform.backend;
    expect(s3).toMatchObject({
      bucket: "clockgrove-staging-state",
      key: "staging/terraform.tfstate",
      endpoints: { s3: `https://${config.safeIds.cloudflareAccountId}.r2.cloudflarestorage.com` },
      use_lockfile: true,
    });
    expect(s3).not.toHaveProperty("access_key");
    expect(s3).not.toHaveProperty("secret_key");
    for (const bucket of [undefined, "", "Upper", "a"])
      expect(() => stateBackend("staging", config, bucket)).toThrow(/INFRA_STATE_BUCKET/u);
  });

  it("treats placeholder routing metadata as an unconfigured environment", async () => {
    const config = await readJson(root, "infra/environments/staging.json");
    expect(missingRoutingMetadata(config)).toEqual([]);
    const placeholder = structuredClone(config);
    placeholder.safeIds.cloudflareZoneId = "0".repeat(32);
    placeholder.domains.dnsTarget = "runtime.example.org";
    expect(missingRoutingMetadata(placeholder)).toEqual(["cloudflareZoneId", "dnsTarget"]);
  });
});
