import { currentWorldEventVersion } from "@clockgrove/domain";
import type { WorldPackIssue } from "../errors.js";
import type { ValidatedWorldPack } from "../manifest/types.js";

/**
 * Advisory findings on a validated pack; none refuses it or changes its artifact.
 * `SUPERSEDED_EVENT_VERSION`: an event trigger names a historic version of a world event. It still
 * fires (rule evaluation reads events at their current version) but should name the current one
 * at the rule's next version.
 */
export function lintWorldPack(
  pack: Pick<ValidatedWorldPack, "rules" | "ruleEntries">,
): WorldPackIssue[] {
  return pack.rules.flatMap((rule, index) => {
    const { trigger } = rule;
    if (trigger.kind !== "event") return [];
    const current = currentWorldEventVersion(trigger.eventType, trigger.eventVersion);
    if (current === undefined || current === trigger.eventVersion) return [];
    return [
      {
        code: "SUPERSEDED_EVENT_VERSION",
        path: `${pack.ruleEntries[index]?.path}#rule.trigger.eventVersion`,
        message: `${trigger.eventType}@${trigger.eventVersion} is superseded by @${current}`,
      },
    ];
  });
}
