// Migration preview of the playground (issue 327): `node scripts/playground-migration-preview.mjs
// <directory> <packId> <fromVersion>` plans the migration of a world running <packId>@<fromVersion>
// onto the pack in <directory>, and prints one JSON line. Exit 0: the ordered steps. Exit 1: a refusal
// (`not_a_pack`, `different_pack`, `not_newer` or `migration_refused`). It only reads the directory.
import "../packages/simulator/cli/typescript-hooks.mjs";

const [directory, packId, fromVersion] = process.argv.slice(2);
const { readPackDirectory, sdkSource } = await import("../packages/simulator/cli/pack-source.ts");
const { packPorts } = await import("../packages/simulator/cli/ports.ts");
const { planWorldPackMigration, validateWorldPack } = await import(
  "../packages/world-pack-sdk/src/index.ts"
);

const print = (document, code) => {
  process.stdout.write(
    `${JSON.stringify(document, (_key, value) => (typeof value === "bigint" ? String(value) : value))}\n`,
  );
  process.exit(code);
};
const refuse = (error, message, refusal) =>
  print({ error, message, ...(refusal === undefined ? {} : { refusal }) }, 1);
const refusalOf = (error) => ({
  code: String(error.code ?? error.name),
  path: String(error.path ?? ""),
  message: error.message,
});

const versionParts = (version) => version.split(".").map(Number);
const isNewer = (candidate, base) => {
  const [a, b] = [versionParts(candidate), versionParts(base)];
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
};

if (!directory || !packId || !fromVersion) {
  process.stderr.write(
    "Usage: playground-migration-preview.mjs <directory> <packId> <fromVersion>\n",
  );
  process.exit(2);
}

let validated;
try {
  const source = sdkSource(await readPackDirectory(directory));
  validated = await validateWorldPack(source, packPorts);
} catch (error) {
  refuse("not_a_pack", "The directory is not a readable world pack.", refusalOf(error));
}
if (!validated.ok)
  refuse("not_a_pack", "The directory is not a valid world pack.", validated.error);

const pack = validated.value;
if (pack.id !== packId) refuse("different_pack", `The directory holds ${pack.id}, not ${packId}.`);
if (!isNewer(pack.version, fromVersion))
  refuse("not_newer", `Version ${pack.version} is not newer than ${fromVersion}.`);

const plan = planWorldPackMigration(pack, fromVersion, 0);
if (!plan.ok)
  refuse(
    "migration_refused",
    "The pack declares no migration from the running version.",
    plan.error,
  );
print(
  {
    packId,
    fromVersion,
    toVersion: pack.version,
    steps: plan.value.map(({ stepId, fromPackVersion, toPackVersion, type, version, payload }) => ({
      stepId,
      fromPackVersion,
      toPackVersion,
      type,
      version,
      payload,
    })),
  },
  0,
);
