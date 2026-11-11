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

// Why the role SQL failed, for release logs. The checks' own messages come first, reduced to
// role-name characters. Without one, PostgreSQL's own first error lines are kept instead: their
// text names roles, objects and SQLSTATE causes, never a password (passwords reach the server only
// as bound parameters), and any token long enough to be one is redacted anyway.
export function roleCheckFailures(stderr) {
  const text = String(stderr ?? "");
  const named = [...text.matchAll(/ERROR: +clockgrove role check: ([^\n]*)/gu)]
    .map(([, said]) => said.replace(/[^A-Za-z0-9_, ()]/gu, "").slice(0, 200))
    .join("; ");
  if (named) return named;
  return [...text.matchAll(/(?:ERROR|FATAL): +([^\n]*)/gu)]
    .slice(0, 2)
    .map(([, said]) =>
      said
        .replace(/[A-Za-z0-9_+/=.-]{24,}/gu, "<redacted>")
        .replace(/[^A-Za-z0-9_ ,.:()"'<>=-]/gu, "")
        .slice(0, 200),
    )
    .join("; ");
}
