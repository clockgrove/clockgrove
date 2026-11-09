import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { assetDeployRefusals, decodeAssetManifest } from "@clockgrove/contracts/asset-manifest";
import { atlasLocationProblems, buildAtlases } from "./atlas.js";
import { licenseReport } from "./license-report.js";
import {
  type GoldenRecord,
  goldenPaths,
  type ManifestFile,
  type PackScene,
  readAssetStyleProfile,
  readGolden,
  readManifests,
  readPackScenes,
  repositoryRoot,
} from "./repository.js";
import { renderScene } from "./scene.js";
import { sha256Hex, validateSource } from "./validate.js";

const args = process.argv.slice(3);
const worldIndex = args.indexOf("--world");
const external = worldIndex >= 0;
const positional = args.filter((_, index) => index !== worldIndex && index !== worldIndex + 1);
const invalidArguments = external
  ? args.filter((arg) => arg === "--world").length !== 1 ||
    !args[worldIndex + 1] ||
    args[worldIndex + 1]?.startsWith("--") ||
    positional.length !== (process.argv[2] === "validate" ? 1 : 0)
  : args.length !== (process.argv[2] === "validate" ? 1 : 0);
const root = external ? resolve(args[worldIndex + 1] ?? ".") : repositoryRoot;
const worldRoot = external ? "." : "worlds/fixture";
const assetRoot = external ? "assets" : "worlds/fixture/assets";
const referenceRoot = external ? "reference" : "worlds/fixture/reference";
const fixtures = "packages/contracts/test/fixtures/asset-manifest";
const regenerate =
  "run `pnpm --filter @clockgrove/assets run update-golden` and get human approval";
let files: ManifestFile[] = [];
let deployable: ManifestFile[] = [];
let layout: ManifestFile["manifest"][] = [];

function preflight(): string[] {
  files = readManifests(root, assetRoot);
  deployable = files.filter((f) => assetDeployRefusals(f.manifest).length === 0);
  layout = files.map((f) => f.manifest);
  if (files.length === 0) return [];
  const profile = readAssetStyleProfile(root, referenceRoot);
  const problems = files.flatMap((f) =>
    validateSource(f.manifest, f.bytes, f.path.replace("worlds/fixture/", ""), profile),
  );
  return problems.length > 0 ? problems : atlasLocationProblems(layout);
}

function expectedReviewed(): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const atlas of buildAtlases(deployable, layout)) {
    out.set(`${atlas.atlasId}.png`, atlas.png);
    out.set(`${atlas.atlasId}.animations.json`, new TextEncoder().encode(atlas.animations));
  }
  return out;
}

function render(scene: PackScene, golden: GoldenRecord): Uint8Array {
  return renderScene({
    presentation: scene.presentation,
    // Only deployable manifests, so the approved golden shows what upload ships; a bound
    // pending or refused asset fails the render as a missing manifest.
    entries: deployable,
    placements: scene.placements,
    paths: scene.paths,
    camera: golden.camera,
    simulationTimeMs: golden.simulationTimeMs,
    rainIntensity: golden.rainIntensity,
    selectedObjectId: golden.selectedObjectId,
  });
}

const read = (path: string) => (existsSync(path) ? readFileSync(path) : null);
const same = (a: Uint8Array | null, b: Uint8Array) => a !== null && Buffer.compare(a, b) === 0;
const reportPath = join(root, assetRoot, "license-report.md");
const reviewedDir = join(root, assetRoot, "reviewed");

function check(): string[] {
  const problems: string[] = external
    ? files.flatMap((f) => assetDeployRefusals(f.manifest).map((r) => `${r.code}: ${r.detail}`))
    : [];
  for (const [name, code] of [
    ["unreviewed", "REVIEW_NOT_APPROVED"],
    ["unlicensed", "LICENSE_NOT_PERMITTED"],
  ] as const) {
    const manifest = decodeAssetManifest(
      JSON.parse(readFileSync(join(repositoryRoot, fixtures, `${name}.json`), "utf8")),
    );
    if (!assetDeployRefusals(manifest).some((r) => r.code === code))
      problems.push(`deploy gate: the ${name} fixture is no longer refused with ${code}`);
  }
  if (problems.length > 0) return problems;

  const expected = expectedReviewed();
  const actual = existsSync(reviewedDir) ? readdirSync(reviewedDir).sort() : [];
  for (const name of actual)
    if (!expected.has(name))
      problems.push(`${assetRoot}/reviewed/${name}: not built from a deployable manifest`);
  for (const [name, bytes] of expected)
    if (!same(read(join(reviewedDir, name)), bytes))
      problems.push(
        `${assetRoot}/reviewed/${name}: stale, run \`pnpm --filter @clockgrove/assets run build\``,
      );
  for (const f of files) {
    const refusals = assetDeployRefusals(f.manifest);
    const entry = `"assetId":"${f.manifest.assetId}","animationFamily":"${f.manifest.animationFamily}"`;
    for (const name of actual.filter((n) => n.endsWith(".animations.json")))
      if (refusals.length > 0 && readFileSync(join(reviewedDir, name), "utf8").includes(entry))
        for (const r of refusals)
          problems.push(`${assetRoot}/reviewed/${name}: ${r.code} ${r.asset}: ${r.detail}`);
  }
  if (files.length > 0 && !same(read(reportPath), Buffer.from(licenseReport(layout))))
    problems.push(`${assetRoot}/license-report.md: stale, run the asset build command`);

  const scenes = files.length > 0 ? readPackScenes(root, worldRoot) : [];
  if (external && files.length > 0 && scenes.length === 0)
    problems.push("GOLDEN_SCENE_REQUIRED: world presentation metadata is missing");
  for (const scene of scenes) {
    const paths = goldenPaths(root, scene.packDir, assetRoot);
    const golden = readGolden(paths.record);
    if (golden === null) {
      problems.push(`golden ${scene.packDir}: no golden scene; ${regenerate}`);
      continue;
    }
    try {
      const png = render(scene, golden);
      if (!same(read(paths.image), png) || sha256Hex(png) !== golden.sceneSha256)
        problems.push(`visual diff: ${scene.packDir} golden scene changed; ${regenerate}`);
      else if (
        golden.approval.status !== "approved" ||
        golden.approval.approvedSceneSha256 !== golden.sceneSha256
      )
        problems.push(
          `golden ${scene.packDir}: not human-approved for sceneSha256 ${golden.sceneSha256}`,
        );
    } catch (error) {
      problems.push(`golden ${scene.packDir}: ${(error as Error).message}`);
    }
  }
  return problems;
}

function build(): void {
  const expected = expectedReviewed();
  rmSync(reviewedDir, { recursive: true, force: true });
  if (expected.size > 0) mkdirSync(reviewedDir, { recursive: true });
  for (const [name, bytes] of expected) writeFileSync(join(reviewedDir, name), bytes);
  if (files.length > 0) writeFileSync(reportPath, licenseReport(layout));
}

function updateGolden(): void {
  for (const scene of readPackScenes(root, worldRoot)) {
    const paths = goldenPaths(root, scene.packDir, assetRoot);
    const previous = readGolden(paths.record);
    const record: GoldenRecord = previous ?? {
      camera: { originXMm: 0, originYMm: 0, mmPerPixel: 50, width: 800, height: 600 },
      simulationTimeMs: 43_200_000,
      rainIntensity: 0,
      selectedObjectId: scene.presentation.bindings[0]?.objectId ?? null,
      sceneSha256: "",
      approval: { status: "pending", reviewer: null, approvedSceneSha256: null },
    };
    const png = render(scene, record);
    const sceneSha256 = sha256Hex(png);
    const approval =
      sceneSha256 === record.sceneSha256
        ? record.approval
        : { status: "pending" as const, reviewer: null, approvedSceneSha256: null };
    mkdirSync(join(root, assetRoot, "goldens"), { recursive: true });
    writeFileSync(paths.image, png);
    writeFileSync(
      paths.record,
      `${JSON.stringify({ ...record, sceneSha256, approval }, null, 2)}\n`,
    );
  }
}

function validateOne(): string[] {
  const path = external ? positional[0] : args[0];
  if (!path || path.startsWith("--")) throw new Error("ASSET_MANIFEST_REQUIRED");
  const absolute = resolve(path);
  if (external && relative(root, absolute).startsWith("..")) throw new Error("ASSET_PATH_INVALID");
  const manifest = decodeAssetManifest(JSON.parse(readFileSync(absolute, "utf8")));
  const profile = readAssetStyleProfile(root, referenceRoot);
  return [
    ...validateSource(
      manifest,
      readFileSync(join(root, external ? "." : "worlds/fixture", manifest.source.path)),
      relative(join(root, external ? "." : "worlds/fixture"), absolute),
      profile,
    ),
    ...assetDeployRefusals(manifest)
      .filter((r) => r.code !== "REVIEW_NOT_APPROVED")
      .map((r) => `${r.code}: ${r.detail}`),
  ];
}
const command = process.argv[2];
if (
  invalidArguments ||
  !["check", "build", "update-golden", "validate"].includes(command ?? "") ||
  (external && (!existsSync(root) || !statSync(root).isDirectory()))
) {
  console.error(
    "usage: clockgrove-assets check | build | update-golden [--world <directory>] | validate <manifest> --world <directory>",
  );
  process.exitCode = 2;
} else {
  try {
    const problems = command === "validate" ? validateOne() : preflight();
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      process.exitCode = 1;
    } else if (command === "validate") {
      process.exitCode = 0;
    } else if (command === "check") {
      const problems = check();
      for (const problem of problems) console.error(problem);
      process.exitCode = problems.length > 0 ? 1 : 0;
    } else if (command === "build") build();
    else updateGolden();
    if (external && !process.exitCode) console.log(JSON.stringify({ status: "ok", command }));
  } catch (error) {
    const internal =
      !(error instanceof Error) || error instanceof TypeError || error instanceof RangeError;
    console.error(error instanceof Error ? error.message : "unexpected internal error");
    process.exitCode = external && internal ? 70 : 1;
  }
}
