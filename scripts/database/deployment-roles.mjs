import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The role keys deployment-grants.sql creates with SQL, each with a generated password: every
// declared role but the migration role, which is the only Neon API role.
export const restrictedRoleKeys = [
  "runtime",
  "support",
  "backup",
  "authentication",
  "management",
  "worldAuthorization",
];

// psql's standard input for deployment-grants.sql: one `\set password_<key>` line per restricted
// role, then the reviewed SQL. Only letters and digits are accepted, so a password can neither end
// its quoted value nor start a psql meta-command, and it never needs escaping.
export async function deploymentRolesInput(passwords) {
  const lines = restrictedRoleKeys.map((key) => {
    const password = passwords[key];
    assert(
      typeof password === "string" && /^[A-Za-z0-9]{32,128}$/u.test(password),
      `generated ${key} role password must be 32 to 128 letters and digits`,
    );
    return `\\set password_${key} '${password}'`;
  });
  const sql = await readFile(new URL("./deployment-grants.sql", import.meta.url), "utf8");
  return `${lines.join("\n")}\n${sql}`;
}

// The named role-check failures in psql's error output, for release logs. Only the checks' own
// messages are kept, reduced to role-name characters; nothing else psql printed is echoed.
export function roleCheckFailures(stderr) {
  return [...String(stderr ?? "").matchAll(/ERROR: +clockgrove role check: ([^\n]*)/gu)]
    .map(([, said]) => said.replace(/[^A-Za-z0-9_, ()]/gu, "").slice(0, 200))
    .join("; ");
}
