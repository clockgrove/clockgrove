import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceDirectory = "packages/contracts/src";
const { SyntaxKind } = ts;
const isModuleRequest = (node) =>
  ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier);

// Digest of the parsed syntax tree with explicit nesting, so the pin covers the contract's meaning,
// not its layout. Whitespace, comments, quote style, number spelling, redundant parentheses, arrow
// parameter parentheses, trailing commas, leading union bars, member separators and statement
// semicolons drop out; every token that changes the parse stays. Import and re-export declarations
// and their specifiers are compared as sorted sets, because Biome's import organizer reorders them:
// declarations are hoisted, and contract modules import only each other with no top-level effects.
export function contractDigest(name, text) {
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const leaf = (node) => {
    if (!ts.isLiteralKind(node.kind)) return node.getText(file);
    const propertyName = node.parent && "name" in node.parent && node.parent.name === node;
    if (
      ts.isStringLiteral(node) &&
      propertyName &&
      ts.isIdentifierText(node.text, ts.ScriptTarget.Latest)
    )
      return node.text;
    if (ts.isStringLiteral(node)) return JSON.stringify(node.text);
    return `${SyntaxKind[node.kind]}:${JSON.stringify(node.text)}`;
  };
  const serialize = (node) => {
    if (
      (ts.isParenthesizedExpression(node) && !ts.isOptionalChain(node.expression)) ||
      ts.isParenthesizedTypeNode(node)
    )
      return serialize(node.expression ?? node.type);
    const children = node.getChildren(file);
    if (children.length === 0) return leaf(node);
    const list = node.kind === SyntaxKind.SyntaxList;
    const parts = children
      .filter((child, index) => {
        const last = index === children.length - 1;
        if (child.kind >= SyntaxKind.FirstJSDocNode && child.kind <= SyntaxKind.LastJSDocNode)
          return false;
        if (
          ts.isArrowFunction(node) &&
          [SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken].includes(child.kind)
        )
          return false;
        if (last && child.kind === SyntaxKind.SemicolonToken && !list) return false;
        if (last && child.kind === SyntaxKind.CommaToken && (list || ts.isTypeElement(node)))
          return false;
        return !(
          list &&
          [SyntaxKind.BarToken, SyntaxKind.AmpersandToken].includes(child.kind) &&
          (ts.isUnionTypeNode(node.parent) || ts.isIntersectionTypeNode(node.parent))
        );
      })
      .map((child) => ({ child, text: serialize(child) }));
    if (list && (ts.isNamedImports(node.parent) || ts.isNamedExports(node.parent))) {
      const specifiers = parts.filter(({ child }) => child.kind !== SyntaxKind.CommaToken);
      return `( ${specifiers
        .map(({ text }) => text)
        .sort()
        .join(" , ")} )`;
    }
    if (list && ts.isSourceFile(node.parent)) {
      const requests = parts.filter(({ child }) => isModuleRequest(child)).map(({ text }) => text);
      const body = parts.filter(({ child }) => !isModuleRequest(child)).map(({ text }) => text);
      return `( ${[...requests.sort(), ...body].join(" ")} )`;
    }
    return `( ${parts.map(({ text }) => text).join(" ")} )`;
  };
  return createHash("sha256").update(serialize(file)).digest("hex");
}
async function inventory(names, read) {
  const files = names.filter((name) => name.endsWith(".ts")).sort();
  return Object.fromEntries(
    await Promise.all(files.map(async (name) => [name, contractDigest(name, await read(name))])),
  );
}
export async function contractInventory(root) {
  return inventory(await readdir(path.join(root, sourceDirectory)), (name) =>
    readFile(path.join(root, sourceDirectory, name), "utf8"),
  );
}
// The contract version is derived from the committed per-file digests, never hand-assigned, so two
// pull requests that change different contracts merge in either order without predicting each
// other's number (issue 237). Any change to a contract's meaning changes its digest, so it changes
// the version; the same contract set always has the same version.
export function contractVersion(files) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`;
}
// Refuses a committed inventory that differs from the sources, so a contract change cannot land
// without its digest line in the diff; returns the inventory with its derived version.
export async function checkContractDrift(root) {
  const generated = JSON.parse(
    await readFile(path.join(root, "scripts/contracts.generated.json"), "utf8"),
  );
  const files = await contractInventory(root);
  assert.deepEqual(
    generated,
    { files },
    "contract drift: regenerate scripts/contracts.generated.json",
  );
  return { version: contractVersion(files), files };
}
// A blank line between entries keeps neighbouring digests in separate merge hunks, so pull requests
// that change adjacent contract files merge without a textual conflict.
export async function generateContractInventory(root) {
  const files = await contractInventory(root);
  await writeFile(
    path.join(root, "scripts/contracts.generated.json"),
    `${JSON.stringify({ files }, null, 2).replaceAll(',\n    "', ',\n\n    "')}\n`,
  );
  return { version: contractVersion(files), files };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? ".");
  const generate = process.argv.includes("--generate");
  const { version } = generate
    ? await generateContractInventory(root)
    : await checkContractDrift(root);
  console.log(`contract inventory ${version} ${generate ? "written" : "verified"}`);
}
