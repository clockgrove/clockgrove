import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { assertBrowserSource, assertProjectionContracts } from "../../../tools/web-boundaries.mjs";

// `pnpm check` runs tools/web-boundaries.mjs with plain-import negatives; these cover the forms it does not.
const sourceFile = fileURLToPath(new URL("../src/negative.ts", import.meta.url));
const directory = new URL("../../../packages/contracts/src/", import.meta.url);
const contracts = Object.fromEntries(
  await Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map(async (name) => [name, await readFile(new URL(name, directory), "utf8")]),
  ),
);
/** The contract sources with the first file that contains `pattern` changed there. */
function replaced(pattern, replacement) {
  const name = Object.keys(contracts).find((file) =>
    typeof pattern === "string" ? contracts[file].includes(pattern) : pattern.test(contracts[file]),
  );
  if (name === undefined) throw new Error(`not in the contracts: ${pattern}`);
  return { ...contracts, [name]: contracts[name].replace(pattern, replacement) };
}

it("rejects private type-only and import-equals references", () => {
  expect(() =>
    assertBrowserSource('type Private = import("@clockgrove/persistence").Private;', sourceFile),
  ).toThrow();
  expect(() =>
    assertBrowserSource('import Private = require("@clockgrove/runtime");', sourceFile),
  ).toThrow();
});

it("rejects private data in the shared projection, including behind a permitted field name", () => {
  expect(() =>
    assertProjectionContracts(
      replaced("readonly title: string;", "readonly title: string; readonly grants: string;"),
    ),
  ).toThrow();
  expect(() =>
    assertProjectionContracts(
      replaced("readonly description: string;", "readonly description: ExecutionContext;"),
    ),
  ).toThrow();
});

it("confines Phaser to its renderer and permits only the required server and transient state libraries", () => {
  const rendererFile = fileURLToPath(new URL("../src/renderer.ts", import.meta.url));
  expect(() => assertBrowserSource('import Phaser from "phaser";', rendererFile)).not.toThrow();
  expect(() => assertBrowserSource('import Phaser from "phaser";', sourceFile)).toThrow();
  expect(() =>
    assertBrowserSource('import { QueryClient } from "@tanstack/react-query";', sourceFile),
  ).not.toThrow();
  expect(() => assertBrowserSource('import { create } from "zustand";', sourceFile)).not.toThrow();
  expect(() =>
    assertBrowserSource('import internal from "phaser/src/core";', rendererFile),
  ).toThrow();
  expect(() =>
    assertBrowserSource('import internal from "zustand/middleware";', sourceFile),
  ).toThrow();
});

it("keeps Phaser types and its renderer out of the headless 3D adapter fixture's whole program", () => {
  // Rooted at the fixture with no ambient type packages, a global `Phaser.` reference fails to
  // resolve, and any import or type reference that reaches Phaser or the renderer joins the program.
  const directory = fileURLToPath(new URL("..", import.meta.url));
  const tsconfig = ts.readConfigFile(`${directory}tsconfig.json`, ts.sys.readFile).config;
  const { options } = ts.parseJsonConfigFileContent(tsconfig, ts.sys, directory);
  const program = ts.createProgram([`${directory}test/headless-3d-adapter.ts`], {
    ...options,
    types: [],
  });
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, "\n")),
  ).toEqual([]);
  expect(
    program
      .getSourceFiles()
      .map(({ fileName }) => fileName)
      .filter((file) => /\/node_modules\/phaser\/|\/src\/renderer\.ts$/u.test(file)),
  ).toEqual([]);
});

it("rejects arbitrary observation data behind every renderer-neutral contract", () => {
  for (const field of [
    "readonly rainIntensity: number;",
    "readonly fractionalDigits: number;",
    "readonly positiveDirection: string;",
    "readonly axes: readonly LivingAxis[];",
    'readonly kind: "constant-vector";',
    "readonly translation: readonly string[];",
    "readonly dimensions: 2 | 3;",
    "readonly coordinates: readonly string[];",
    'readonly kind: "placeholder";',
    "readonly archetypeId: string;",
    "readonly simulationTime: string;",
  ]) {
    expect(() =>
      assertProjectionContracts(replaced(field, `${field} readonly privateData: string;`)),
    ).toThrow();
  }
});

it("keeps every selected-entity state and history boundary closed", () => {
  for (const field of [
    "readonly beforeSequence: string;",
    "readonly cursor?: SelectionCursor;",
    "readonly hungerRemainder: string;",
    'readonly comfort: "comfortable" | "uncomfortable";',
    "readonly growingMs: string;",
    "readonly plant: SelectionPlant | null;",
    'readonly kind: "food" | "water";',
    "readonly rainProtection: number;",
    "readonly targetObjectId: ObjectId | null;",
    "readonly selectedAction: SelectionAction | null;",
    "readonly canonical: false;",
    "readonly healthRemainder: string;",
    "readonly wellbeing: SelectionCurrentWellbeing | null;",
    "readonly recordedAt: string;",
    "readonly actions: readonly PublicActionSummary[];",
    "readonly physical: SelectionPhysical;",
  ]) {
    expect(() =>
      assertProjectionContracts(replaced(field, `${field} readonly privateData: string;`)),
    ).toThrow();
  }
  for (const name of [
    "SelectionCursor",
    "EntitySelectionRequest",
    "SelectionNeeds",
    "SelectionWellbeing",
    "SelectionPlant",
    "SelectionValues",
    "SelectionResource",
    "SelectionShelter",
    "SelectionAction",
    "SelectionPhysical",
    "SelectionCurrentWellbeing",
    "SelectionCurrentPlant",
    "SelectionDerived",
    "PublicActionSummary",
    "SelectionHistory",
    "EntitySelection",
  ]) {
    expect(() =>
      assertProjectionContracts(
        replaced(
          new RegExp(`(export interface ${name}(?: extends \\w+)? \\{)`),
          "$1 readonly privateData: string;",
        ),
      ),
    ).toThrow();
  }
  expect(() => assertProjectionContracts(contracts)).not.toThrow();
});

it("keeps every recorded Why boundary free of trusted and arbitrary data", () => {
  for (const name of [
    "RecordedWhyRequest",
    "PublicRoutineFeature",
    "PublicRoutineCandidate",
    "PublicDecisionTrace",
    "PublicDecisionEvidence",
    "PublicCausalLinks",
    "RecordedWhy",
  ]) {
    expect(() =>
      assertProjectionContracts(
        replaced(
          new RegExp(`(export interface ${name}(?: extends \\w+)? \\{)`),
          "$1 readonly privateData: string;",
        ),
      ),
    ).toThrow();
  }
  expect(() =>
    assertProjectionContracts(
      replaced("readonly traces: PublicDecisionEvidence;", "readonly traces: CausalCommandView;"),
    ),
  ).toThrow();
});

it("keeps the observer world directory free of authority and arbitrary data", () => {
  for (const name of ["WorldDirectoryRequest", "WorldDirectoryEntry", "WorldDirectory"])
    expect(() =>
      assertProjectionContracts(
        replaced(
          new RegExp(`(export interface ${name}(?: extends \\w+)? \\{)`),
          "$1 readonly grants: string;",
        ),
      ),
    ).toThrow(`${name}: shared projection field/type exclusion violated`);
});

it("rejects widening public Why feature names and exclusions to arbitrary strings", () => {
  expect(() =>
    assertProjectionContracts(replaced('| "freshness";', '| "freshness" | string;')),
  ).toThrow();
  expect(() =>
    assertProjectionContracts(replaced('| "unreachable";', '| "unreachable" | string;')),
  ).toThrow();
});

it("pins every scene contract file, including augmentations, namespaces and new types or files", () => {
  expect(() => assertProjectionContracts(contracts)).not.toThrow();
  const augmentation =
    'declare module "./scene-protocol.js" { interface SceneProjection { readonly privateData: string; } }';
  const appended = (name, source) => ({
    ...contracts,
    [name]: `${contracts[name] ?? ""}\n${source}`,
  });
  for (const [mutated, error] of [
    [
      replaced(
        "readonly audienceHash: string;",
        "readonly audienceHash: string; readonly privateData: string;",
      ),
      "successor scene vocabulary changed",
    ],
    [
      appended("browser-protocol.ts", augmentation),
      "browser-protocol.ts: contract module augmentation",
    ],
    [
      appended(
        "scene-protocol.ts",
        "export namespace SceneProjection { export const privateData = 1; }",
      ),
      "scene-protocol.ts: contract module augmentation or namespace",
    ],
    [
      appended("scene-protocol.ts", "export type ScenePrivate = Record<string, unknown>;"),
      "vocabulary changed",
    ],
    [
      appended("scene-private.ts", "export interface ScenePrivate { readonly secret: string; }"),
      "vocabulary changed",
    ],
  ])
    expect(() => assertProjectionContracts(mutated)).toThrow(error);
  expect(() =>
    assertBrowserSource(
      augmentation.replace("./scene-protocol.js", "@clockgrove/contracts"),
      sourceFile,
    ),
  ).toThrow("module augmentation forbidden");
});
