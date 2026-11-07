import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { contractDigest } from "../scripts/contract-drift.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "apps/web");
const web = path.join(app, "src");
// Wave 4 plan §3.1 and §5: Phaser stays in its renderer adapter, which reaches the React shell only
// through the renderer-neutral bridge, which imports only contracts; React, TanStack Query and
// Zustand stay in the shell.
const adapter = path.join(web, "renderer.ts");
const bridge = path.join(web, "world-scene-adapter");
export function assertBrowserSource(source, file) {
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  function visit(node) {
    // Augmenting a module from the web app could widen a shared contract beside its pin.
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name))
      throw new Error(`${file}: module augmentation forbidden`);
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      specifier = node.argument.literal;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      specifier = node.moduleReference.expression;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(ast) === "require")
    )
      specifier = node.arguments[0];
    if (specifier && !path.resolve(file).startsWith(`${web}/`)) {
      // Tests, fixtures and configuration elsewhere in apps/web may import anything but Phaser.
      if (ts.isStringLiteralLike(specifier) && /^phaser(?:\/|$)/u.test(specifier.text))
        throw new Error(`${file}: Phaser outside its renderer adapter`);
    } else if (specifier) {
      if (!ts.isStringLiteral(specifier))
        throw new Error(`${file}: dynamic import target forbidden`);
      const target = specifier.text;
      const local = target.startsWith(".") && path.resolve(path.dirname(file), target);
      const allowed =
        target === "@clockgrove/contracts" ||
        (path.resolve(file) === adapter
          ? target === "phaser" || local === `${bridge}.js`
          : path.resolve(file) !== `${bridge}.ts` &&
            (target === "@tanstack/react-query" ||
              target === "zustand" ||
              /^(?:react|react-dom)(?:\/|$)/u.test(target) ||
              (local && local.startsWith(`${web}/`))));
      if (!allowed) throw new Error(`${file}: forbidden browser import ${target}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
// The successor scene vocabulary is pinned by one digest of every scene-*.ts contract file: its name
// and each top-level statement except imports, with function declaration bodies left out. Fixes
// inside a decoder function do not move it; a field, type, alias, constant (arrow functions
// included), class body, export, signature or new scene file does. Each file is
// digested by the contract-drift parse, so formatting and comments never count. After reviewing a
// deliberate vocabulary change, set the digest to the value the failure reports.
const SUCCESSOR_VOCABULARY_DIGEST = "2cbc83220e9fbb4e9f95766271ccbbbee179f5b4d13a13effbf3bceb3a057d31";
export function successorVocabularyDigest(sources) {
  const files = Object.keys(sources)
    .filter((name) => /^scene-[\w-]+\.ts$/u.test(name))
    .sort();
  const digests = files.map((name) => {
    const ast = ts.createSourceFile(name, sources[name], ts.ScriptTarget.Latest, true);
    const declarations = ast.statements
      .filter((node) => !ts.isImportDeclaration(node))
      .map((node) =>
        ts.isFunctionDeclaration(node) && node.body
          ? `${node.getText(ast).slice(0, node.body.getStart(ast) - node.getStart(ast))};`
          : node.getText(ast),
      );
    return [name, contractDigest(name, declarations.join("\n"))];
  });
  return createHash("sha256").update(JSON.stringify(digests)).digest("hex");
}
/** Closed field AND type allowlist: adding an alias, index signature or inheritance fails. */
export function assertProjectionContracts(sources) {
  for (const [name, source] of Object.entries(sources)) {
    // No augmentation or namespace merges fields into a contract from outside its declaration.
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    if (file.statements.some((node) => ts.isModuleDeclaration(node)))
      throw new Error(`${name}: contract module augmentation or namespace forbidden`);
  }
  const digest = successorVocabularyDigest(sources);
  if (digest !== SUCCESSOR_VOCABULARY_DIGEST)
    throw new Error(`successor scene vocabulary changed: digest ${digest}`);
  const ast = ts.createSourceFile(
    "browser-protocol.ts",
    sources["browser-protocol.ts"] ?? "",
    ts.ScriptTarget.Latest,
    true,
  );
  const shapes = {
    BrowserScope: {
      tenantId: "TenantId",
      worldId: "WorldId",
      timelineId: "TimelineId",
      spaceId: "SpaceId",
    },
    ObservationRequest: { version: "1" },
    WorldDirectoryRequest: { version: "1" },
    WorldDirectoryEntry: { worldLabel: "string", spaceLabel: "string" },
    WorldDirectory: { version: "1", entries: "readonly WorldDirectoryEntry[]" },
    WorldClock: { simulationTime: "string", runState: '"running" | "paused"', speed: "number", dayLengthMs: "string | null", day: "string | null", timeOfDayMs: "string | null" },
    WorldFeedItem: { category: "WorldFeedCategory", objectId: "ObjectId | null" },
    WorldStatus: { version: "1", privacyClass: '"public_scene"', revision: "string", clock: "WorldClock", feed: "readonly WorldFeedItem[]" },
    LivingWeather: { rainIntensity: "number" },
    LivingUnit: { name: "string", fractionalDigits: "number" },
    LivingAxis: { name: "string", positiveDirection: "string" },
    LivingAxes: { axes: "readonly LivingAxis[]" },
    LivingGravity: { kind: '"constant-vector"', vector: "readonly string[]" },
    LivingTransform: { version: "number", translation: "readonly string[]", basis: "readonly (readonly string[])[]" },
    LivingSpatialFrame: { frameId: "SpatialFrameId", version: "number", dimensions: "2 | 3", unit: "LivingUnit", axes: "LivingAxes", origin: "readonly string[]", gravity: "LivingGravity", "parentFrameId?": "SpatialFrameId", "parentTransform?": "LivingTransform" },
    LivingPose: { frameId: "SpatialFrameId", frameVersion: "number", coordinates: "readonly string[]" },
    PlaceholderPresentation: { kind: '"placeholder"', label: "string" },
    LivingEntity: { objectId: "ObjectId", archetypeId: "string", pose: "LivingPose", presentation: "PlaceholderPresentation" },
    LivingScene: { version: "1", privacyClass: '"public_scene"', revision: "string", simulationTime: "string", weather: "LivingWeather", frames: "readonly LivingSpatialFrame[]", entities: "readonly LivingEntity[]" },
    SelectionCursor: { observedRevision: "string", beforeSequence: "string" },
    EntitySelectionRequest: { version: "1", objectId: "ObjectId", "cursor?": "SelectionCursor" },
    SelectionNeeds: {
      hunger: "number",
      wetness: "number",
      integratedAt: "string",
      hungerRemainder: "string",
      wetnessRemainder: "string",
    },
    SelectionWellbeing: {
      thirst: "number",
      health: "number",
      comfort: '"comfortable" | "uncomfortable"',
      integratedAt: "string",
      thirstRemainder: "string",
      healthRemainder: "string",
    },
    SelectionPlant: {
      stage: "number",
      growingMs: "string",
      wetness: "number",
      wetnessRemainder: "string",
      integratedAt: "string",
    },
    SelectionValues: {
      needs: "SelectionNeeds | null",
      wellbeing: "SelectionWellbeing | null",
      plant: "SelectionPlant | null",
    },
    SelectionResource: { kind: '"food" | "water"', quantity: "number" },
    SelectionShelter: { rainProtection: "number" },
    SelectionAction: {
      kind: '"stay" | "seek-food" | "seek-shelter" | "seek-water"',
      targetObjectId: "ObjectId | null",
    },
    SelectionPhysical: {
      resource: "SelectionResource | null",
      shelter: "SelectionShelter | null",
      locationId: "ObjectId | null",
      selectedAction: "SelectionAction | null",
      lifecycle: '"active" | "retired" | "dead" | null',
    },
    SelectionCurrentWellbeing: {
      thirst: "number",
      health: "number",
      thirstRemainder: "string",
      healthRemainder: "string",
    },
    SelectionCurrentPlant: {
      growingMs: "string",
      wetness: "number",
      wetnessRemainder: "string",
    },
    SelectionDerived: {
      needs: "SelectionNeeds | null",
      wellbeing: "SelectionCurrentWellbeing | null",
      plant: "SelectionCurrentPlant | null",
      canonical: "false",
      simulationTime: "string",
    },
    PublicActionSummary: {
      eventId: "EventId",
      actionId: "ActionId",
      commandId: "CommandId",
      type: "string",
      partitionSequence: "string",
      simulationTime: "string",
      recordedAt: "string",
    },
    SelectionHistory: {
      observedRevision: "string",
      actions: "readonly PublicActionSummary[]",
      beforeSequence: "string | null",
    },
    EntitySelection: {
      version: "1",
      privacyClass: '"public_scene"',
      objectId: "ObjectId",
      evidence: "typeof SELECTION_EVIDENCE",
      revision: "string",
      simulationTime: "string",
      entity: "LivingEntity",
      physical: "SelectionPhysical",
      derived: "SelectionDerived",
      history: "SelectionHistory",
    },
    PublicRoutineFeature: { name: "PublicRoutineFeatureName", value: "string" },
    PublicRoutineCandidate: { action: "SelectionAction", features: "readonly PublicRoutineFeature[]", score: "string", excludedReason: "PublicRoutineExclusion | null" },
    PublicDecisionTrace: { draftIndex: "number", schemaVersion: "1", objectId: "ObjectId", inputRevision: "string", simulationTime: "string", policyVersion: "string", selectionTier: '\"reflex\" | \"utility\"', candidates: "readonly PublicRoutineCandidate[]", selectedAction: "SelectionAction" },
    PublicDecisionEvidence: { status: '\"available\" | \"unavailable\" | \"redacted\"', drafts: "readonly PublicDecisionTrace[]" },
    PublicCausalLinks: { parents: "readonly CommandId[]", children: "readonly CommandId[]" },
    PublicScheduledAction: { scheduleId: "string", idempotencyKey: "string", kind: "string", dueAt: "string", status: '\"pending\" | \"done\"', scheduledBy: "CommandId", completedBy: "CommandId | null" },
    RecordedWhy: { version: "1", privacyClass: '\"public_scene\"', evidence: "typeof RECORDED_WHY_EVIDENCE", entry: "PublicCausalEntry", commandId: "CommandId", actionId: "ActionId | null", receiptStatus: '\"pending\" | \"committed\" | \"rejected\" | \"failed\"', traces: "PublicDecisionEvidence", schedules: "readonly PublicScheduledAction[]", links: "PublicCausalLinks" },
    SceneEntity: { id: "string", label: "string", description: "string" },
    DiagnosticSceneProjection: {
      version: "1",
      privacyClass: '"public_scene"',
      revision: "number",
      title: "string",
      entities: "readonly SceneEntity[]",
    },
    ProjectionConnect: {
      version: "1",
      type: '"connect"',
      correlationId: "CorrelationId",
      resumeRevision: "number | null",
    },
  };
  const literals = {
    PublicRoutineFeatureName: ["hunger", "wetness", "rain", "protection", "thirst", "health", "uncomfortable", "U", "travelMs", "perceived", "expectation", "freshness"],
    PublicRoutineExclusion: ["outside-current-space-or-frame", "no-rain-protection", "not-perceived", "unavailable", "unreachable"],
    WorldFeedCategory: ["weather", "routine", "wellbeing", "growth", "movement", "portal", "resource"],
  };
  // Closed entry unions: each alias's exact text, whitespace-normalized.
  const aliases = {
    RecordedWhyEntry:
      "| { readonly commandId: CommandId } | { readonly eventId: EventId } | { readonly scheduleId: string; readonly idempotencyKey: string }",
    RecordedWhyRequest: "BrowserScope & { readonly version: 1 } & RecordedWhyEntry",
    PublicCausalEntry:
      '| { readonly kind: "command" } | { readonly kind: "event"; readonly eventId: EventId } | { readonly kind: "scheduled-action"; readonly scheduleId: string; readonly idempotencyKey: string }',
  };
  for (const [name, expected] of Object.entries(aliases)) {
    const alias = ast.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === name);
    const text = alias?.type.getText(ast).replace(/\s+/gu, " ").replaceAll("; }", " }").trim();
    if (text !== expected)
      throw new Error(`${name}: public vocabulary changed`);
  }
  for (const [name, expected] of Object.entries(literals)) {
    const alias = ast.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === name);
    if (!alias || !ts.isUnionTypeNode(alias.type)) throw new Error(`${name}: missing closed vocabulary`);
    const actual = alias.type.types.map((type) => {
      if (!ts.isLiteralTypeNode(type) || !ts.isStringLiteral(type.literal)) throw new Error(`${name}: arbitrary public vocabulary`);
      return type.literal.text;
    });
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name}: public vocabulary changed`);
  }
  const seen = new Set();
  for (const node of ast.statements) {
    if (!ts.isInterfaceDeclaration(node) || !(node.name.text in shapes)) continue;
    const name = node.name.text;
    seen.add(name);
    const expected = shapes[name];
    const heritage = node.heritageClauses?.map((clause) => clause.getText(ast)).join(" ") ?? "";
    if (
      heritage !==
      ([
        "DiagnosticSceneProjection",
        "ProjectionConnect",
        "ObservationRequest",
        "WorldDirectoryEntry",
        "WorldStatus",
        "LivingScene",
        "EntitySelectionRequest",
        "EntitySelection",
        "RecordedWhy",
      ].includes(name)
        ? "extends BrowserScope"
        : ["SelectionPhysical"].includes(name)
          ? "extends SelectionValues"
          : name === "WorldFeedItem"
            ? "extends FeedSummary"
            : "")
    )
      throw new Error(`${name}: forbidden projection inheritance`);
    const actual = {};
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.name || !member.type)
        throw new Error(`${name}: projection must have exact required fields`);
      actual[`${member.name.getText(ast)}${member.questionToken ? "?" : ""}`] = member.type.getText(ast);
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(`${name}: shared projection field/type exclusion violated`);
  }
  if (seen.size !== Object.keys(shapes).length)
    throw new Error("missing closed projection contract");
  // Message envelopes may only reference the closed scene vocabulary and scope.
  const message = ast.statements.find(
    (node) => ts.isTypeAliasDeclaration(node) && node.name.text === "ProjectionMessage",
  );
  if (!message || !ts.isUnionTypeNode(message.type)) throw new Error("missing projection envelope");
  const allowedTypes = new Set([
    "1",
    '"snapshot"',
    '"patch"',
    '"unavailable"',
    "CorrelationId",
    "DiagnosticSceneProjection",
    "BrowserScope",
    "number",
    "readonly SceneEntity[]",
  ]);
  for (const variant of message.type.types) {
    if (!ts.isTypeLiteralNode(variant)) throw new Error("projection envelope must be closed");
    for (const member of variant.members) {
      if (
        !ts.isPropertySignature(member) ||
        !member.type ||
        !allowedTypes.has(member.type.getText(ast))
      )
        throw new Error("private or arbitrary projection envelope type");
      if (
        !new Set([
          "version",
          "type",
          "correlationId",
          "scene",
          "scope",
          "fromRevision",
          "revision",
          "entities",
        ]).has(member.name.getText(ast))
      )
        throw new Error("private projection envelope field");
    }
  }
}
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!/^(?:node_modules|dist|\..*)$/u.test(entry.name)) await walk(file);
    } else if (/\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name))
      assertBrowserSource(await readFile(file, "utf8"), file);
  }
}
export async function checkWebBoundaries() {
  await walk(app);
  const contracts = path.join(root, "packages/contracts/src");
  const names = (await readdir(contracts)).filter((name) => name.endsWith(".ts"));
  assertProjectionContracts(
    Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [name, await readFile(path.join(contracts, name), "utf8")]),
      ),
    ),
  );
  // Neither the shell nor the adapter reaches runtime, persistence, application, testkit or trusted
  // sources, nor authentication-provider, model (cognition) provider or database packages.
  const outward = [
    "@clockgrove/persistence",
    "@clockgrove/contracts/trusted",
    "../../runtime/src/worker.js",
    "@clockgrove/application",
    "@clockgrove/testkit",
    "better-auth",
    "@anthropic-ai/sdk",
    "openai",
    "postgres",
    "pg",
  ];
  for (const [file, targets] of [
    [path.join(web, "negative.ts"), ["phaser", ...outward]],
    [adapter, ["react", "@tanstack/react-query", "zustand", "./yard-state.js", ...outward]],
    [`${bridge}.ts`, ["react", "zustand", "./yard-state.js"]],
    [path.join(app, "test/negative.ts"), ["phaser"]],
  ]) {
    for (const target of targets) {
      let refused = false;
      try {
        assertBrowserSource(`import value from ${JSON.stringify(target)};`, file);
      } catch {
        refused = true;
      }
      if (!refused) throw new Error(`negative import fixture accepted: ${target} in ${file}`);
    }
  }
  console.log("browser and shared projection boundaries verified");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await checkWebBoundaries();
