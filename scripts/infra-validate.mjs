import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkInfrastructure } from "../infra/check-configuration.mjs";
import { environments } from "../infra/environment-schema.ts";
import { withProviderIpc } from "./provider-ipc.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
await checkInfrastructure(root);
run(path.join(root, "node_modules/.bin/tsc"), ["--project", "infra/tsconfig.json"]);
run(path.join(root, "node_modules/.bin/vitest"), [
  "run",
  "--config",
  "vitest.workspace.ts",
  "--project",
  "infra",
]);
// The lock file pins every provider's version and package hashes; `tofu init -lockfile=readonly`
// refuses any package whose hash it lacks, whichever source supplied it.
const lock = await readFile(path.join(root, "infra/opentofu/.terraform.lock.hcl"), "utf8");
const locked = [...lock.matchAll(/^provider "([^"]+)" \{\n {2}version += "([^"]+)"$/gmu)].map(
  ([, source, version]) => ({ source, version }),
);
if (locked.length === 0) throw new Error("infra/opentofu/.terraform.lock.hcl pins no providers");
// A mirror filled by `scripts/ci/toolchain.sh opentofu-providers`, beside the tofu on PATH, so
// validation runs without network. Used only when it holds every locked version for this platform.
function providerMirror() {
  const platform = `${process.platform}_${{ x64: "amd64", arm64: "arm64" }[process.arch]}`;
  const tofu = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((directory) => path.join(directory, "tofu"))
    .find((candidate) => path.isAbsolute(candidate) && existsSync(candidate));
  if (!tofu) return undefined;
  const mirror = path.join(
    path.dirname(path.dirname(realpathSync(tofu))),
    "share/opentofu-providers",
  );
  const complete = locked.every(({ source, version }) =>
    existsSync(
      path.join(
        mirror,
        source,
        `terraform-provider-${path.basename(source)}_${version}_${platform}.zip`,
      ),
    ),
  );
  return complete ? mirror : undefined;
}
const mirror = providerMirror();
const sources = JSON.stringify(locked.map(({ source }) => source));
const installation = mirror
  ? `filesystem_mirror {\n    path = ${JSON.stringify(mirror)}\n    include = ${sources}\n  }`
  : `direct {\n    include = ${sources}\n  }`;
const temporary = await mkdtemp(path.join(os.tmpdir(), "clockgrove-infra-"));
try {
  const home = path.join(temporary, "home");
  await mkdir(home);
  // No user CLI config, provider caches, credentials, backend or TF_VARs. The only source is the
  // lock-file-verified mirror or the public registry, never both: a mirror miss cannot fall back.
  const cliConfig = path.join(temporary, "tofurc");
  await writeFile(cliConfig, `provider_installation {\n  ${installation}\n}\n`);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: temporary,
    TF_CLI_CONFIG_FILE: cliConfig,
    TF_DATA_DIR: path.join(temporary, "providers"),
    TF_IN_AUTOMATION: "1",
    CHECKPOINT_DISABLE: "1",
    CLOUDFLARE_SEND_METRICS: "false",
    WRANGLER_SEND_METRICS: "false",
    CI: "true",
  };
  const version = spawnSync("tofu", ["version", "-json"], { env, encoding: "utf8" });
  if (version.status !== 0 || JSON.parse(version.stdout).terraform_version !== "1.13.1")
    throw new Error("OpenTofu 1.13.1 is required on PATH");
  await cp(path.join(root, "infra"), path.join(temporary, "infra"), {
    recursive: true,
    filter: (source) =>
      ![".terraform", "node_modules"].includes(path.basename(source)) &&
      !/\.tfstate|\.tfplan/u.test(source),
  });
  // Fail closed for HTTP requests; local plugin RPC remains allowed.
  const offlineEnv = {
    ...env,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "localhost,127.0.0.1,[::1]",
  };
  const tofuDirectory = path.join(temporary, "infra/opentofu");
  await withProviderIpc(tofuDirectory, async (ipc) => {
    const providerEnv = { ...(mirror ? offlineEnv : env), TMPDIR: ipc };
    const providerOptions = { cwd: tofuDirectory, env: providerEnv };
    run("tofu", [`-chdir=${tofuDirectory}`, "fmt", "-check", "-recursive"], providerOptions);
    // Always installs into a new, empty TF_DATA_DIR, including in a fresh checkout. From the mirror
    // this runs offline; otherwise it is the sole network phase: registry metadata, signatures and
    // provider releases.
    run(
      "tofu",
      [
        `-chdir=${tofuDirectory}`,
        "init",
        "-backend=false",
        "-input=false",
        "-lockfile=readonly",
        "-no-color",
      ],
      providerOptions,
    );
    // Validate performs schema/type checking, never plan, refresh or provider Configure.
    run("tofu", [`-chdir=${tofuDirectory}`, "validate", "-no-color"], {
      cwd: tofuDirectory,
      env: { ...offlineEnv, TMPDIR: ipc },
    });
  });
  for (const environment of environments) {
    run(
      path.join(root, "node_modules/.bin/wrangler"),
      [
        "deploy",
        "--dry-run",
        "--config",
        `infra/wrangler/${environment}.json`,
        "--outdir",
        path.join(temporary, `worker-${environment}`),
      ],
      { env: offlineEnv },
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(
  `infrastructure validated with lock-file-verified providers from ${mirror ?? "the public registry"}; no resources created`,
);
