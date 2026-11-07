import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deploymentSurface, readJson, verifyWrangler } from "../../infra/check-configuration.mjs";
import { environmentSchema } from "../../infra/environment-schema.ts";

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
