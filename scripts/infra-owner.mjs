// `pnpm infra:owner <command>`: helpers for the owner's deployment setup. They compute digests,
// write UNSIGNED payloads for the owner to read and sign, and assemble a signed envelope after
// verifying it. They never generate or use a private key, and never sign.
//
//   key-digest <public-key.pem>
//       OWNER_ACCEPTANCE_PUBLIC_KEY_DIGEST of an Ed25519 public key file.
//   configuration-digest <environment> <backend.json> <encryption.json>
//       INFRA_CONFIGURATION_DIGEST, after the checks the deploy makes on both files.
//   recovery-payload <environment> --configuration-digest <digest> --operator <name>
//                    --evidence <text> --out <file>
//       The first-deploy recovery payload: no state, no owned resources, an empty environment.
//   review-payload --commit <sha> --reviewer <name> --evidence <text> --outcome passed|refused
//                  --out <file>
//       The independent review payload for one exact candidate, with every required scope.
//   envelope <payload> <signature> --key <public-key.pem> --key-digest <digest> --out <file>
//       The signed envelope the deploy reads, written only once the signature verifies.
//
// Files are written outside the checkout only: they are external facts, never committed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  authenticatedFact,
  configurationDigest,
  externalStateConfiguration,
  reviewScope,
} from "./ci/deployment-authority.mjs";
import { digest, root } from "./ci/evidence.mjs";

const hosted = ["development", "staging"];

export async function keyDigest(file) {
  const bytes = await readFile(file);
  assert(!bytes.toString().includes("PRIVATE KEY"), "give the public key file, never the private");
  assert.equal(createPublicKey(bytes).asymmetricKeyType, "ed25519", "an Ed25519 key is required");
  return digest(bytes);
}

export async function checkedConfigurationDigest(target, backendFile, encryptionFile) {
  assert(hosted.includes(target), `the environment is one of ${hosted.join(", ")}`);
  const pinned = configurationDigest(await readFile(backendFile), await readFile(encryptionFile));
  await externalStateConfiguration(target, backendFile, encryptionFile, pinned);
  return pinned;
}

// The payload deploy.mjs requires for fresh provisioning.
export function recoveryPayload({ environment, configurationDigest, operator, evidence }) {
  assert(hosted.includes(environment), `the environment is one of ${hosted.join(", ")}`);
  assert(/^sha256:[0-9a-f]{64}$/u.test(configurationDigest ?? ""), "a configuration digest");
  assert(operator?.trim() && evidence?.trim(), "the operator and the evidence are required");
  return {
    environment,
    configurationDigest,
    operator,
    evidence,
    statePresent: false,
    restoredStateDigest: null,
    ownedResources: [],
    emptyEnvironmentVerified: true,
  };
}

// The payload verifyReview requires. The tree is the commit's own; the outcome is the reviewer's.
export function reviewPayload({ commit, reviewer, evidence, outcome }) {
  assert(/^[0-9a-f]{40}$/u.test(commit ?? ""), "the full candidate commit SHA");
  assert(["passed", "refused"].includes(outcome), "the outcome is passed or refused");
  assert(reviewer?.trim() && evidence?.trim(), "the reviewer and the evidence are required");
  const tree = execFileSync("git", ["rev-parse", `${commit}^{tree}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { commit, tree, reviewer, independent: true, evidence, outcome, scope: reviewScope };
}

export async function envelope(payloadFile, signatureFile, keyFile, pinnedKey, out) {
  const signature = await readFile(signatureFile);
  assert.equal(signature.length, 64, "the signature file holds the raw 64-byte Ed25519 signature");
  const sealed = {
    payload: (await readFile(payloadFile)).toString("base64"),
    signature: signature.toString("base64"),
  };
  await writeOutside(out, `${JSON.stringify(sealed)}\n`);
  try {
    await authenticatedFact(out, keyFile, pinnedKey);
  } catch (error) {
    await rm(out, { force: true });
    throw error;
  }
}

async function writeOutside(file, text) {
  assert(file && path.isAbsolute(file), "--out takes an absolute path");
  const directory = await realpath(path.dirname(file));
  assert(
    directory !== root && !directory.startsWith(`${root}/`),
    "--out must be outside the checkout: these are external facts, never committed",
  );
  await writeFile(file, text, { flag: "wx", mode: 0o600 });
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: Object.fromEntries(
      [
        "configuration-digest",
        "operator",
        "evidence",
        "commit",
        "reviewer",
        "outcome",
        "key",
        "key-digest",
        "out",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  const [command, ...rest] = positionals;
  const payload = (value) => `${JSON.stringify(value, null, 2)}\n`;
  switch (command) {
    case "key-digest":
      return console.log(await keyDigest(rest[0]));
    case "configuration-digest":
      return console.log(await checkedConfigurationDigest(rest[0], rest[1], rest[2]));
    case "recovery-payload":
      await writeOutside(
        values.out,
        payload(
          recoveryPayload({
            environment: rest[0],
            configurationDigest: values["configuration-digest"],
            operator: values.operator,
            evidence: values.evidence,
          }),
        ),
      );
      return console.log(
        `wrote the unsigned recovery payload to ${values.out}; read it, then sign`,
      );
    case "review-payload":
      await writeOutside(values.out, payload(reviewPayload(values)));
      return console.log(`wrote the unsigned review payload to ${values.out}; read it, then sign`);
    case "envelope":
      await envelope(rest[0], rest[1], values.key, values["key-digest"], values.out);
      return console.log(`signature verified; wrote the envelope to ${values.out}`);
    default:
      throw new assert.AssertionError({
        message:
          "use key-digest, configuration-digest, recovery-payload, review-payload or envelope (see scripts/infra-owner.mjs)",
      });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2)).catch((error) => {
    console.error(`infra:owner: ${error.message.split("\n")[0]}`);
    process.exitCode = 1;
  });
