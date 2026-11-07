import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHECKS, type ConformanceProblem, throwIfProblems } from "./failure.js";
import { type LoadedPack, REPO_ROOT } from "./pack-source.js";

/** The engine source directories that must stay free of pack identities. */
export const ENGINE_SOURCE_ROOTS: readonly string[] = [
  "contracts",
  "domain",
  "kernel",
  "world-pack-sdk",
  "simulator",
].map((name) => join(REPO_ROOT, "packages", name, "src"));

/** Names of the raccoon reference world; no engine source may use them outside comments. */
export const REFERENCE_WORLD_NAMES: readonly string[] = [
  "raccoon",
  "stevie",
  "gracie",
  "green-lake",
];

export const REFERENCE_WORLD_PACK = "(reference world)";

const DECLARING_FIELDS = [
  "archetypes",
  "traits",
  "spaces",
  "actors",
  "rules",
  "capabilities",
  "policies",
  "cognitiveSeeds",
  "assets",
] as const;

/** Every identity a pack declares: its own id and the ids of all definitions in its manifest. */
export function declaredIdentities(pack: LoadedPack): string[] {
  const manifest = pack.source.manifest;
  const identities = new Set<string>();
  if (typeof manifest.id === "string" && manifest.id !== "") identities.add(manifest.id);
  for (const field of DECLARING_FIELDS) {
    const entries: unknown = manifest[field];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as unknown[]) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id === "string" && id !== "") identities.add(id);
    }
  }
  return [...identities].sort();
}

/**
 * The text with every comment replaced by nothing (newlines kept, so line numbers hold). String,
 * template and regular-expression literals are kept whole.
 */
export function stripComments(text: string): string {
  let out = "";
  let last = "";
  let index = 0;
  const length = text.length;
  while (index < length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      while (index < length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") out += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      out += char;
      index += 1;
      while (index < length && text[index] !== char) {
        if (text[index] === "\\") {
          out += text[index]!;
          index += 1;
        }
        if (index < length) out += text[index]!;
        index += 1;
      }
      out += char;
      index += 1;
      last = char;
      continue;
    }
    if (char === "/" && (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last))) {
      let inClass = false;
      out += char;
      index += 1;
      while (index < length && text[index] !== "\n" && (inClass || text[index] !== "/")) {
        if (text[index] === "\\") {
          out += text[index]!;
          index += 1;
        } else if (text[index] === "[") inClass = true;
        else if (text[index] === "]") inClass = false;
        if (index < length) out += text[index]!;
        index += 1;
      }
      if (index < length && text[index] === "/") {
        out += "/";
        index += 1;
      }
      last = "/";
      continue;
    }
    out += char;
    if (!/\s/u.test(char)) last = char;
    index += 1;
  }
  return out;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:[cm]?ts|tsx|[cm]?js)$/u.test(entry.name)) files.push(path);
    }
  };
  await visit(root);
  return files.sort();
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

/**
 * Fails when engine source outside comments contains an identity declared by any given pack or a
 * raccoon reference-world name. A comment that mentions either is not a violation.
 */
export async function checkEngineNeutrality(
  packs: readonly LoadedPack[],
  roots: readonly string[] = ENGINE_SOURCE_ROOTS,
): Promise<void> {
  const problems: ConformanceProblem[] = [];
  const declared = packs.map((pack) => ({ pack: pack.name, identities: declaredIdentities(pack) }));
  const patterns = declared
    .filter(({ identities }) => identities.length > 0)
    .map(({ pack, identities }) => ({
      pack,
      identities,
      regexp: new RegExp(
        `(?<![\\w-])(${[...identities]
          .sort((a, b) => b.length - a.length)
          .map(escapeRegExp)
          .join("|")})(?![\\w-])`,
        "gu",
      ),
    }));
  const reference = new RegExp(REFERENCE_WORLD_NAMES.map(escapeRegExp).join("|"), "giu");

  for (const root of roots) {
    if (!existsSync(root)) {
      problems.push({
        pack: REFERENCE_WORLD_PACK,
        check: CHECKS.neutrality,
        detail: `engine source root ${root} does not exist`,
      });
      continue;
    }
    for (const file of await sourceFiles(root)) {
      const code = stripComments(await readFile(file, "utf8"));
      const shown = file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file;
      for (const { pack, regexp } of patterns) {
        regexp.lastIndex = 0;
        for (const match of code.matchAll(regexp))
          problems.push({
            pack,
            check: CHECKS.neutrality,
            detail: `${shown}:${lineOf(code, match.index ?? 0)} uses the pack-declared identity "${match[1]}" outside a comment`,
          });
      }
      for (const match of code.matchAll(reference))
        problems.push({
          pack: REFERENCE_WORLD_PACK,
          check: CHECKS.neutrality,
          detail: `${shown}:${lineOf(code, match.index ?? 0)} uses the reference-world name "${match[0]}" outside a comment`,
        });
    }
  }
  throwIfProblems(problems);
}
