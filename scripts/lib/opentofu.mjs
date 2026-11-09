// Credential-free OpenTofu setup shared by infra:validate and the zero-resource infra:plan: the
// lock-file-pinned providers, an isolated CLI configuration and an environment with no user state.
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// The lock file pins every provider's version and package hashes; `tofu init -lockfile=readonly`
// refuses any package whose hash it lacks, whichever source supplied it.
export async function lockedProviders(root) {
  const lock = await readFile(path.join(root, "infra/opentofu/.terraform.lock.hcl"), "utf8");
  const locked = [...lock.matchAll(/^provider "([^"]+)" \{\n {2}version += "([^"]+)"$/gmu)].map(
    ([, source, version]) => ({ source, version }),
  );
  if (locked.length === 0) throw new Error("infra/opentofu/.terraform.lock.hcl pins no providers");
  return locked;
}

// A mirror filled by `scripts/ci/toolchain.sh opentofu-providers`, beside the tofu on PATH, so
// installation runs without network. Used only when it holds every locked version for this platform.
export function providerMirror(locked) {
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

// Fails closed for HTTP requests; local plugin RPC remains allowed.
export const offline = {
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "localhost,127.0.0.1,[::1]",
};

// No user CLI config, provider caches, credentials, backend or TF_VARs. The only source is the
// lock-file-verified mirror or the public registry, never both: a mirror miss cannot fall back.
// `temporary` is a new private directory. Returns the environment and the mirror used.
export async function isolatedTofu(root, temporary) {
  await mkdir(path.join(temporary, "home"));
  const locked = await lockedProviders(root);
  const mirror = providerMirror(locked);
  const sources = JSON.stringify(locked.map(({ source }) => source));
  const installation = mirror
    ? `filesystem_mirror {\n    path = ${JSON.stringify(mirror)}\n    include = ${sources}\n  }`
    : `direct {\n    include = ${sources}\n  }`;
  const cliConfig = path.join(temporary, "tofurc");
  await writeFile(cliConfig, `provider_installation {\n  ${installation}\n}\n`);
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(temporary, "home"),
    TMPDIR: temporary,
    TF_CLI_CONFIG_FILE: cliConfig,
    TF_DATA_DIR: path.join(temporary, "providers"),
    TF_IN_AUTOMATION: "1",
    CHECKPOINT_DISABLE: "1",
    CLOUDFLARE_SEND_METRICS: "false",
    WRANGLER_SEND_METRICS: "false",
    CI: "true",
  };
  return { env, mirror };
}
