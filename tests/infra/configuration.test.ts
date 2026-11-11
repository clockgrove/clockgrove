import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  tofuBounds,
  tofuDiagnostics,
  tofuLimits,
} from "../../scripts/ci/deploy.mjs";
import {
  awaitNeonOperations,
  duplicableResources,
  persistedAddresses,
  resourceAddresses,
  restoresRetiredRoles,
  restrictedRolePasswords,
  retiredResources,
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
import {
  deploymentRolesInput,
  restrictedRoleKeys,
  roleCheckFailures,
} from "../../scripts/database/deployment-roles.mjs";
import { restore } from "../../scripts/infra-state.mjs";

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

describe("restricted database roles", () => {
  const generated = () =>
    Array.from({ length: 2 }, () => crypto.randomUUID())
      .join("")
      .replaceAll("-", "");
  const credentials = (config: { resources: { database: { roles: Record<string, string> } } }) => ({
    roles: Object.fromEntries(
      Object.entries(config.resources.database.roles).map(([key, name]) => [
        key,
        { name, password: generated() },
      ]),
    ),
  });

  it("owns only the migration role as a Neon API role and retires the others' API roles", async () => {
    const config = await readJson(root, "infra/environments/staging.json");
    const owned = resourceAddresses(config);
    const retired = [...retiredResources()];
    expect(retired).toHaveLength(6);
    expect(retired.filter((address) => owned.has(address))).toEqual([]);
    expect([...owned].filter((address) => address.startsWith("neon_role."))).toEqual([
      'neon_role.database["migrations"]',
    ]);
    for (const key of restrictedRoleKeys) {
      expect(owned.has(`random_password.database["${key}"]`)).toBe(true);
      expect(persistedAddresses(config).has(`neon_role.database["${key}"]`)).toBe(true);
    }
  });

  it("accepts deleting a retired API role at provision, partial migration included, and no other deletion, replacement or forget", async () => {
    const config = await readJson(root, "infra/environments/staging.json");
    const review =
      (address: string, actions: string[], action_reason?: string, stage = "provision") =>
      () =>
        verifyPlan(
          { resource_changes: [{ address, action_reason, change: { actions } }] },
          config,
          stage,
          false,
        );
    const runtime = 'neon_role.database["runtime"]';
    const retired =
      /retired neon_role\.database\["runtime"\] may only be deleted, in the provision stage/u;
    expect(review(runtime, ["delete"], "delete_because_each_key")).not.toThrow();
    for (const [actions, reason] of [
      [["delete"], undefined],
      [["delete", "create"], "delete_because_each_key"],
      [["create"], undefined],
      [["no-op"], undefined],
    ] as const)
      expect(review(runtime, [...actions], reason)).toThrow(retired);
    for (const stage of ["bindings", "routing"])
      expect(review(runtime, ["delete"], "delete_because_each_key", stage)).toThrow(retired);
    // A run that ended mid-migration left both the API role and its generated password in state:
    // the next provision completes the deletion.
    const partial = {
      prior_state: {
        values: {
          root_module: {
            resources: [{ address: runtime }, { address: 'random_password.database["runtime"]' }],
          },
        },
      },
      resource_changes: [
        {
          address: runtime,
          action_reason: "delete_because_each_key",
          change: { actions: ["delete"] },
        },
        { address: 'random_password.database["runtime"]', change: { actions: ["no-op"] } },
      ],
    };
    expect(() => verifyPlan(partial, config, "provision", false)).not.toThrow();
    expect(
      review('neon_role.database["migrations"]', ["delete"], "delete_because_each_key"),
    ).toThrow(/destructive infrastructure plan refused/u);
    expect(review("neon_project.world[0]", ["forget"])).toThrow(
      /unreviewed infrastructure plan action/u,
    );
    expect(review('random_password.database["support"]', ["create"])).not.toThrow();
  });

  it("refuses to restore a pre-migration backup into a migrated environment, its state present or lost", async () => {
    const state = (type: string, keys: string[]) =>
      JSON.stringify({
        resources: [
          { type, name: "database", instances: keys.map((index_key) => ({ index_key })) },
        ],
      });
    const pre = state("neon_role", ["migrations", "runtime"]);
    const post = state("random_password", ["runtime", "support"]);
    expect(restoresRetiredRoles([post], pre)).toBe(true);
    expect(restoresRetiredRoles([post], state("neon_role", ["migrations"]))).toBe(false);
    expect(restoresRetiredRoles([pre], pre)).toBe(false);
    // An in-memory state bucket with the given objects.
    const bucket = (objects: Record<string, string>) => {
      const held = new Map(Object.entries(objects));
      return {
        bucket: "clockgrove-staging-state",
        held,
        get: async (key: string) => held.get(key) ?? null,
        read: async (key: string) => (held.has(key) ? { body: held.get(key), etag: "e" } : null),
        create: async (key: string, body: string) => {
          if (held.has(key)) throw new Error("exists");
          held.set(key, body);
        },
        replace: async (key: string, body: string) => {
          held.set(key, body);
        },
        delete: async (key: string) => {
          held.delete(key);
        },
        list: async (prefix: string) =>
          [...held.keys()].filter((key) => key.startsWith(prefix)).sort(),
      };
    };
    const backup = (name: string) => `staging/backups/${name}.tfstate`;
    const backups = {
      [backup("2026-11-09T10-00-00-000Z-provision-pre")]: pre,
      [backup("2026-11-10T10-00-00-000Z-provision-post")]: post,
    };
    const refusal = /predates the SQL-created database roles/u;
    // Lost state: the newer backup shows the environment migrated.
    const lost = bucket(backups);
    await expect(
      restore(lost, "staging", backup("2026-11-09T10-00-00-000Z-provision-pre")),
    ).rejects.toThrow(refusal);
    expect(lost.held.has("staging/terraform.tfstate")).toBe(false);
    expect(lost.held.has("staging/terraform.tfstate.tflock")).toBe(false);
    await expect(
      restore(lost, "staging", backup("2026-11-10T10-00-00-000Z-provision-post")),
    ).resolves.toMatch(/^restored/u);
    // Present state that holds the passwords.
    const present = bucket({ ...backups, "staging/terraform.tfstate": post });
    await expect(
      restore(present, "staging", backup("2026-11-09T10-00-00-000Z-provision-pre"), {
        replace: true,
      }),
    ).rejects.toThrow(refusal);
    // An environment that never migrated restores its own backups.
    const never = bucket({ [backup("2026-11-09T10-00-00-000Z-provision-pre")]: pre });
    await expect(
      restore(never, "staging", backup("2026-11-09T10-00-00-000Z-provision-pre")),
    ).resolves.toMatch(/^restored/u);
  });

  it("hands psql only letter-and-digit passwords, on standard input, and reports checks by name", async () => {
    const config = await readJson(root, "infra/environments/staging.json");
    const passwords = restrictedRolePasswords(credentials(config), config);
    expect(Object.keys(passwords)).toEqual(restrictedRoleKeys);
    const input = await deploymentRolesInput(passwords);
    expect(input.split("\n").slice(0, 6)).toEqual(
      restrictedRoleKeys.map((key) => `\\set password_${key} '${passwords[key]}'`),
    );
    expect(input).toContain("\\bind 'clockgrove_world_reader' :password_worldAuthorization \\g");
    for (const unsafe of [`${generated()}'`, `${generated()}\n\\! id`, generated().slice(0, 20)])
      await expect(deploymentRolesInput({ ...passwords, backup: unsafe })).rejects.toThrow(
        /backup role password/u,
      );
    const renamed = credentials(config);
    renamed.roles.support.name = "clockgrove_migrator";
    expect(() => restrictedRolePasswords(renamed, config)).toThrow(/support role credential/u);
    expect(
      roleCheckFailures(
        "psql:<stdin>:12: ERROR:  clockgrove role check: clockgrove_support is a member of neon_superuser\nCONTEXT:  PL/pgSQL function inline_code_block line 18 at RAISE\n",
      ),
    ).toBe("clockgrove_support is a member of neon_superuser");
    // Without a named check, PostgreSQL's own first error lines are kept, token-length text redacted.
    const leaked = generated();
    const said = roleCheckFailures(
      `psql:<stdin>:3: ERROR:  syntax error at or near "${leaked}"\nLINE 1: ${leaked}\n`,
    );
    expect(said).toBe('syntax error at or near "<redacted>"');
    expect(said).not.toContain(leaked);
    expect(
      roleCheckFailures(
        "psql:<stdin>:40: ERROR:  permission denied to create role\nDETAIL:  Only roles with the CREATEROLE attribute may create roles.\n",
      ),
    ).toBe("permission denied to create role");
    // psql's own client-side errors (connection, TLS, meta-commands) are named too.
    expect(
      roleCheckFailures(
        'psql: error: connection to server at "ep-x.neon.tech" (1.2.3.4), port 5432 failed: root certificate file "/home/runner/.postgresql/root.crt" does not exist\n',
      ),
    ).toContain("root certificate file");
    expect(roleCheckFailures("psql:<stdin>:7: error: \\bind: missing parameter\n")).toContain(
      "bind",
    );
  });

  it("waits a bounded time for Neon's operations, retries one 5xx, and names what failed or never finished", async () => {
    const replies = (...answers: (string[] | number)[]) => {
      const requests: string[] = [];
      const request = async (url: string) => {
        requests.push(url);
        const answer = (answers.length > 1 ? answers.shift() : answers[0]) ?? [];
        if (typeof answer === "number") return new Response("{}", { status: answer });
        return new Response(
          JSON.stringify({
            operations: answer.map((status) => ({
              action: "apply_config",
              status,
              created_at: "2026-11-10T00:01:00Z",
            })),
          }),
        );
      };
      return { request, requests };
    };
    let clock = 0;
    const sleeps: number[] = [];
    const timing = {
      since: Date.parse("2026-11-10T00:00:00Z"),
      now: () => clock,
      sleep: async (seconds: number) => {
        sleeps.push(seconds);
        clock += seconds * 1000;
      },
    };
    const settled = replies(["running", "finished"], 503, ["finished"]);
    await awaitNeonOperations("project-1", "token", { ...timing, request: settled.request });
    expect(settled.requests).toEqual(
      Array(3).fill("https://console.neon.tech/api/v2/projects/project-1/operations?limit=50"),
    );
    expect(sleeps).toEqual([5, 5]);
    const stuck = replies(["scheduling"]);
    await expect(
      awaitNeonOperations("project-1", "token", { ...timing, request: stuck.request }),
    ).rejects.toThrow("still in progress after 180 s: apply_config (scheduling)");
    expect(stuck.requests).toHaveLength(37);
    await expect(
      awaitNeonOperations("project-1", "token", { ...timing, request: replies(503, 502).request }),
    ).rejects.toThrow(/Neon operation listing unavailable \(HTTP 502/u);
    await expect(
      awaitNeonOperations("project-1", "token", {
        ...timing,
        request: replies(["finished", "failed"]).request,
      }),
    ).rejects.toThrow("Neon operations of this deploy did not succeed: apply_config (failed)");
    // A failure from before this deploy is not its own.
    await expect(
      awaitNeonOperations("project-1", "token", {
        ...timing,
        since: Date.parse("2026-11-10T00:02:00Z"),
        request: replies(["cancelled"]).request,
      }),
    ).resolves.toBeUndefined();
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
  type Phase = {
    command: string[];
    status: string;
    attempt?: number;
    reason?: string;
    exitCode?: number | null;
    signal?: string | null;
    errorCode?: string | null;
  };
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
  // With `stuck`, applies run that executable (for real, unless refused) with those phase options.
  async function provision(
    applies: Reply[],
    plans: object[] = [{ resource_changes: [create] }],
    options: object = {},
    stuck?: { executable: string; options: object },
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
          args[0] === "apply" && stuck ? stuck.executable : executable,
          args,
          args[0] === "apply" && stuck
            ? { ...phaseOptions, ...stuck.options }
            : { ...phaseOptions, run },
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

  it("stops a tofu that never returns: SIGINT first, SIGKILL after the grace, unknown, no retry", async () => {
    // A stub `tofu` that logs each SIGINT and, unless told to exit on one, never returns, as the
    // Neon provider does while it polls a failed operation.
    const stub = path.join(work, "tofu-stub.cjs");
    const log = path.join(work, "signals.log");
    await writeFile(
      stub,
      [
        "#!/usr/bin/env node",
        'const { appendFileSync } = require("node:fs");',
        'process.on("SIGINT", () => {',
        '  appendFileSync(process.env.STUB_LOG, "SIGINT\\n");',
        '  if (process.env.STUB_EXIT_ON_INT === "1") process.exit(1);',
        "});",
        "setInterval(() => {}, 1000);",
        'process.stdout.write("ready\\n");',
      ].join("\n"),
    );
    await chmod(stub, 0o755);
    const stuck = async (exitOnInterrupt: boolean) => {
      await rm(log, { force: true });
      const run = await provision(
        [],
        undefined,
        {},
        {
          executable: stub,
          options: {
            timeoutMs: 800,
            killGraceMs: 600,
            cwd: work,
            env: { ...process.env, STUB_LOG: log, STUB_EXIT_ON_INT: exitOnInterrupt ? "1" : "0" },
          },
        },
      );
      const signals = (await readFile(log, "utf8").catch(() => "")).trim().split("\n");
      return { ...run, signals, apply: run.result.phases.at(-1) as Phase };
    };
    const killed = await stuck(false);
    expect(killed.outcome).toMatch(
      /^OpenTofu provision apply stopped: no result within 1 s; interrupted with SIGINT, then killed after the grace; the state lock may be held; sensitive command output withheld$/u,
    );
    expect(killed.signals).toEqual(["SIGINT"]);
    expect(killed.apply).toMatchObject({
      status: "unknown",
      reason: "timeout",
      errorCode: "ETIMEDOUT",
      signal: "SIGKILL",
      exitCode: null,
    });
    expect(killed.sleeps).toEqual([]);
    expect(killed.retries).toEqual([]);
    expect(steps(killed.result.phases)).toEqual([
      "OpenTofu provision plan 1 passed",
      "OpenTofu provision review 1 passed",
      "OpenTofu provision apply 1 unknown",
    ]);
    expect(failedDeploymentStatus(killed.result.phases, true)).toBe("unknown");
    expect(() =>
      assertDeploymentOutcome({ status: "unknown", phases: killed.result.phases }),
    ).not.toThrow();
    // With providers that honour its stop, OpenTofu saves state, releases the lock and exits.
    const graceful = await stuck(true);
    expect(graceful.outcome).toMatch(/interrupted with SIGINT, exited within the grace;/u);
    expect(graceful.signals).toEqual(["SIGINT"]);
    expect(graceful.apply).toMatchObject({
      status: "unknown",
      reason: "timeout",
      errorCode: "ETIMEDOUT",
      signal: null,
      exitCode: 1,
    });
    expect(graceful.retries).toEqual([]);
  });

  it("bounds each tofu call inside the deploy's budget and starts no apply it would cut short", () => {
    const { applySeconds, callSeconds, floorSeconds, budgetSeconds, graceSeconds } = tofuLimits;
    expect(tofuBounds(["apply", "plan.tfplan"], 0)).toEqual({
      timeoutMs: applySeconds * 1000,
      killGraceMs: graceSeconds * 1000,
    });
    expect(tofuBounds(["plan"], 0).timeoutMs).toBe(callSeconds * 1000);
    // An apply needs its whole limit; any other call is cut to what is left, down to the floor.
    const at = (left: number) => (budgetSeconds - left) * 1000;
    expect(tofuBounds(["apply"], at(applySeconds)).timeoutMs).toBe(applySeconds * 1000);
    expect(tofuBounds(["apply"], at(applySeconds) + 1)).toEqual({
      refused: `its ${applySeconds} s limit does not fit the ${applySeconds - 1} s left of the deploy's ${budgetSeconds} s OpenTofu budget`,
    });
    expect(tofuBounds(["plan"], at(100)).timeoutMs).toBe(100_000);
    expect(tofuBounds(["show"], at(floorSeconds - 1)).refused).toMatch(/^the minimum /u);
    expect(tofuBounds(["show"], at(-5)).refused).toMatch(/does not fit the 0 s left/u);
    // The last call stops by the budget plus the grace, inside the 45-minute job with room for
    // the job's setup steps and the evidence upload.
    expect(budgetSeconds + graceSeconds).toBeLessThanOrEqual(35 * 60);
  });

  it("records a call the budget refuses as a failed phase that ends the deploy, retrying nothing", async () => {
    const { refused } = tofuBounds(["apply"], (tofuLimits.budgetSeconds - 100) * 1000);
    const run = await provision([], undefined, {}, { executable: "tofu", options: { refused } });
    expect(run.outcome).toBe(
      `OpenTofu provision apply not started: its ${tofuLimits.applySeconds} s limit does not fit the 100 s left of the deploy's ${tofuLimits.budgetSeconds} s OpenTofu budget`,
    );
    expect(run.result.phases.at(-1)).toMatchObject({
      status: "failed",
      reason: "budget",
      exitCode: null,
      signal: null,
      errorCode: null,
    });
    expect(steps(run.result.phases)).toEqual([
      "OpenTofu provision plan 1 passed",
      "OpenTofu provision review 1 passed",
      "OpenTofu provision apply 1 failed",
    ]);
    expect(run.retries).toEqual([]);
    expect(run.sleeps).toEqual([]);
    // Nothing ran, so the deploy failed with a known effect, and never passed.
    expect(failedDeploymentStatus(run.result.phases, true)).toBe("failed");
    expect(() =>
      assertDeploymentOutcome({ status: "failed", phases: run.result.phases }),
    ).not.toThrow();
    expect(() => assertDeploymentOutcome({ status: "passed", phases: run.result.phases })).toThrow(
      "deployment outcome mismatch",
    );
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
    // A phase stopped at its time limit ends the deploy, unknown, with no retry after it.
    const timedOut = {
      ...phase("OpenTofu provision apply", "unknown"),
      reason: "timeout",
      errorCode: "ETIMEDOUT",
    };
    const stopped = [...run(undefined, "passed").slice(0, 3), timedOut];
    expect(outcome("unknown", stopped)).toBe("accepted");
    expect(outcome("failed", stopped)).toBe("deployment effect uncertainty mismatch");
    expect(outcome("unknown", [...stopped, ...run(2, "passed")])).toBe(
      "deployment continued after a time-limited phase",
    );
    expect(outcome("unknown", [...stopped.slice(0, 3), { ...timedOut, errorCode: null }])).toBe(
      "timed-out phase outcome mismatch",
    );
    // A call the budget refused never ran: failed, unobserved, and last.
    const refused = {
      ...phase("OpenTofu provision apply", "failed"),
      reason: "budget",
      exitCode: null,
      startedAt: "t",
      completedAt: "t",
    };
    const ended = [...stopped.slice(0, 3), refused];
    expect(outcome("failed", ended)).toBe("accepted");
    expect(outcome("failed", [...ended, phase("Hyperdrive identity", "passed")])).toBe(
      "deployment continued after a time-limited phase",
    );
    expect(outcome("unknown", [...stopped.slice(0, 3), { ...refused, status: "unknown" }])).toBe(
      "refused phase outcome mismatch",
    );
    expect(outcome("failed", [...stopped.slice(0, 3), { ...refused, exitCode: 1 }])).toBe(
      "refused phase outcome mismatch",
    );
  });
});
