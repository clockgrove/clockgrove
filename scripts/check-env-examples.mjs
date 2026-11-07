// Example environment files (Wave 0 plan §6, issue 842): `.env.example` and `.dev.vars.example` at the
// repository root list every secret name of the catalog `requiredSecrets` (infra/check-configuration.mjs)
// with no value. `.dev.vars.example` holds the Worker secret bindings `runtimeBindingManifest`
// declares; `.env.example` holds the other, operator and tooling, names. Each name's comment gives
// its catalog consumer and the first clause of its row in docs/runbooks/infrastructure.md. The files
// are generated here and must equal the generated text byte for byte:
// `node scripts/check-env-examples.mjs --write` rewrites them.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentSurface, requiredSecrets } from "../infra/check-configuration.mjs";

const runbook = "docs/runbooks/infrastructure.md";
const entry = /^([A-Z][A-Z0-9_]*)=(.*)$/u;

const headers = {
  ".env.example": [
    "# Operator and tooling secret names of the hosted environments (development, staging, production).",
    "# Names only: never write a value here. local and ci declare no secrets and need none of these.",
    "# Supply each from the operator's secret manager session, never from a committed file.",
    "# Worker secret bindings are in .dev.vars.example.",
  ],
  ".dev.vars.example": [
    "# Worker secret bindings that runtimeBindingManifest declares (apps/runtime/src/cloudflare-entry.ts).",
    "# Names only: never write a value here. local and ci declare no secrets and need none of these.",
    "# Hosted environments receive them as Worker secrets set from the operator's secret manager",
    "# session (for example wrangler secret put <NAME> --config infra/wrangler/<environment>.json),",
    "# never through a .dev.vars file: Wrangler reads infra/wrangler/.dev.vars only for local",
    "# wrangler dev and wrangler types. Never write a hosted value into a .dev.vars file.",
    "# Operator and tooling names are in .env.example.",
  ],
};
const generated = [
  "# Generated from requiredSecrets in infra/check-configuration.mjs and the secret table of",
  `# ${runbook} by scripts/check-env-examples.mjs (--write); pnpm check refuses drift.`,
];

// The first clause of each row's description in the secret table (from its `| Name | Consumer /
// source |` header to the first non-table line), without Markdown code or link syntax.
export function runbookDescriptions(source) {
  const lines = source.split("\n");
  const start = lines.indexOf("| Name | Consumer / source |");
  if (start === -1 || lines[start + 1] !== "| --- | --- |")
    throw new Error(`${runbook} has no | Name | Consumer / source | secret table`);
  const rows = new Map();
  for (const [offset, line] of lines.slice(start + 2).entries()) {
    if (!line.startsWith("|")) break;
    const row = /^\| `([A-Z][A-Z0-9_]*)` \| (.+?) \|$/u.exec(line);
    const at = `${runbook}:${start + 3 + offset}`;
    if (!row) throw new Error(`${at}: secret table row is not | \`NAME\` | description |`);
    if (rows.has(row[1])) throw new Error(`${at}: secret table lists ${row[1]} twice`);
    const clause = row[2].split(/; |: /u)[0].replace(/\.$/u, "");
    rows.set(row[1], `${clause.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1").replaceAll("`", "")}.`);
  }
  return rows;
}

// The generated text of each example and the names it holds, in catalog order.
export function environmentExamples(catalog, workerSecrets, descriptions) {
  const names = Object.keys(catalog);
  for (const name of workerSecrets)
    if (!names.includes(name)) throw new Error(`Worker secret ${name} is not in requiredSecrets`);
  if (JSON.stringify([...descriptions.keys()]) !== JSON.stringify(names))
    throw new Error(
      `${runbook} secret table must list exactly the requiredSecrets names, in order`,
    );
  const files = {
    ".env.example": names.filter((name) => !workerSecrets.includes(name)),
    ".dev.vars.example": names.filter((name) => workerSecrets.includes(name)),
  };
  return new Map(
    Object.entries(files).map(([file, held]) => [
      file,
      {
        names: held,
        text: [
          ...headers[file],
          ...generated,
          ...held.flatMap((name) => [
            "",
            `# ${catalog[name]}: ${descriptions.get(name)}`,
            `${name}=`,
          ]),
          "",
        ].join("\n"),
      },
    ]),
  );
}

// Problems of the examples `read` returns against `expected`. A value is never echoed.
export function environmentExampleProblems(expected, read) {
  const problems = [];
  const found = new Map();
  for (const file of expected.keys()) {
    const text = read(file);
    if (text === undefined) {
      problems.push(`${file}: missing`);
      continue;
    }
    const names = [];
    text.split("\n").forEach((line, index) => {
      if (line === "" || line.startsWith("#")) return;
      const match = entry.exec(line);
      if (!match) problems.push(`${file}:${index + 1}: neither a comment nor an empty NAME= entry`);
      else {
        if (match[2] !== "") problems.push(`${file}:${index + 1}: ${match[1]} has a value`);
        if (names.includes(match[1])) problems.push(`${file}: ${match[1]} is listed twice`);
        names.push(match[1]);
      }
    });
    found.set(file, names);
  }
  for (const [file, { names }] of expected) {
    const held = found.get(file);
    if (!held) continue;
    for (const name of held) {
      const owner = [...expected].find(([, other]) => other.names.includes(name))?.[0];
      if (!owner) problems.push(`${file}: ${name} is not in requiredSecrets`);
      else if (owner !== file) problems.push(`${file}: ${name} belongs in ${owner}`);
    }
    for (const name of names)
      if (![...found.values()].some((other) => other.includes(name)))
        problems.push(`${file}: ${name} is missing`);
  }
  if (problems.length === 0)
    for (const [file, { text }] of expected)
      if (read(file) !== text)
        problems.push(
          `${file}: differs from the generated text; run node scripts/check-env-examples.mjs --write`,
        );
  return problems;
}

function examplesOf(root) {
  return environmentExamples(
    requiredSecrets,
    deploymentSurface(readFileSync(path.join(root, "apps/runtime/src/cloudflare-entry.ts"), "utf8"))
      .manifest.secrets,
    runbookDescriptions(readFileSync(path.join(root, runbook), "utf8")),
  );
}

export function checkEnvironmentExamples(root) {
  const problems = environmentExampleProblems(examplesOf(root), (file) => {
    try {
      return readFileSync(path.join(root, file), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  });
  if (problems.length) throw new Error(`example environment files drift:\n${problems.join("\n")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv.includes("--write"))
    for (const [file, { text }] of examplesOf(root)) writeFileSync(path.join(root, file), text);
  checkEnvironmentExamples(root);
  console.log("example environment files match the secret catalog");
}
