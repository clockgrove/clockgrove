// Retention registry (docs/runbooks/design-checklist.md, "Growth and retention"): every table whose
// rows can never be removed is named in db/retention.json with what bounds or retires it.
//
// A table is append-only when a migration gives it a BEFORE trigger on DELETE or TRUNCATE. In this
// schema such triggers exist only to reject removal (reject_mutation, reject_journal_mutation and
// the guard_* functions). Static CREATE TRIGGER statements are parsed, and so are the
// `FOREACH ... IN ARRAY ARRAY[...] LOOP EXECUTE format('CREATE TRIGGER %I ...')` blocks that create
// one trigger per listed table.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const identifier = `(?:"[^"]+"|[A-Za-z_][\\w$]*)`;
const qualified = `${identifier}(?:\\s*\\.\\s*${identifier})?`;
const normalize = (name) => name.replace(/\s+/gu, "").replaceAll('"', "");

// Arguments of a format() call, split on top-level commas.
function splitArguments(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const character of text) {
    if (character === "'") quoted = !quoted;
    if (!quoted && character === "(") depth += 1;
    if (!quoted && character === ")") depth -= 1;
    if (!quoted && depth === 0 && character === ",") {
      parts.push(current.trim());
      current = "";
    } else current += character;
  }
  parts.push(current.trim());
  return parts;
}

// Expand `FOREACH v IN ARRAY ARRAY['a', 'b'] LOOP ... EXECUTE format('...%I...', args) ... END LOOP`
// into the statements it executes. `%I` takes `v`, `v || 'suffix'`, or a quoted literal.
function expandLoops(sql) {
  const statements = [];
  const loop = /FOREACH\s+(\w+)\s+IN\s+ARRAY\s+ARRAY\s*\[([^\]]*)\]\s*LOOP([\s\S]*?)END\s+LOOP/giu;
  for (const [, variable, list, body] of sql.matchAll(loop)) {
    const values = [...list.matchAll(/'([^']*)'/gu)].map((match) => match[1]);
    const call = /EXECUTE\s+format\s*\(\s*'((?:[^']|'')*)'\s*,([\s\S]*?)\)\s*;/giu;
    for (const [, template, rawArguments] of body.matchAll(call)) {
      const args = splitArguments(rawArguments);
      for (const value of values) {
        let index = 0;
        statements.push(
          template.replaceAll("''", "'").replace(/%I/gu, () => {
            const argument = args[index++] ?? "";
            const suffix = argument.match(new RegExp(`^${variable}\\s*\\|\\|\\s*'([^']*)'$`, "u"));
            if (argument === variable) return value;
            if (suffix) return value + suffix[1];
            return argument.match(/^'([^']*)'$/u)?.[1] ?? `?${argument}`;
          }),
        );
      }
    }
  }
  return statements;
}

export function appendOnlyTables(migrations) {
  const tables = new Set();
  const triggers = new Map(); // "table trigger" -> events
  for (const source of migrations) {
    const sql = source.replace(/--[^\n]*/gu, "");
    const text = [sql, ...expandLoops(sql)].join(";\n");
    const statements = [
      ...text.matchAll(
        new RegExp(
          [
            `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?<created>${qualified})`,
            `DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?<dropped>${qualified}(?:\\s*,\\s*${qualified})*)`,
            `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?<renamed>${qualified})\\s+RENAME\\s+TO\\s+(?<to>${identifier})`,
            `CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+(?<trigger>${identifier})\\s+(?<timing>BEFORE|AFTER|INSTEAD\\s+OF)\\s+(?<events>[\\s\\S]+?)\\s+ON\\s+(?<on>${qualified})`,
            `DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?(?<droppedTrigger>${identifier})\\s+ON\\s+(?<dropOn>${qualified})`,
          ].join("|"),
          "giu",
        ),
      ),
    ];
    for (const { groups } of statements) {
      if (groups.created) tables.add(normalize(groups.created));
      if (groups.dropped)
        for (const name of groups.dropped.split(",")) tables.delete(normalize(name));
      if (groups.renamed) {
        const from = normalize(groups.renamed);
        const schema = from.includes(".") ? `${from.split(".")[0]}.` : "";
        tables.delete(from);
        tables.add(schema + normalize(groups.to));
        for (const [key, events] of triggers)
          if (key.startsWith(`${from} `)) {
            triggers.delete(key);
            triggers.set(`${schema}${normalize(groups.to)} ${key.split(" ")[1]}`, events);
          }
      }
      if (groups.trigger && /^BEFORE$/iu.test(groups.timing))
        triggers.set(
          `${normalize(groups.on)} ${normalize(groups.trigger)}`,
          groups.events.toUpperCase().split(/\s+OR\s+/u),
        );
      if (groups.droppedTrigger)
        triggers.delete(`${normalize(groups.dropOn)} ${normalize(groups.droppedTrigger)}`);
    }
  }
  const appendOnly = new Set();
  for (const [key, events] of triggers) {
    const table = key.split(" ")[0];
    assert(!table.includes("?"), `retention: cannot resolve trigger target ${table}`);
    if (events.some((event) => /^(DELETE|TRUNCATE)\b/u.test(event.trim()))) appendOnly.add(table);
  }
  return { tables, appendOnly };
}

export async function checkRetention(root) {
  const directory = path.join(root, "db/migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const migrations = await Promise.all(
    files.map((name) => readFile(path.join(directory, name), "utf8")),
  );
  const { tables, appendOnly } = appendOnlyTables(migrations);
  const registry = JSON.parse(await readFile(path.join(root, "db/retention.json"), "utf8"));
  const problems = [];
  for (const table of [...appendOnly].sort())
    if (typeof registry[table] !== "string" || registry[table].trim() === "")
      problems.push(`${table} is append-only but has no retention statement in db/retention.json`);
  for (const table of Object.keys(registry).sort())
    if (!tables.has(table)) problems.push(`db/retention.json names unknown table ${table}`);
  assert.deepEqual(problems, [], problems.join("\n"));
  console.log(`retention registry covers ${appendOnly.size} append-only tables`);
}
