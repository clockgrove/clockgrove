import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let compiler;

// No path exemptions: fixtures construct synthetic values at runtime.
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----(?:(?:\\r)?\\n|\r?\n)(?:(?:Proc-Type|DEK-Info):[^\\\r\n]+(?:(?:\\r)?\\n|\r?\n))*(?:(?:\\r)?\\n|\r?\n)*[A-Za-z0-9+/=]{16,}/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/u,
  /\b(?:sk-(?:proj-)?|sk_live_|rk_live_|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  /(?:postgres(?:ql)?|mysql|redis):\/\/[^\s/:]+:[^\s/@]+@/iu,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/iu,
  /["']?(?:[A-Z_]*(?:API_KEY|API_TOKEN|CLIENT_SECRET|SECRET_KEY|PRIVATE_KEY|PASSWORD|AUTH_SECRET|DATABASE_URL|OTLP_TOKEN)|api[_-]?key|api[_-]?token|client[_-]?secret|password|secret)["']?\s*[:=]\s*["'][^"'\r\n]{4,}["']/u,
  /^[\t ]*(?:export[\t ]+)?(?:[A-Z_]*(?:API_KEY|API_TOKEN|CLIENT_SECRET|SECRET_KEY|PRIVATE_KEY|PASSWORD|AUTH_SECRET|DATABASE_URL|OTLP_TOKEN)|api[_-]?key|api[_-]?token|client[_-]?secret|password|secret)[\t ]*=[\t ]*(?!\$|var\.|local\.|neon_role\.|process\.)[^\s"'#;]{1,}/mu,
];

function syntaxObservation(source, location, match, rule) {
  if (!/\.[cm]?[jt]sx?(?:\s|$)/u.test(location)) return false;
  // The install recorder imports this module before dependencies exist.
  // Parsing is needed only when a JavaScript assignment match needs classification.
  try {
    compiler ??= require("typescript");
  } catch {
    return false;
  }
  const ts = compiler;
  const file = ts.createSourceFile(location, source, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length) return false;
  const start = match.index + match[0].search(/\S/u);
  let containing = file;
  const visit = (node) => {
    if (node.getStart(file) <= start && node.end >= match.index + match[0].length) {
      containing = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(file);
  const reference = (node) =>
    ts.isIdentifier(node) ||
    (ts.isPropertyAccessExpression(node) && reference(node.expression)) ||
    (ts.isElementAccessExpression(node) &&
      reference(node.expression) &&
      (ts.isIdentifier(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)));
  const referenceOrAbsent = (node) =>
    reference(node) ||
    (ts.isVoidExpression(node) &&
      ts.isNumericLiteral(node.expression) &&
      node.expression.text === "0");
  // Classify the whole assignment, never just a matching reference prefix.
  if (
    rule === 8 &&
    ts.isBinaryExpression(containing) &&
    containing.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const right = containing.right;
    if (referenceOrAbsent(right)) return true;
    // The complete public development sentinel is not private material. This
    // recognizes only its reference fallback form, never a scalar binding.
    return (
      ts.isBinaryExpression(right) &&
      right.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
      reference(right.left) &&
      ts.isStringLiteralLike(right.right) &&
      right.right.text === "better-auth-secret-12345678901234567890"
    );
  }
  if (rule === 7 && ts.isPropertyAssignment(containing)) {
    const value = containing.initializer;
    const name = containing.name.getText(file).replace(/^['"]|['"]$/gu, "");
    if (
      ts.isConditionalExpression(value) &&
      ts.isBinaryExpression(value.condition) &&
      value.condition.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      ts.isStringLiteralLike(value.condition.left) &&
      value.condition.left.text === name &&
      referenceOrAbsent(value.whenTrue) &&
      referenceOrAbsent(value.whenFalse)
    ) {
      return true;
    }
    // Diagnostic catalogs use code identifiers and descriptions of those codes,
    // rather than scalar credential bindings. Random literal values still refuse.
    if (
      ts.isStringLiteralLike(value) &&
      /(?:^INVALID_|_ALREADY_)/u.test(name) &&
      /_PASSWORD$/u.test(name) &&
      ts.isObjectLiteralExpression(containing.parent) &&
      containing.parent.properties.every(
        (entry) =>
          ts.isPropertyAssignment(entry) &&
          /^[A-Z][A-Z_]+$/u.test(entry.name.getText(file)) &&
          ts.isStringLiteralLike(entry.initializer),
      )
    ) {
      const description =
        name === "USER_ALREADY_HAS_PASSWORD"
          ? "User already has a password. Provide that to delete the account."
          : name[0] + name.slice(1).toLowerCase().replaceAll("_", " ");
      return value.text === description;
    }
  }
  // A documentation example spelling the field's own public placeholder is not a
  // runtime binding. Other comment values and all high-signal material still scan.
  if (rule === 7 && /^password\s*:\s*['"]password['"]$/u.test(match[0])) {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, undefined, source);
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
      if (
        scanner.getToken() === ts.SyntaxKind.MultiLineCommentTrivia &&
        scanner.getTokenPos() <= match.index &&
        scanner.getTextPos() >= match.index + match[0].length &&
        /^\/\*\*/u.test(scanner.getTokenText()) &&
        /@example\b|```(?:js|ts|javascript|typescript)\b/u.test(scanner.getTokenText())
      )
        return true;
    }
  }
  return false;
}

export function assertNoSecretValues(source, location = "configuration") {
  const fail = () => {
    // Never include the matching value in diagnostics.
    throw new Error(`${location}: secret-shaped value detected`);
  };
  // High-signal material is checked in every original byte, including source maps.
  if (patterns.slice(0, 7).some((pattern) => pattern.test(source))) fail();
  if (/\.map(?:\s|$)/u.test(location)) {
    let map;
    try {
      map = JSON.parse(source);
    } catch {
      /* Scan malformed maps as ordinary text. */
    }
    if (
      map?.version === 3 &&
      Array.isArray(map.sources) &&
      Array.isArray(map.sourcesContent) &&
      map.sources.length === map.sourcesContent.length
    ) {
      for (let index = 0; index < map.sourcesContent.length; index++) {
        const content = map.sourcesContent[index];
        if (content !== null) {
          if (typeof content !== "string" || typeof map.sources[index] !== "string") fail();
          assertNoSecretValues(content, map.sources[index]);
        }
      }
      const { sourcesContent, ...metadata } = map;
      assertNoSecretValues(JSON.stringify(metadata), `${location} metadata`);
      return;
    }
  }
  for (let rule = 7; rule < patterns.length; rule++) {
    // JavaScript references are classified as whole expressions below. Prefix
    // exclusions would hide a reference concatenated with credential material.
    // Keep the original reference grammar for Terraform and other text formats.
    const sourcePattern =
      rule === 8 && /\.[cm]?[jt]sx?(?:\s|$)/u.test(location)
        ? patterns[rule].source.replace("(?!\\$|var\\.|local\\.|neon_role\\.|process\\.)", "")
        : patterns[rule].source;
    const pattern = new RegExp(sourcePattern, `${patterns[rule].flags}g`);
    for (const match of source.matchAll(pattern)) {
      if (!syntaxObservation(source, location, match, rule)) fail();
    }
  }
}

export function checkGitTreeSecrets(root, tree) {
  const names = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", tree], { cwd: root })
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const name of names) {
    const bytes = execFileSync("git", ["show", `${tree}:${name}`], {
      cwd: root,
      maxBuffer: 128 * 1024 * 1024,
    });
    assertNoSecretValues(bytes.toString("utf8"), `${name} (committed tree)`);
  }
}

export async function checkRepositorySecrets(root) {
  // Include HEAD even when a tracked secret has been staged for deletion/replacement.
  const head = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      return undefined;
    }
  })();
  if (head) checkGitTreeSecrets(root, head);
  const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: root })
    .toString()
    .split("\0")
    .filter(Boolean);
  const working = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
    },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const name of new Set(tracked)) {
    const bytes = execFileSync("git", ["show", `:${name}`], {
      cwd: root,
      maxBuffer: 128 * 1024 * 1024,
    });
    assertNoSecretValues(bytes.toString("utf8"), `${name} (index)`);
  }
  for (const name of new Set(working)) {
    try {
      assertNoSecretValues((await readFile(path.join(root, name))).toString("utf8"), name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkRepositorySecrets(
    path.resolve(
      process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    ),
  );
  console.log("repository secret-value check passed");
}
