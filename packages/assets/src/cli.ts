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
import {
  decodeModelAssetManifest,
  type ModelImageSet,
  type ModelTierImages,
  modelImageFields,
  modelSideImages,
} from "@clockgrove/contracts";
import { assetDeployRefusals, decodeAssetManifest } from "@clockgrove/contracts/asset-manifest";
import { ImageUtils } from "@gltf-transform/core";
import { approverRefusal, readApprovers } from "./approval.js";
import { atlasLocationProblems, buildAtlases, packAtlas, reviewedFiles } from "./atlas.js";
import { loadKtx2Encoder } from "./ktx2.js";
import { licenseReport } from "./license-report.js";
import { inspectModel, sideImageUris, validateModel } from "./model.js";
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
  readModelLevelSources,
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
 * Runs one `clockgrove-assets` command (`argv` without the node and script paths) in this process,
 * with the KTX2 encoder already loaded (the library entry and the test model fixture load it). Tests
 * call it directly.
 */
export function runAssetsCli(argv: readonly string[]): AssetsCliResult {
  const steps = assetsCli(argv);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * The executable's form of `runAssetsCli`: it loads the KTX2 encoder only once the command's
 * preflight has passed. Loading it is about half of a short command's start, so a command refused
 * at its preflight exits without paying for it. The executable writes the result and exits with its
 * status.
 */
export async function runAssetsCommand(argv: readonly string[]): Promise<AssetsCliResult> {
  const steps = assetsCli(argv);
  let step = steps.next();
  while (!step.done) {
    await loadKtx2Encoder();
    step = steps.next();
  }
  return step.value;
}

/** One command; it yields once its preflight passes, before work that may encode KTX2. */
function* assetsCli(argv: readonly string[]): Generator<void, AssetsCliResult, void> {
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
    "run `pnpm --filter @clockgrove/assets run update-golden` and get it approved by a listed person or a delegated agent";
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
          validateModel(
            f.manifest,
            f.bytes,
            readModelTargetProfile(root, referenceRoot),
            f.levelSources,
          ),
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
        const levels = f.manifest.output.levels?.map((level, index) => {
          if (!level.path) return level;
          const path = index === 0 ? name : `${f.manifest.assetId}.lod-${index}.glb`;
          if (index !== 0) {
            const bytes = f.levelSources?.[level.path];
            if (!bytes) throw new Error(`MODEL_SOURCE_REQUIRED: ${level.path}`);
            result.set(path, bytes);
          }
          return { ...level, path };
        });
        // Side images ship content-named beside the GLB; the index maps each GLB uri to its file.
        const shipped = new Map<string, string>();
        for (const { image } of modelSideImages(f.manifest.output)) {
          const bytes = f.levelSources?.[image.path];
          if (!bytes) throw new Error(`MODEL_SIDE_IMAGE_REQUIRED: ${image.path}`);
          const extension = ImageUtils.getMimeType(bytes) === "image/jpeg" ? "jpg" : "png";
          const file = `${f.manifest.assetId}.${image.sha256}.${extension}`;
          result.set(file, bytes);
          shipped.set(image.path, file);
        }
        const rename = (set: ModelImageSet): ModelImageSet =>
          typeof set.path === "string"
            ? { path: shipped.get(set.path as string)!, sha256: set.sha256 as string }
            : Object.fromEntries(
                Object.entries(set).map(([key, child]) => [key, rename(child as ModelImageSet)]),
              );
        const images = (record: ModelTierImages) =>
          Object.fromEntries(
            modelImageFields.flatMap((key) => (record[key] ? [[key, rename(record[key])]] : [])),
          );
        const { tiers } = f.manifest.output;
        // Only a model with side images has uris to map; skip a second parse of the rest.
        const uris = shipped.size
          ? Object.entries(sideImageUris(f.manifest, inspectModel(f.bytes).imageUris ?? []))
          : [];
        index[f.manifest.assetId] = {
          ...f.manifest.output,
          path: name,
          ...(levels === undefined ? {} : { levels }),
          ...images(f.manifest.output),
          ...(tiers === undefined
            ? {}
            : {
                tiers: Object.fromEntries(
                  Object.entries(tiers).map(([tier, record]) => [tier, images(record)]),
                ),
              }),
          ...(uris.length
            ? { uris: Object.fromEntries(uris.map(([uri, path]) => [uri, shipped.get(path)])) }
            : {}),
        };
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
    // A refused asset still shipped in reviewed/ is named by its animation's fields, whatever the
    // key order or formatting of the animations file.
    const shippedAnimations = actual
      .filter((n) => n.endsWith(".animations.json"))
      .map((name) => {
        let animations: unknown;
        try {
          ({ animations } = JSON.parse(readFileSync(join(reviewedDir, name), "utf8")));
        } catch {
          animations = undefined;
        }
        return { name, animations: Array.isArray(animations) ? animations : [] };
      });
    for (const f of files) {
      const refusals = assetDeployRefusals(f.manifest);
      if (refusals.length === 0) continue;
      for (const { name, animations } of shippedAnimations)
        if (
          animations.some(
            (a) =>
              a?.assetId === f.manifest.assetId &&
              a?.animationFamily === f.manifest.animationFamily,
          )
        )
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

    const approvers = readApprovers(root);
    // The fixture world's visual-golden captures: one review block approves the whole file.
    if (!external) {
      const captures = "tests/visual/approved-captures.json";
      const refusal = approverRefusal(
        readJson(join(root, captures)).review?.approver,
        approvers,
        captures,
      );
      if (refusal !== null) problems.push(refusal);
    }
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
        const refusal = goldenApprovalRefusal(
          { ...golden, file: relative(root, paths.record) },
          approvers,
        );
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
        approval: { status: "pending", approver: null, approvedSceneSha256: null },
      };
      const png = render(scene, record);
      const sceneSha256 = sha256Hex(png);
      const approval =
        sceneSha256 === record.sceneSha256
          ? record.approval
          : { status: "pending" as const, approver: null, approvedSceneSha256: null };
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
          readModelLevelSources(join(root, external ? "." : "worlds/fixture"), manifest),
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
      } else {
        yield;
        if (command === "check") {
          const problems = check();
          for (const problem of problems) stderr.push(problem);
          status = problems.length > 0 ? 1 : 0;
        } else if (command === "build") build();
        else updateGolden();
      }
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
