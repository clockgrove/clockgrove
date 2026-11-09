import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deploymentSurface, readJson, verifyWrangler } from "../../infra/check-configuration.mjs";
import { environmentSchema } from "../../infra/environment-schema.ts";
import {
  duplicableResources,
  stateBackend,
  unrecordedDuplicates,
} from "../../scripts/ci/deployment-authority.mjs";
import { missingRoutingMetadata } from "../../scripts/ci/routing-metadata.mjs";
import { describeLock, isBackupKey, signV4 } from "../../scripts/ci/state-store.mjs";

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

  it("refuses a create when state lost a resource the provider would duplicate", async () => {
    const config = await readJson(root, "infra/environments/staging.json");
    const found = duplicableResources(config).map((resource) => ({
      ...resource,
      ids: ["existing"],
    }));
    // Lost state: every existing duplicable resource is unrecorded.
    expect(unrecordedDuplicates([], found).map(({ address }) => address)).toEqual([
      "neon_project.world[0]",
      "cloudflare_turnstile_widget.public[0]",
      "cloudflare_zero_trust_access_service_token.operations[0]",
    ]);
    // Recorded resources, and names nothing holds yet, are not duplicates.
    const recorded = found.map(({ address }) => ({ address, id: "existing" }));
    expect(unrecordedDuplicates(recorded, found)).toEqual([]);
    expect(
      unrecordedDuplicates(
        [],
        found.map((item) => ({ ...item, ids: [] })),
      ),
    ).toEqual([]);
  });
});

describe("state bucket access", () => {
  it("signs requests as AWS Signature Version 4 does", () => {
    // AWS's published GetObject example (Amazon S3 API reference, "Signature Calculations").
    const headers = {
      host: "examplebucket.s3.amazonaws.com",
      range: "bytes=0-9",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20130524T000000Z",
    };
    expect(
      signV4({
        method: "GET",
        url: "https://examplebucket.s3.amazonaws.com/test.txt",
        headers,
        payloadHash: headers["x-amz-content-sha256"],
        // AWS's documented example credentials, split so the secret scan does not flag them.
        credentials: {
          accessKeyId: ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
          secretAccessKey: ["wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"].join(""),
        },
        region: "us-east-1",
        service: "s3",
      }),
    ).toMatch(/Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/u);
  });

  it("names a held lock by object, holder's user name and age, never the host", () => {
    const lock = {
      id: "6c2fddfa-6ce2-5a65-e602-8837ac0179a3",
      operation: "OperationTypeApply",
      who: "runner@fv-az1",
      created: "2026-11-09T20:00:00Z",
    };
    expect(
      describeLock(
        "staging",
        { bucket: "clockgrove-staging-state" },
        lock,
        new Date("2026-11-09T21:30:00Z"),
      ),
    ).toBe(
      "state lock clockgrove-staging-state/staging/terraform.tfstate.tflock held by runner (OperationTypeApply) for 90 min (since 2026-11-09T20:00:00Z), lock ID 6c2fddfa-6ce2-5a65-e602-8837ac0179a3",
    );
  });

  it("takes only a plain backup file name under the environment's backups prefix", () => {
    expect(
      isBackupKey(
        "staging",
        "staging/backups/2026-11-09T20-00-00-000Z-provision-0123456789ab.tfstate",
      ),
    ).toBe(true);
    for (const key of [
      "staging/backups/../../development/backups/x.tfstate",
      "staging/backups/%2e%2e/%2E%2E/development/backups/x.tfstate",
      "staging/backups/..\\..\\development\\backups\\x.tfstate",
      "staging/backups/.\t./x.tfstate",
      "staging/backups/..",
      "staging/terraform.tfstate",
      "development/backups/x.tfstate",
      "staging/backups/nested/x.tfstate",
      undefined,
    ])
      expect(isBackupKey("staging", key)).toBe(false);
  });
});
