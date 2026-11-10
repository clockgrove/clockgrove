import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deploymentSurface, readJson, verifyWrangler } from "../../infra/check-configuration.mjs";
import { environmentSchema } from "../../infra/environment-schema.ts";
import {
  applyStage,
  failedDeploymentStatus,
  providerMessage,
  provisionOptions,
  recordDeploymentPhase,
  tofuDiagnostics,
} from "../../scripts/ci/deploy.mjs";
import {
  duplicableResources,
  stateBackend,
  unrecordedDuplicates,
  verifyPlan,
} from "../../scripts/ci/deployment-authority.mjs";
import {
  assertDeploymentOutcome,
  outstandingPhases,
  provisionRetry,
} from "../../scripts/ci/evidence.mjs";
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

describe("deploy diagnostics", () => {
  const diagnostic = (detail: string) =>
    JSON.stringify({
      type: "diagnostic",
      diagnostic: {
        severity: "error",
        summary: "Client Error",
        detail,
        address: "neon_project.world[0]",
      },
    });

  it("names the resource, the codes and the provider's message", () => {
    expect(
      tofuDiagnostics(
        diagnostic("Unable to create project, got error: status 400: not allowed on the free plan"),
      ),
    ).toBe(
      "Client Error at neon_project.world[0] (codes 400): status 400: not allowed on the free plan",
    );
    expect(tofuDiagnostics('{"type":"apply_start"}\nnot json')).toBe("");
  });

  it("never prints credential-shaped text from a detail", () => {
    // Built at run time so the repository's secret scan never sees a credential-shaped literal.
    const long = "Q".repeat(30);
    const short = ["hun", "ter2"].join("");
    const url = ["postgres://role:", long, "@host/db"].join("");
    const said = providerMessage(`got error: ${url} token=${short} password: ${short} ${long}`);
    for (const secret of [long, short]) expect(said).not.toContain(secret);
  });
});

describe("provision retry", () => {
  type Phase = { command: string[]; status: string; attempt?: number };
  type Reply = { status: number | null; signal?: string; stdout: string };
  const refusal = (address?: string) =>
    JSON.stringify({
      type: "diagnostic",
      diagnostic: {
        severity: "error",
        summary: "Client Error",
        detail:
          '{"code":"","message":"project already has running conflicting operations, scheduling of new ones is prohibited"}',
        ...(address ? { address } : {}),
      },
    });
  const locked = refusal('neon_role.database["migrations"]');
  const change = (address: string, action: string) => ({ address, change: { actions: [action] } });
  const create = change('neon_role.database["migrations"]', "create");
  let work = "";
  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), "clockgrove-provision-"));
  });
  afterAll(() => rm(work, { recursive: true, force: true }));
  // Runs one provision stage against a stubbed `tofu`: each apply answers from `applies` in turn,
  // each review shows the next of `plans` (the last one repeats). `options` replaces the retry hook.
  async function provision(
    applies: Reply[],
    plans: object[] = [{ resource_changes: [create] }],
    options: object = {},
  ) {
    const config = await readJson(root, "infra/environments/staging.json");
    const result = { phases: [] as Phase[] };
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const retries: number[] = [];
    const run = (_tofu: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "apply") return applies.shift();
      if (args[0] === "show")
        return { status: 0, stdout: JSON.stringify(plans.length > 1 ? plans.shift() : plans[0]) };
      return { status: 0, stdout: "" };
    };
    const outcome = applyStage("provision", {
      work,
      planArgs: ["-var=activation_stage=provision"],
      phase: (name: string, executable: string, args: string[], phaseOptions: object) =>
        recordDeploymentPhase(
          result,
          { commit: "a".repeat(40), tree: "b".repeat(40) },
          name,
          executable,
          args,
          { ...phaseOptions, run },
        ),
      review: (plan: object) => verifyPlan(plan, config, "provision", false),
      retry: provisionRetry,
      beforeRetry: async (attempt: number) => {
        retries.push(attempt);
      },
      sleep: async (seconds: number) => {
        sleeps.push(seconds);
      },
      ...options,
    }).then(
      () => "passed",
      (error: Error) => error.message,
    );
    return { outcome: await outcome, result, calls, sleeps, retries };
  }
  const applies = (calls: string[][]) => calls.filter((args) => args[0] === "apply");
  const steps = (phases: Phase[]) =>
    phases.map(({ command, status, attempt }) => `${command[0]} ${attempt ?? 1} ${status}`);

  it("re-plans, re-reviews and applies a new plan after a Neon lock, and the retry decides", async () => {
    const run = await provision([
      { status: 1, stdout: locked },
      { status: 0, stdout: "" },
    ]);
    expect(run.outcome).toBe("passed");
    expect(steps(run.result.phases)).toEqual([
      "OpenTofu provision plan 1 passed",
      "OpenTofu provision review 1 passed",
      "OpenTofu provision apply 1 unknown",
      "OpenTofu provision plan 2 passed",
      "OpenTofu provision review 2 passed",
      "OpenTofu provision apply 2 passed",
    ]);
    expect(new Set(applies(run.calls).map((args) => args.at(-1))).size).toBe(2);
    expect(run.sleeps).toEqual([15]);
    expect(run.retries).toEqual([2]);
    expect(outstandingPhases(run.result.phases).every(({ status }) => status === "passed")).toBe(
      true,
    );
  });

  it("stops after the last try with its diagnostics, its effect still unknown", async () => {
    const run = await provision(Array.from({ length: 5 }, () => ({ status: 1, stdout: locked })));
    expect(run.outcome).toMatch(
      /^OpenTofu provision apply \(attempt 4\) failed; Client Error at neon_role\.database\["migrations"\]: project already has running conflicting operations/u,
    );
    expect(applies(run.calls)).toHaveLength(4);
    expect(run.sleeps).toEqual([15, 30, 60]);
    expect(failedDeploymentStatus(run.result.phases, true)).toBe("unknown");
  });

  it("does not retry a non-Neon error, an interrupted apply, a failed project create or a plan that turned destructive", async () => {
    for (const reply of [
      { status: 1, stdout: refusal("cloudflare_queue.runtime") },
      { status: 1, stdout: refusal() },
      { status: null, signal: "SIGTERM", stdout: locked },
    ]) {
      const run = await provision([reply, { status: 0, stdout: "" }]);
      expect(run.outcome).toMatch(/^OpenTofu provision apply failed/u);
      expect(applies(run.calls)).toHaveLength(1);
    }
    // Neon may hold a project whose create failed; a retry could make a second one.
    const project = "neon_project.world[0]";
    const created = await provision(
      [
        { status: 1, stdout: refusal(project) },
        { status: 0, stdout: "" },
      ],
      [{ resource_changes: [change(project, "create"), create] }],
    );
    expect(applies(created.calls)).toHaveLength(1);
    const updated = await provision(
      [
        { status: 1, stdout: refusal(project) },
        { status: 0, stdout: "" },
      ],
      [{ resource_changes: [change(project, "update"), create] }],
    );
    expect(updated.outcome).toBe("passed");
    const destroy = change('neon_role.database["migrations"]', "delete");
    const run = await provision(
      [{ status: 1, stdout: locked }],
      [{ resource_changes: [create] }, { resource_changes: [destroy] }],
    );
    expect(run.outcome).toBe("destructive infrastructure plan refused");
    expect(applies(run.calls)).toHaveLength(1);
  });

  it("checks the lock and lost state before a retry, as the deploy wires it", async () => {
    // A state bucket holding nothing but, when `held`, the lock object.
    const store = (held: boolean) => ({
      bucket: "clockgrove-staging-state",
      read: async (key: string) =>
        held && key.endsWith(".tflock")
          ? { body: Buffer.from('{"ID":"lock-1","Who":"runner@host"}'), etag: "e" }
          : null,
    });
    const reads: number[] = [];
    const readInventory = async (attempt: number) => {
      reads.push(attempt);
    };
    const failThenPass = () => [
      { status: 1, stdout: locked },
      { status: 0, stdout: "" },
    ];
    const free = await provision(failThenPass(), undefined, {
      ...provisionOptions(store(false), "staging", readInventory),
    });
    expect(free.outcome).toBe("passed");
    expect(applies(free.calls)[0]).toContain("-parallelism=1");
    expect(reads).toEqual([2]);
    const migrations = { command: ["database migrations"], status: "failed" };
    expect(failedDeploymentStatus([...free.result.phases, migrations], true)).toBe("failed");
    const held = await provision(failThenPass(), undefined, {
      ...provisionOptions(store(true), "staging", readInventory),
    });
    expect(held.outcome).toMatch(/^state lock clockgrove-staging-state\/staging\/terraform/u);
    expect(reads).toEqual([2]);
    expect(failedDeploymentStatus(held.result.phases, true)).toBe("unknown");
  });

  it("accepts only retry evidence the deploy produces", () => {
    const phase = (command: string, status: string, attempt?: number) => ({
      command: [command],
      status,
      ...(attempt ? { attempt } : {}),
    });
    const run = (attempt: number | undefined, applied: string) => [
      phase("read owned persisted resource identities", "passed", attempt),
      phase("OpenTofu provision plan", "passed", attempt),
      phase("OpenTofu provision review", "passed", attempt),
      phase("OpenTofu provision apply", applied, attempt),
    ];
    const deployment = (status: string, phases: object[]) => ({ status, phases });
    const outcome = (status: string, phases: object[]) => {
      try {
        assertDeploymentOutcome(deployment(status, phases));
        return "accepted";
      } catch (error) {
        return (error as Error).message.split("\n")[0];
      }
    };
    const retried = [...run(undefined, "unknown"), ...run(2, "passed")];
    const later = (name: string, status: string, attempt?: number) => [
      ...retried,
      phase(name, status, attempt),
    ];
    expect(outcome("passed", retried)).toBe("accepted");
    expect(outcome("failed", later("database migrations", "failed"))).toBe("accepted");
    const exhausted = [1, 2, 3, 4].flatMap((n) => run(n > 1 ? n : undefined, "unknown"));
    expect(outcome("unknown", exhausted)).toBe("accepted");
    expect(outcome("failed", exhausted)).toBe("deployment effect uncertainty mismatch");
    expect(outcome("passed", run(undefined, "unknown"))).toBe(
      "deployment effect uncertainty mismatch",
    );
    expect(
      outcome("passed", [
        ...run(undefined, "unknown"),
        phase("OpenTofu provision apply", "passed", 2),
      ]),
    ).toBe("deploy retry phases out of order");
    expect(
      outcome("passed", [
        ...run(undefined, "passed"),
        phase("Wrangler Worker publication", "unknown"),
        phase("Wrangler Worker publication", "passed", 2),
      ]),
    ).toBe("deploy retry of a phase that is never retried");
    expect(outcome("passed", later("OpenTofu bindings apply", "passed", 2))).toBe(
      "deploy retry of a phase that is never retried",
    );
    expect(outcome("passed", [...run(undefined, "passed"), ...run(2, "passed")])).toBe(
      "deploy retry without a failed provision apply before it",
    );
    const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) =>
      run(n > 1 ? n : undefined, n < 9 ? "unknown" : "passed"),
    );
    expect(outcome("passed", nine)).toBe("deploy retry beyond its attempt limit");
  });
});
