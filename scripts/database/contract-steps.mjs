import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Contract steps (docs/runbooks/database.md, "expand → backfill → verify → switch → contract"). A
// migration that deletes, truncates or drops clockgrove data, or rewrites an append-only table, runs
// only when `contract-steps.json` beside it declares it: the exact bytes it was reviewed at (SHA-256,
// the checksum `clockgrove.schema_migrations` records), the statements that destroy data, the restore
// point the deploy needs first and the issue or pull request that approved its release.
//
// The check reads what a migration runs: its statements, the bodies of its DO blocks (with or without
// a LANGUAGE clause), every string literal and every other dollar-quoted string (so SQL handed to
// EXECUTE is read, nested ones included), and the body of every function or procedure that it calls,
// by name, when this or an earlier migration created it (followed through the functions that body
// calls). It does not read SQL assembled at run time from pieces, or a trigger function, which runs
// on a later write and is reviewed as code.

export const CONTRACT_STEPS_FILE = "contract-steps.json";

/**
 * Append-only tables: the runtime may never update them (0006, 0012, 0013) and their rows are
 * canonical journal, authority or artifact records, so a migration that rewrites one is a contract
 * step. Event payloads evolve through upcasters, never rewrites (docs/runbooks/database.md).
 */
const APPEND_ONLY = String.raw`clockgrove\.(?:events|authority_decisions|artifact_references|snapshots)\b`;

/** Destroys data wherever it appears in a statement. */
const destroysAnywhere = [
  /\bDELETE\s+FROM\b/iu,
  // Not a trigger event or a privilege: `BEFORE TRUNCATE ON`, `UPDATE OR TRUNCATE OR …`.
  /\bTRUNCATE\s+(?!(?:ON|OR)\b)/iu,
  new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?${APPEND_ONLY}`, "iu"),
  // Replica mode skips the triggers that keep journal tables immutable.
  /(?<!\bRESET\s+)\bsession_replication_role\b(?!\s*(?:=|\bTO\b)\s*(?:DEFAULT|origin)\b)/iu,
];

/** Destroys data as a statement of its own, at its start or after a PL/pgSQL BEGIN, THEN, ELSE or LOOP. */
const destroysAsStatement = [
  /^DROP\s+(?:TABLE|SCHEMA|DATABASE|OWNED|MATERIALIZED\s+VIEW)\b/iu,
  /^DROP\b.*\bCASCADE\b/isu,
  /^ALTER\s+TABLE\b.*\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|EXPRESSION\b|IDENTITY\b)/isu,
  new RegExp(
    String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${APPEND_ONLY}.*\bALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b`,
    "isu",
  ),
];

/** `CREATE [OR REPLACE] FUNCTION|PROCEDURE <name>(`, capturing the name. */
const CREATES_ROUTINE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+((?:[\w$]+\.)?[\w$]+)\s*\(/iu;

/**
 * The statements of `sql` that destroy data, whitespace collapsed, in order, then those of each
 * routine it calls, as `<routine>(): <statement>`. `routines` holds the routines earlier migrations
 * created, by lower-case name without schema; this migration's are added to it.
 */
export function destructiveStatements(sql, routines = new Map()) {
  const { text, pieces, functions } = scan(sql);
  const known = [...routines.values(), ...functions];
  for (const routine of functions) routines.set(routine.key, routine);
  return [...new Set(destroysOf([text, ...pieces], known, new Set()))];
}

/** What `executed` destroys itself, then through each of `routines` that it calls. */
function destroysOf(executed, routines, visiting) {
  const found = executed.flatMap((text) => text.split(";").flatMap(destroyingStatement));
  for (const routine of routines) {
    if (visiting.has(routine) || !executed.some((text) => routine.call.test(text))) continue;
    visiting.add(routine);
    const body = scan(routine.body);
    for (const statement of destroysOf([body.text, ...body.pieces], routines, visiting))
      found.push(`${routine.name}(): ${statement}`);
    visiting.delete(routine);
  }
  return found;
}

/** `statement` collapsed and without leading PL/pgSQL block words, if it destroys data. */
function destroyingStatement(statement) {
  const text = statement
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:(?:BEGIN|THEN|ELSE|LOOP)\s+)+/iu, "");
  const starts = [
    0,
    ...[...text.matchAll(/\b(?:BEGIN|THEN|ELSE|LOOP)\b/giu)].map((m) => m.index + m[0].length),
  ];
  const destroys =
    destroysAnywhere.some((pattern) => pattern.test(text)) ||
    starts.some((start) => {
      const rest = text.slice(start).trim();
      return destroysAsStatement.some((pattern) => pattern.test(rest));
    });
  return destroys ? [text] : [];
}

/**
 * What `sql` runs now. `text` is `sql` without comments, each string literal and dollar-quoted string
 * blanked to `''`, except a DO block's body, which is inlined. `pieces` holds the executed text of
 * every literal and every other dollar-quoted string, so SQL handed to EXECUTE is read. `functions`
 * holds the routines `sql` creates, whose bodies run only when called.
 */
function scan(sql) {
  let text = "";
  const pieces = [];
  const functions = [];
  const add = (inner) => {
    pieces.push(...inner.pieces);
    functions.push(...inner.functions);
  };
  let index = 0;
  while (index < sql.length) {
    const rest = sql.slice(index);
    const dollar = rest.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u);
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      index += end === -1 ? rest.length : end;
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      index += end === -1 ? rest.length : end + 2;
    } else if (rest.startsWith("'")) {
      const literal = rest.match(/^'(?:[^']|'')*'?/u)[0];
      const inner = scan(literal.slice(1, -1).replaceAll("''", "'"));
      pieces.push(inner.text);
      add(inner);
      text += "''";
      index += literal.length;
    } else if (dollar) {
      const tag = dollar[0];
      const end = rest.indexOf(tag, tag.length);
      const body = rest.slice(tag.length, end === -1 ? rest.length : end);
      const statement = text.slice(text.lastIndexOf(";") + 1);
      const created = statement.match(CREATES_ROUTINE);
      if (/\bDO(?:\s+LANGUAGE\s+(?:\w+|''))?\s*$/iu.test(text)) {
        const inner = scan(body);
        text += `; ${inner.text};`;
        add(inner);
      } else if (created && /\bAS\s*$/iu.test(statement)) {
        functions.push(routine(created[1], body));
        text += "''";
      } else {
        const inner = scan(body);
        pieces.push(inner.text);
        add(inner);
        text += "''";
      }
      index += tag.length + body.length + (end === -1 ? 0 : tag.length);
    } else {
      text += sql[index];
      index += 1;
    }
  }
  return { text, pieces, functions };
}

/**
 * A routine named `name` with `body`. `call` finds a call of it: its name, schema-qualified or not,
 * followed by `(`, but not where FUNCTION, PROCEDURE or ROUTINE names it (CREATE, ALTER, DROP,
 * COMMENT ON, GRANT ON or a trigger's EXECUTE FUNCTION).
 */
function routine(name, body) {
  const key = name.split(".").at(-1).toLowerCase();
  const call = new RegExp(
    String.raw`(?<!\b(?:FUNCTION|PROCEDURE|ROUTINE)\s+(?:IF\s+EXISTS\s+)?)(?<![\w$."])(?:[\w$]+\.)?${key.replaceAll("$", "\\$")}\s*\(`,
    "iu",
  );
  return { name, key, body, call };
}

/**
 * Refuses, before anything is applied, any of `names` in `directory` that destroys data without a
 * matching declaration, and any declaration that names no such migration or another set of bytes.
 * Migrations are read in name order, so a call reaches a routine an earlier one created.
 */
export async function assertContractSteps(directory, names) {
  const declared = await readFile(path.join(directory, CONTRACT_STEPS_FILE), "utf8").then(
    JSON.parse,
    (error) => {
      if (error.code === "ENOENT") return {};
      throw error;
    },
  );
  const problems = [];
  const routines = new Map();
  for (const name of [...names].sort()) {
    const sql = await readFile(path.join(directory, name), "utf8");
    const destroys = destructiveStatements(sql, routines);
    const step = declared[name];
    if (destroys.length === 0 && step === undefined) continue;
    if (step === undefined) {
      problems.push(`${name} is an undeclared contract step: ${destroys.join("; ")}`);
      continue;
    }
    const sha256 = createHash("sha256").update(sql).digest("hex");
    if (step.sha256 !== sha256) problems.push(`${name} differs from its declared bytes`);
    if (JSON.stringify(step.destroys) !== JSON.stringify(destroys))
      problems.push(`${name} destroys ${JSON.stringify(destroys)}, not its declared statements`);
    if (typeof step.restorePoint !== "string" || step.restorePoint.trim() === "")
      problems.push(`${name} declares no restore point`);
    if (typeof step.releaseApproval !== "string" || !/^#\d+$/u.test(step.releaseApproval))
      problems.push(`${name} declares no release approval (#<issue or pull request>)`);
  }
  for (const name of Object.keys(declared))
    if (!names.includes(name)) problems.push(`${CONTRACT_STEPS_FILE} declares unknown ${name}`);
  if (problems.length > 0) throw new Error(`contract-step check failed:\n${problems.join("\n")}`);
}
