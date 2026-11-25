import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Who approved a golden: a person the repository lists, or an agent acting under a delegation the
 * repository records. A bare name is not an approver.
 */
export type GoldenApprover =
  | { readonly kind: "person"; readonly login: string }
  | { readonly kind: "agent"; readonly agent: string; readonly delegation: string };

/** An owner's standing delegation that lets an agent approve goldens. */
export interface ApprovalDelegation {
  readonly id: string;
  readonly owner: string;
  readonly date: string;
  readonly grant: string;
}

/** The repository's offline record of who may approve goldens (`approvers.json` at its root). */
export interface ApproverRegistry {
  readonly people: readonly { readonly login: string; readonly name?: string }[];
  readonly delegations: readonly ApprovalDelegation[];
}

export const approversFile = "approvers.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Reads `approvers.json` at `root`. A missing file is an empty registry, which recognises nobody;
 * a malformed one is refused with `APPROVERS_INVALID` naming the file.
 */
export function readApprovers(root: string): ApproverRegistry {
  const path = join(root, approversFile);
  if (!existsSync(path)) return { people: [], delegations: [] };
  const invalid = (detail: string) => new Error(`APPROVERS_INVALID: ${path}: ${detail}`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw invalid((error as Error).message);
  }
  if (!isRecord(json) || !Array.isArray(json.people) || !Array.isArray(json.delegations))
    throw invalid("needs `people` and `delegations` arrays");
  json.people.forEach((person, index) => {
    if (!isRecord(person) || !text(person.login))
      throw invalid(`people[${index}] needs a \`login\``);
  });
  const ids = new Set<string>();
  json.delegations.forEach((delegation, index) => {
    if (
      !isRecord(delegation) ||
      !["id", "owner", "date", "grant"].every((k) => text(delegation[k]))
    )
      throw invalid(`delegations[${index}] needs \`id\`, \`owner\`, \`date\` and \`grant\``);
    if (ids.has(delegation.id as string))
      throw invalid(`delegations[${index}] repeats id ${delegation.id}`);
    ids.add(delegation.id as string);
  });
  return json as unknown as ApproverRegistry;
}

/**
 * Why `approver`, as recorded in `file`, does not approve a golden; null when it names a person
 * the registry lists or an agent citing a delegation the registry records.
 */
export function approverRefusal(
  approver: unknown,
  registry: ApproverRegistry,
  file: string,
): string | null {
  if (!isRecord(approver) || (approver.kind !== "person" && approver.kind !== "agent"))
    return `GOLDEN_APPROVER_REQUIRED: ${file}: the approval names no approver; a reviewer name alone is not one`;
  if (approver.kind === "person") {
    const login = approver.login;
    if (!text(login) || login.endsWith("[bot]"))
      return `GOLDEN_REVIEWER_NOT_HUMAN: ${file}: approver ${JSON.stringify(login ?? null)} is not a person's login`;
    return registry.people.some((person) => person.login === login)
      ? null
      : `GOLDEN_APPROVER_UNRECOGNISED: ${file}: person ${JSON.stringify(login)} is not listed in ${approversFile}`;
  }
  const { agent, delegation } = approver;
  if (!text(agent))
    return `GOLDEN_APPROVER_REQUIRED: ${file}: the agent approval does not name the agent`;
  return text(delegation) && registry.delegations.some((d) => d.id === delegation)
    ? null
    : `GOLDEN_DELEGATION_UNRECOGNISED: ${file}: agent ${JSON.stringify(agent)} cites delegation ${JSON.stringify(delegation ?? null)}, which ${approversFile} does not record`;
}
