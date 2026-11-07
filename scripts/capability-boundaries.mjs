import ts from "typescript";

const inward = new Set([
  "@clockgrove/contracts",
  "@clockgrove/domain",
  "@clockgrove/kernel",
  "@clockgrove/application",
]);

/** Inspect all TS module references, including erased type-only references. */
export function assertCapabilitySourceNeutral(source, location) {
  const file = ts.createSourceFile(location, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    let module;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) module = node.moduleSpecifier;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      module = node.argument.literal;
    if (ts.isExternalModuleReference(node)) module = node.expression;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      module = node.arguments[0];
    if (module !== undefined) {
      if (
        !ts.isStringLiteralLike(module) ||
        (!module.text.startsWith(".") && !inward.has(module.text))
      ) {
        throw new Error(
          `${location}: application contracts may reference only inward project-owned modules`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}

export function assertCapabilityManifestNeutral(manifest, location) {
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (
        (inward.has(name) && version !== "workspace:*") ||
        (!inward.has(name) && !(field === "devDependencies" && name === "vitest"))
      ) {
        throw new Error(`${location}: application ${field} contains outward dependency ${name}`);
      }
    }
  }
}
