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
import { decodeModelAssetManifest } from "@clockgrove/contracts";
import { assetDeployRefusals, decodeAssetManifest } from "@clockgrove/contracts/asset-manifest";
import { atlasLocationProblems, buildAtlases, packAtlas, reviewedFiles } from "./atlas.js";
import { licenseReport } from "./license-report.js";
import { validateModel } from "./model.js";
import {
  decodeAs,
  type GoldenRecord,
  goldenPaths,
  type ManifestFile,
  type ModelManifestFile,
  type PackScene,
  readAssetStyleProfile,
  readGolden,
  readJson,
  readManifests,
  readMaterialSources,
  readModelBytes,
  readModelManifests,
  readModelTargetProfile,
  readPackScenes,
  repositoryRoot,
} from "./repository.js";
import { renderScene } from "./scene.js";
import { goldenApprovalRefusal } from "./upload.js";
import { sha256Hex, validateSource, worldPaletteProblems } from "./validate.js";

/** Invalid command usage: exits 2, like a malformed command line. */
class UsageError extends Error {}

/** One command's exit status and its output lines. */
export interface AssetsCliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs one `clockgrove-assets` command (`argv` without the node and script paths) in this process.
 * The executable writes the result and exits with its status; tests call it directly.
 */
export function runAssetsCli(argv: readonly string[]): AssetsCliResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let status = 0;

  const args = argv.slice(1);
  const worldIndex = args.indexOf("--world");
  const external = worldIndex >= 0;
  const positional = args.filter((_, index) => index !== worldIndex && index !== worldIndex + 1);
  const invalidArguments = external
    ? args.filter((arg) => arg === "--world").length !== 1 ||
      !args[worldIndex + 1] ||
      args[worldIndex + 1]?.startsWith("--") ||
      positional.length !== (argv[0] === "validate" ? 1 : 0)
    : args.length !== (argv[0] === "validate" ? 1 : 0);
  const root = external ? resolve(args[worldIndex + 1] ?? ".") : repositoryRoot;
  const worldRoot = external ? "." : "worlds/fixture";
  const assetRoot = external ? "assets" : "worlds/fixture/assets";
  const referenceRoot = external ? "reference" : "worlds/fixture/reference";
  const fixtures = "packages/contracts/test/fixtures/asset-manifest";
  const regenerate =
    "run `pnpm --filter @clockgrove/assets run update-golden` and get human approval";
  let files: ManifestFile[] = [];
  let models: ModelManifestFile[] = [];
  let deployable: ManifestFile[] = [];
  let layout: ManifestFile["manifest"][] = [];
  let buildProfile: ReturnType<typeof readAssetStyleProfile> | undefined;

  function preflight(): string[] {
    files = readManifests(root, assetRoot);
    models = readModelManifests(root, assetRoot);
    deployable = files.filter((f) => assetDeployRefusals(f.manifest).length === 0);
    layout = files.map((f) => f.manifest);
    // A world with no manifests would otherwise pass while checking nothing (wrong directory,
    // or assets kept elsewhere while presentation metadata binds them).
    if (files.length + models.length === 0)
      return [`ASSETS_REQUIRED: no asset manifests under ${join(root, assetRoot, "manifests")}`];
    const modelProblems = models.length
      ? models.flatMap((f) =>
          validateModel(f.manifest, f.bytes, readModelTargetProfile(root, referenceRoot)),
        )
      : [];
    if (modelProblems.length) return modelProblems;
    if (!files.length) return [];
    const profile = readAssetStyleProfile(root, referenceRoot);
    buildProfile = profile;
    const problems = files.flatMap((f) =>
      validateSource(
        f.manifest,
        f.bytes,
        f.path.replace("worlds/fixture/", ""),
        profile,
        f.materialSources,
      ),
    );
    if (problems.length > 0) return problems;
    const palette = worldPaletteProblems(layout, profile);
    return palette.length > 0 ? palette : atlasLocationProblems(layout);
  }

  function expectedReviewed(): Map<string, Uint8Array> {
    const result = new Map(
      reviewedFiles(buildAtlases(deployable, layout, buildProfile)).map((f) => [f.name, f.bytes]),
    );
    const shippedModels = models.filter((f) => assetDeployRefusals(f.manifest).length === 0);
    if (shippedModels.length) {
      const index: Record<string, unknown> = {};
      for (const f of shippedModels) {
        const name = `${f.manifest.assetId}.glb`;
        result.set(name, f.bytes);
        index[f.manifest.assetId] = { ...f.manifest.output, path: name };
      }
      result.set("models.json", Buffer.from(`${JSON.stringify(index)}\n`));
    }
    return result;
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
      ? [...files, ...models].flatMap((f) =>
          assetDeployRefusals(f.manifest).map((r) => `${r.code} ${r.asset}: ${r.detail}`),
        )
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
    if (
      !same(
        read(reportPath),
        Buffer.from(licenseReport([...layout, ...models.map((f) => f.manifest)])),
      )
    )
      problems.push(`${assetRoot}/license-report.md: stale, run the asset build command`);

    const scenes = readPackScenes(root, worldRoot);
    if (scenes.length === 0 && files.length > 0)
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
        const refusal = goldenApprovalRefusal(golden);
        if (!same(read(paths.image), png) || sha256Hex(png) !== golden.sceneSha256)
          problems.push(`visual diff: ${scene.packDir} golden scene changed; ${regenerate}`);
        else if (refusal !== null) problems.push(`golden ${scene.packDir}: ${refusal}`);
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
    writeFileSync(reportPath, licenseReport([...layout, ...models.map((f) => f.manifest)]));
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
    if (!path || path.startsWith("--")) throw new UsageError("ASSET_MANIFEST_REQUIRED");
    const absolute = resolve(path);
    if (external && relative(root, absolute).startsWith(".."))
      throw new UsageError(`ASSET_PATH_INVALID: ${absolute} is outside the world ${root}`);
    if (!existsSync(absolute) || !statSync(absolute).isFile())
      throw new UsageError(`ASSET_MANIFEST_REQUIRED: ${absolute} is not a file`);
    const json = readJson(absolute);
    if (json.kind === "model") {
      const manifest = decodeAs("ASSET_MANIFEST_INVALID", () =>
        decodeModelAssetManifest(json, path),
      );
      return [
        ...validateModel(
          manifest,
          readModelBytes(join(root, external ? "." : "worlds/fixture"), manifest),
          readModelTargetProfile(root, referenceRoot),
        ),
        ...assetDeployRefusals(manifest)
          .filter((r) => r.code !== "REVIEW_NOT_APPROVED")
          .map((r) => `${r.code} ${r.asset}: ${r.detail}`),
      ];
    }
    const manifest = decodeAs("ASSET_MANIFEST_INVALID", () => decodeAssetManifest(json, path));
    const profile = readAssetStyleProfile(root, referenceRoot);
    // Check that every frame fits an atlas page, without loading the world's other manifests.
    packAtlas([manifest]);
    return [
      ...validateSource(
        manifest,
        readFileSync(join(root, external ? "." : "worlds/fixture", manifest.source.path)),
        relative(join(root, external ? "." : "worlds/fixture"), absolute),
        profile,
        readMaterialSources(root, external ? "." : "worlds/fixture", manifest),
      ),
      ...assetDeployRefusals(manifest)
        .filter((r) => r.code !== "REVIEW_NOT_APPROVED")
        .map((r) => `${r.code} ${r.asset}: ${r.detail}`),
    ];
  }
  const command = argv[0];
  if (
    invalidArguments ||
    !["check", "build", "update-golden", "validate"].includes(command ?? "") ||
    (external && (!existsSync(root) || !statSync(root).isDirectory()))
  ) {
    stderr.push(
      "usage: clockgrove-assets check | build | update-golden [--world <directory>] | validate <manifest> --world <directory>",
    );
    status = 2;
  } else {
    try {
      const problems = command === "validate" ? validateOne() : preflight();
      if (problems.length > 0) {
        for (const problem of problems) stderr.push(problem);
        status = 1;
      } else if (command === "validate") {
        status = 0;
      } else if (command === "check") {
        const problems = check();
        for (const problem of problems) stderr.push(problem);
        status = problems.length > 0 ? 1 : 0;
      } else if (command === "build") build();
      else updateGolden();
      if (external && !status) stdout.push(JSON.stringify({ status: "ok", command }));
    } catch (error) {
      const internal =
        !(error instanceof Error) || error instanceof TypeError || error instanceof RangeError;
      stderr.push(error instanceof Error ? error.message : "unexpected internal error");
      status = error instanceof UsageError ? 2 : external && internal ? 70 : 1;
    }
  }
  const lines = (output: string[]) => output.map((line) => `${line}\n`).join("");
  return { status, stdout: lines(stdout), stderr: lines(stderr) };
}
