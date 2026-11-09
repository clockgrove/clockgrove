import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { missingRoutingMetadata } from "./routing-metadata.mjs";

// Runs only in the trusted release workflow, never in PR jobs.
const environment = process.env;
assert.equal(
  environment.REPOSITORY_DEPLOYMENT_ENABLED,
  "true",
  "deployment admission held: repository variable REPOSITORY_DEPLOYMENT_ENABLED is pending",
);
assert(environment.GITHUB_TOKEN?.trim(), "deployment admission: missing GITHUB_TOKEN");
const admitEnvironment = async (target) => {
  assert(
    ["development", "staging"].includes(target),
    "deployment admission: unknown environment; production is disabled",
  );
  const label = `deployment admission: ${target}`;
  let setup;
  try {
    const response = await fetch(
      `${environment.GITHUB_API_URL}/repos/${environment.GITHUB_REPOSITORY}/environments/${encodeURIComponent(target)}`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          authorization: `Bearer ${environment.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    assert(response.ok, `${label} environment missing or inaccessible (HTTP ${response.status})`);
    setup = await response.json();
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    throw new Error(`${label} environment lookup unavailable or malformed`);
  }
  assert(
    setup?.name === target &&
      Number.isSafeInteger(setup.id) &&
      setup.id > 0 &&
      Array.isArray(setup.protection_rules),
    `${label} environment identity or protection configuration malformed`,
  );
  for (const rule of setup.protection_rules) {
    assert(
      rule &&
        Number.isSafeInteger(rule.id) &&
        rule.id > 0 &&
        ["required_reviewers", "wait_timer", "branch_policy"].includes(rule.type),
      `${label} protection configuration unknown or malformed`,
    );
    if (rule.type === "required_reviewers")
      assert(
        typeof rule.prevent_self_review === "boolean" &&
          Array.isArray(rule.reviewers) &&
          rule.reviewers.length > 0 &&
          rule.reviewers.length <= 6 &&
          rule.reviewers.every(
            (entry) =>
              ["User", "Team"].includes(entry?.type) &&
              Number.isSafeInteger(entry.reviewer?.id) &&
              entry.reviewer.id > 0,
          ),
        `${label} required approval configuration malformed`,
      );
    if (rule.type === "wait_timer")
      assert(
        Number.isSafeInteger(rule.wait_timer) && rule.wait_timer >= 0 && rule.wait_timer <= 43200,
        `${label} wait timer configuration malformed`,
      );
    if (rule.type === "branch_policy")
      assert(
        typeof setup.deployment_branch_policy?.protected_branches === "boolean" &&
          typeof setup.deployment_branch_policy?.custom_branch_policies === "boolean",
        `${label} branch protection configuration malformed`,
      );
  }
  if (target === "staging")
    assert(
      setup.protection_rules.filter((rule) => rule.type === "required_reviewers").length === 1,
      `${label} required approval protection missing or ambiguous`,
    );
};
// The reusable workflow also checks admission in a job with no environment declaration.
if (process.argv[2] === "--admit-environment") {
  const target = process.argv[3];
  await admitEnvironment(target);
  await appendFile(environment.GITHUB_OUTPUT, `environment=${target}\n`);
  process.exit(0);
}
const event = JSON.parse(await readFile(environment.GITHUB_EVENT_PATH, "utf8"));
const automatic = environment.GITHUB_EVENT_NAME === "workflow_run";
// A main push deploys to development only once infra/environments/development.json carries
// development's own routing metadata. Until then the run names no environment, so no development
// deploy is queued.
if (automatic) {
  const development = JSON.parse(
    await readFile(new URL("../../infra/environments/development.json", import.meta.url), "utf8"),
  );
  if (missingRoutingMetadata(development).length) {
    console.log("development is not configured; no deployment selected");
    process.exit(0);
  }
}
const runId = automatic ? String(event.workflow_run.id) : event.inputs.quality_run_id;
assert(/^\d+$/u.test(runId), "missing qualified Quality run ID");
const api = async (suffix) => {
  const response = await fetch(
    `${environment.GITHUB_API_URL}/repos/${environment.GITHUB_REPOSITORY}/${suffix}`,
    {
      headers: {
        authorization: `Bearer ${environment.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
      },
    },
  );
  assert(response.ok, "candidate selection: authenticated CI metadata unavailable");
  return response.json();
};
const run = await api(`actions/runs/${runId}`);
assert.equal(run.path, ".github/workflows/quality.yml", "candidate must come from Quality");
assert.equal(run.event, "push", "candidate requires credential-free main push qualification");
assert.equal(run.head_branch, "main", "candidate requires main qualification");
assert.equal(
  run.head_repository.full_name,
  environment.GITHUB_REPOSITORY,
  "candidate repository mismatch",
);
assert.equal(run.conclusion, "success", "candidate Quality run did not pass");
assert.equal(run.status, "completed", "candidate Quality run incomplete");
assert(/^[a-f0-9]{40}$/u.test(run.head_sha), "invalid candidate commit");
if (!automatic)
  assert.equal(
    event.inputs.candidate,
    run.head_sha,
    "protected staging approval requires exact candidate",
  );
const jobs = await api(`actions/runs/${runId}/jobs`);
assert(
  jobs.jobs.some((job) => job.name === "quality" && job.conclusion === "success"),
  "required quality job did not pass",
);
const artifacts = await api(`actions/runs/${runId}/artifacts`);
const matches = artifacts.artifacts.filter(
  (artifact) => artifact.name === "quality-evidence" && !artifact.expired,
);
assert.equal(matches.length, 1, "qualified candidate evidence artifact missing or ambiguous");
assert.equal(matches[0].workflow_run.head_sha, run.head_sha, "artifact candidate mismatch");
const target = automatic ? "development" : "staging";
await admitEnvironment(target);
await appendFile(
  environment.GITHUB_OUTPUT,
  `candidate=${run.head_sha}\nrun_id=${runId}\nartifact_id=${matches[0].id}\nartifact_digest=${matches[0].digest}\nenvironment=${target}\n`,
);
