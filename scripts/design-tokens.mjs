// Generates the web shell's token stylesheet from DESIGN.md, the one source of truth for the shell's
// default UI tokens, and fails when the committed stylesheet differs from what DESIGN.md generates.
//   node scripts/design-tokens.mjs           check the committed stylesheet (pnpm check)
//   node scripts/design-tokens.mjs --write   regenerate it
// Mapping: colors.K -> --cg-v1-K; spacing.K -> --cg-v1-K; rounded.K -> --cg-v1-radius-K;
// typography.body.fontFamily -> --cg-v1-font; typography.body.lineHeight -> --cg-v1-line-height.
// The CLI exporters drop typography and CSS functions such as min(), so the front matter is read here.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const designFile = "DESIGN.md";
export const tokensFile = "apps/web/src/world-shell-tokens.css";
const prefix = "--cg-v1-";

export function generateTokens(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!match) throw new Error(`${designFile}: missing YAML front matter`);
  const tokens = parse(match[1]);
  const lines = [];
  const add = (name, value) => {
    if (value === undefined || value === null || value === "")
      throw new Error(`${designFile}: no value for ${prefix}${name}`);
    lines.push(`  ${prefix}${name}: ${value};`);
  };
  for (const [name, value] of Object.entries(tokens.colors ?? {})) add(name, value);
  add("font", tokens.typography?.body?.fontFamily);
  add("line-height", tokens.typography?.body?.lineHeight);
  for (const [name, value] of Object.entries(tokens.rounded ?? {})) add(`radius-${name}`, value);
  for (const [name, value] of Object.entries(tokens.spacing ?? {})) add(name, value);
  return [
    `/* Generated from ${designFile} by scripts/design-tokens.mjs. Do not edit; run: node scripts/design-tokens.mjs --write */`,
    '[data-tokens="world-shell@1"] {',
    ...lines,
    "}",
    "",
  ].join("\n");
}

export function checkDesignTokens(directory = root) {
  const expected = generateTokens(readFileSync(path.join(directory, designFile), "utf8"));
  const actual = readFileSync(path.join(directory, tokensFile), "utf8");
  if (actual !== expected)
    throw new Error(
      `${tokensFile} differs from what ${designFile} generates; run: node scripts/design-tokens.mjs --write`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write"))
    writeFileSync(
      path.join(root, tokensFile),
      generateTokens(readFileSync(path.join(root, designFile), "utf8")),
    );
  else checkDesignTokens();
}
