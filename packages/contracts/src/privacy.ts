import {
  array,
  ContractDecodeError,
  exactKeys,
  freeze,
  literalVersion,
  record,
} from "./validation.js";

export const PRIVACY_CATEGORIES = [
  "public_scene",
  "private_cognition",
  "conversation",
  "credential",
  "operator_evidence",
] as const;

export type PrivacyCategory = (typeof PRIVACY_CATEGORIES)[number];
export type PrivacyClass = PrivacyCategory;

const privacyCategories = new Set<string>(PRIVACY_CATEGORIES);

export interface PrivacyCeiling {
  readonly version: 1;
  readonly allowedCategories: readonly PrivacyCategory[];
}

export function decodePrivacyCategory(value: unknown, path = "privacyClass"): PrivacyCategory {
  if (typeof value !== "string" || !privacyCategories.has(value)) {
    throw new ContractDecodeError(path, "unknown privacy category");
  }
  return value as PrivacyCategory;
}

export function decodePrivacyCeiling(value: unknown, path = "privacyCeiling"): PrivacyCeiling {
  const input = record(value, path);
  exactKeys(input, ["version", "allowedCategories"], [], path);
  literalVersion(input.version, 1, `${path}.version`);
  const categories = array(
    input.allowedCategories,
    `${path}.allowedCategories`,
    decodePrivacyCategory,
  );
  if (new Set(categories).size !== categories.length) {
    throw new ContractDecodeError(`${path}.allowedCategories`, "duplicate category");
  }
  return freeze({ version: 1, allowedCategories: categories });
}

export function isPrivacySubset(candidate: PrivacyCeiling, ceiling: PrivacyCeiling): boolean {
  const allowed = new Set(ceiling.allowedCategories);
  return candidate.allowedCategories.every((category) => allowed.has(category));
}

export function narrowPrivacyCeiling(ceiling: PrivacyCeiling, candidate: unknown): PrivacyCeiling {
  const decoded = decodePrivacyCeiling(candidate, "privacyNarrowing");
  if (!isPrivacySubset(decoded, ceiling)) {
    throw new ContractDecodeError(
      "privacyNarrowing.allowedCategories",
      "cannot broaden privacy ceiling",
    );
  }
  return decoded;
}

export function isSharedSceneEligible(category: PrivacyCategory): boolean {
  return category === "public_scene";
}
