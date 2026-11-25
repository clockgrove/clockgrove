import type { AssetStyleProfile } from "@clockgrove/contracts";
import { type AssetManifest, assetDeployRefusals } from "@clockgrove/contracts/asset-manifest";
import { type ApproverRegistry, approverRefusal, type GoldenApprover } from "./approval.js";
import { type AssetEntry, buildAtlases, canonicalJson, reviewedFiles } from "./atlas.js";
import { sha256Hex } from "./validate.js";

export interface ContentAddressedAssetStore {
  head(key: string): Promise<boolean>;
  put(
    key: string,
    bytes: Uint8Array,
    options: { sha256: string; contentType: string },
  ): Promise<void>;
}

/** The slice of a Cloudflare R2 bucket binding the adapter uses, declared here so no provider type leaks in. */
export interface R2BucketLike {
  head(key: string): Promise<unknown | null>;
  put(
    key: string,
    value: Uint8Array,
    options: { sha256: string; httpMetadata: { contentType: string } },
  ): Promise<unknown>;
}

export function r2AssetStore(binding: R2BucketLike): ContentAddressedAssetStore {
  return {
    head: async (key) => (await binding.head(key)) !== null,
    put: async (key, bytes, { sha256, contentType }) => {
      await binding.put(key, bytes, { sha256, httpMetadata: { contentType } });
    },
  };
}

export interface GoldenApproval {
  /** The golden record's file, named in every refusal. */
  readonly file: string;
  readonly sceneSha256: string;
  readonly approval: {
    readonly status: "pending" | "approved";
    readonly approver: GoldenApprover | null;
    readonly approvedSceneSha256: string | null;
  };
}

/**
 * Why a golden scene may not ship; null when it is approved for its current hash by a person the
 * registry lists, or by an agent citing a delegation the registry records (`approverRefusal`).
 */
export function goldenApprovalRefusal(
  golden: GoldenApproval,
  approvers: ApproverRegistry,
): string | null {
  const { approval, sceneSha256, file } = golden;
  if (approval.status !== "approved" || approval.approvedSceneSha256 !== sceneSha256)
    return `GOLDEN_NOT_APPROVED: ${file}: not approved for sceneSha256 ${sceneSha256}`;
  return approverRefusal(approval.approver, approvers, file);
}

/** The store object that names each reviewed file's content key: `{ files: { <name>: "sha256/<hex>" } }`. */
export interface ReviewedDirectory {
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Refuses (uploading nothing) unless every manifest may deploy and the golden scene is approved as
 * it stands by an approver `approvers` recognises. Stores every reviewed file at its content key, then the directory that maps each
 * file's name (`atlases.json`, `<page>.png`, ...) to that key; `directory` is the directory's key.
 */
export async function uploadReviewedAssets(
  store: ContentAddressedAssetStore,
  input: {
    entries: readonly AssetEntry[];
    golden: GoldenApproval;
    /** The repository's approver registry (`readApprovers`). */
    approvers: ApproverRegistry;
    layout?: readonly AssetManifest[];
    profile?: AssetStyleProfile;
  },
): Promise<{ uploaded: string[]; skipped: string[]; directory: string }> {
  const golden = goldenApprovalRefusal(input.golden, input.approvers);
  const refusals = [
    ...input.entries.flatMap((e) =>
      assetDeployRefusals(e.manifest).map((r) => `${r.code} ${r.asset}: ${r.detail}`),
    ),
    ...(golden === null ? [] : [golden]),
  ];
  if (refusals.length > 0) throw new Error(`upload refused:\n${refusals.join("\n")}`);
  const outputs = reviewedFiles(buildAtlases(input.entries, input.layout, input.profile));
  const files: Record<string, string> = {};
  for (const { name, bytes } of outputs) files[name] = `sha256/${sha256Hex(bytes)}`;
  const directory = new TextEncoder().encode(canonicalJson({ files } satisfies ReviewedDirectory));
  outputs.push({ name: "", bytes: directory, contentType: "application/json" });
  const uploaded = new Set<string>();
  const skipped = new Set<string>();
  for (const { bytes, contentType } of outputs) {
    const sha256 = sha256Hex(bytes);
    const key = `sha256/${sha256}`;
    if (uploaded.has(key) || skipped.has(key)) continue;
    if (await store.head(key)) skipped.add(key);
    else {
      await store.put(key, bytes, { sha256, contentType });
      uploaded.add(key);
    }
  }
  return {
    uploaded: [...uploaded].sort(),
    skipped: [...skipped].sort(),
    directory: `sha256/${sha256Hex(directory)}`,
  };
}
