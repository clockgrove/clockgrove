import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Contract steps (docs/runbooks/database.md, "expand → backfill → verify → switch → contract"). A
// migration that deletes, truncates, drops or rewrites clockgrove data runs only when
// `contract-steps.json` beside it declares it: the exact bytes it was reviewed at (SHA-256, the
// checksum `clockgrove.schema_migrations` records), the statements that destroy data, the restore
// point the deploy needs first and the issue or pull request that approved its release.
//
// The check walks PostgreSQL's own parse tree (`libpg-query`, libpg_query built from the PostgreSQL 18
// parser), so it sees a statement however it is written. It reads the migration's statements; the
// body of each DO block; every string constant that parses as SQL (format placeholders filled in
// first), so SQL handed to EXECUTE is read, nested ones included; every SQL or PL/pgSQL expression in
// a PL/pgSQL body; and the body of each function or procedure the migration calls by name, when this
// or an earlier migration created it (followed through the routines that body calls). It does not read
// SQL assembled at run time from pieces, or a trigger function, which runs on a later write and is
// reviewed as code. A migration that does not parse cannot be verified and is refused.

export const CONTRACT_STEPS_FILE = "contract-steps.json";

/**
 * Append-only tables: the runtime may never update them (0006, 0012, 0013) and their rows are
 * canonical journal, authority or artifact records, so a migration that rewrites one is a contract
 * step. Event payloads evolve through upcasters, never rewrites (docs/runbooks/database.md).
 */
const APPEND_ONLY = new Set(["events", "authority_decisions", "artifact_references", "snapshots"]);

const appendOnly = (relation) =>
  relation?.schemaname === "clockgrove" && APPEND_ONLY.has(relation.relname);

const stringOf = (constant) => constant?.A_Const?.sval?.sval;

/** Replica mode skips the triggers that keep journal tables immutable. */
const isSafeRole = (value) => ["default", "origin"].includes(String(value).toLowerCase());

const setsReplicaRole = (node) =>
  node?.name === "session_replication_role" &&
  !(
    node.kind === "VAR_SET_DEFAULT" ||
    node.kind === "VAR_RESET" ||
    (node.kind === "VAR_SET_VALUE" && isSafeRole(stringOf(node.args?.[0])))
  );

/** Node types that destroy data, by the parse-tree key; each returns whether `node` does. */
const DESTROYS = {
  DeleteStmt: () => true,
  TruncateStmt: () => true,
  DropdbStmt: () => true,
  DropOwnedStmt: () => true,
  UpdateStmt: (node) => appendOnly(node.relation),
  MergeStmt: (node) =>
    (node.mergeWhenClauses ?? []).some(
      ({ MergeWhenClause: clause }) =>
        clause.commandType === "CMD_DELETE" ||
        (clause.commandType === "CMD_UPDATE" && appendOnly(node.relation)),
    ),
  InsertStmt: (node) =>
    node.onConflictClause?.action === "ONCONFLICT_UPDATE" && appendOnly(node.relation),
  DropStmt: (node) =>
    node.behavior === "DROP_CASCADE" ||
    ["OBJECT_TABLE", "OBJECT_SCHEMA", "OBJECT_MATVIEW", "OBJECT_FOREIGN_TABLE"].includes(
      node.removeType,
    ),
  // A dropped column loses its data and a type change rewrites every row.
  AlterTableStmt: (node) =>
    (node.cmds ?? []).some(({ AlterTableCmd: command }) =>
      ["AT_DropColumn", "AT_AlterColumnType"].includes(command.subtype),
    ),
  VariableSetStmt: setsReplicaRole,
  // The tree holds the statement itself, not a wrapped node.
  AlterRoleSetStmt: (node) => setsReplicaRole(node.setstmt),
  AlterDatabaseSetStmt: (node) => setsReplicaRole(node.setstmt),
  FuncCall: (node) =>
    lastName(node.funcname) === "set_config" &&
    stringOf(node.args?.[0])?.toLowerCase() === "session_replication_role" &&
    !isSafeRole(stringOf(node.args?.[1])),
};

// Loaded on first use, not at import: `scripts/bootstrap.mjs` reaches this module through
// `lib.mjs` before `pnpm install` has put `libpg-query` in node_modules.
let loaded;
let pg;

const lastName = (names) => names?.at(-1)?.String?.sval?.toLowerCase();

/**
 * The statements of `sql` that destroy data, whitespace collapsed, in order, then those of each
 * routine it calls, as `<routine>(): <statement>`. `routines` holds the routines earlier migrations
 * created, by lower-case name without schema; this migration's are added to it. Throws when `sql`
 * does not parse.
 */
export async function destructiveStatements(sql, routines = new Map()) {
  loaded ??= import("libpg-query").then(async (module) => {
    await module.loadModule();
    pg = module;
  });
  await loaded;
  const ctx = { found: [], called: new Set(), created: [], strict: true };
  analyzeSql(sql, ctx);
  const known = [...routines.values(), ...ctx.created];
  for (const created of ctx.created) routines.set(created.key, created);
  return [...new Set(reach(ctx, known, new Set()))];
}

/** What `ctx` found, then what each of `routines` that it calls destroys. */
function reach(ctx, routines, visiting) {
  const found = [...ctx.found];
  for (const routine of routines) {
    if (visiting.has(routine) || !ctx.called.has(routine.key)) continue;
    visiting.add(routine);
    for (const statement of reach(bodyOf(routine), routines, visiting))
      found.push(`${routine.name}(): ${statement}`);
    visiting.delete(routine);
  }
  return found;
}

function bodyOf(routine) {
  const ctx = { found: [], called: new Set(), created: [], strict: true };
  if (routine.language === "plpgsql") analyzePlpgsql(routine.text, ctx);
  else if (routine.language === "sql" && routine.body !== undefined) analyzeSql(routine.body, ctx);
  if (routine.sqlBody) visit(routine.sqlBody, routine.text, ctx);
  return ctx;
}

/**
 * Parses `sql` and visits its statements. `original` is the text that was parsed from, same byte for
 * byte in length, which statements are reported from; `whole` reports every statement as that text.
 * A text that does not parse throws when `ctx.strict`, else it is not SQL and returns false.
 */
function analyzeSql(sql, ctx, original = sql, whole = undefined) {
  let tree;
  try {
    tree = pg.parseSync(sql);
  } catch (error) {
    if (ctx.strict) throw error;
    return false;
  }
  const bytes = Buffer.from(original);
  for (const { stmt, stmt_location: start = 0, stmt_len: length } of tree.stmts ?? []) {
    const end = length ? start + length : bytes.length;
    visit(stmt, whole ?? bytes.subarray(start, end).toString(), ctx);
  }
  return true;
}

/**
 * `statement` without comments, each string literal and dollar-quoted string blanked to `''` (its
 * `E`, `B`, `X`, `N` or `U&` prefix kept), whitespace collapsed and without its trailing `;`.
 */
function readable(statement) {
  const bytes = Buffer.from(statement);
  let text = "";
  let at = 0;
  for (const token of pg.scanSync(statement).tokens ?? []) {
    const source = bytes.subarray(token.start, token.end).toString();
    const literal = /^(?:[EeBbXxNn]|[Uu]&)?'/u.exec(source);
    let replacement;
    if (token.tokenName.endsWith("COMMENT")) replacement = " ";
    else if (literal || /^U?[SBX]CONST$/u.test(token.tokenName))
      replacement = `${literal?.[0].slice(0, -1) ?? ""}''`;
    else continue;
    text += `${bytes.subarray(at, token.start)}${replacement}`;
    at = token.end;
  }
  text += bytes.subarray(at);
  return text.replace(/\s+/gu, " ").trim().replace(/;$/u, "").trim();
}

/** Records what the parse-tree `node`, part of the statement whose source is `text`, destroys, calls or creates. */
function visit(node, text, ctx) {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, text, ctx);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (DESTROYS[key]?.(value)) ctx.found.push(readable(text));
    if (key === "FuncCall") ctx.called.add(lastName(value.funcname));
    else if (key === "A_Const" && typeof value.sval?.sval === "string")
      analyzeString(value.sval.sval, { ...ctx, strict: false });
    else if (key === "DoStmt") analyzePlpgsql(text, ctx);
    else if (key === "CreateFunctionStmt") ctx.created.push(createdRoutine(value, text));
    if (key !== "sqlBody") visit(value, text, ctx);
  }
}

function createdRoutine(node, text) {
  const options = Object.fromEntries(
    node.options.map(({ DefElem: option }) => [option.defname, option.arg]),
  );
  return {
    name: node.funcname.map((part) => part.String.sval).join("."),
    key: lastName(node.funcname),
    language: options.language?.String?.sval?.toLowerCase(),
    body: options.as?.List?.items?.[0]?.String?.sval,
    sqlBody: node.sqlBody,
    text,
  };
}

/** A string constant that parses as SQL, once format placeholders hold a place, length for length. */
function analyzeString(value, ctx) {
  const sql = value.replace(/%%|%(?:\d+\$)?[-\d]*[IsL]/gu, (placeholder) => {
    if (placeholder === "%%") return "% ";
    return placeholder.endsWith("L")
      ? "$1".padEnd(placeholder.length)
      : "z".repeat(placeholder.length);
  });
  analyzeSql(sql, ctx, value);
}

/** The SQL and expressions of a PL/pgSQL body: a DO statement or a CREATE FUNCTION or PROCEDURE. */
function analyzePlpgsql(statement, ctx) {
  let tree;
  try {
    tree = pg.parsePlPgSQLSync(statement);
  } catch (error) {
    if (ctx.strict) throw error;
    return;
  }
  visitPlpgsql(tree, ctx);
}

function visitPlpgsql(node, ctx) {
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(Array.isArray(node) ? node : node)) {
    if (key !== "PLpgSQL_expr") {
      visitPlpgsql(value, ctx);
      continue;
    }
    const query =
      value.parseMode === 3 ? value.query.slice(value.query.indexOf(":=") + 2) : value.query;
    if (!analyzeSql(query, { ...ctx, strict: false }))
      analyzeSql(`SELECT ${query}`, ctx, `SELECT ${query}`, query);
  }
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
    let destroys;
    try {
      destroys = await destructiveStatements(sql, routines);
    } catch (error) {
      problems.push(`${name} cannot be parsed, so it cannot be verified: ${error.message}`);
      continue;
    }
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
