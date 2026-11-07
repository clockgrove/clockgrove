import type { ObjectId } from "@clockgrove/contracts";
import {
  deriveLifecycleSeason,
  type LifecycleEntry,
  type LifecyclePolicy,
  type LifecycleState,
  type NamedRandomState,
  type RandomDrawMetadata,
} from "@clockgrove/domain";
import { drawNamedRandomStream } from "../random.js";
import { lifecycleChildId } from "./ids.js";

export const LIFECYCLE_STREAM = "lifecycle";
export const CONCEPTION_DECISION_KIND = "lifecycle.conception";

export type ConceptionExclusion =
  | "not-fertile-stage"
  | "gestating"
  | "cooldown"
  | "out-of-season"
  | "no-co-parent"
  | "population-cap";

/** One conception attempt of one candidate: its exclusion or draw, and the outcome. */
export interface ConceptionDecision {
  readonly schemaVersion: 1;
  readonly objectId: ObjectId;
  readonly simulationTime: bigint;
  readonly stageIndex: number;
  readonly stageName: string;
  readonly conceptionChance: number;
  readonly exclusion: ConceptionExclusion | null;
  readonly draw: Readonly<{ drawIndex: bigint; rawValue: bigint; value: number }> | null;
  readonly outcome: "excluded" | "conceived" | "not-conceived";
  readonly coParentId: ObjectId | null;
  readonly childId: ObjectId | null;
}

export type LifecycleAction =
  | Readonly<{ kind: "died"; objectId: ObjectId; cause: "lifespan" | "health" }>
  | Readonly<{ kind: "stage"; objectId: ObjectId; stageIndex: number; stageName: string }>
  | Readonly<{
      kind: "milestone";
      objectId: ObjectId;
      childId: ObjectId;
      milestoneIndex: number;
      milestoneName: string;
    }>
  | Readonly<{
      kind: "born";
      childId: ObjectId;
      gestatingParentId: ObjectId;
      coParentId: ObjectId | null;
      /** The gestating parent's household, inherited by the child. */
      householdId: string;
    }>
  | Readonly<{
      kind: "conceived";
      objectId: ObjectId;
      coParentId: ObjectId | null;
      childId: ObjectId;
      dueAt: bigint;
      draw: RandomDrawMetadata;
    }>;

export interface LifecyclePlan {
  readonly actions: readonly LifecycleAction[];
  readonly decisions: readonly Readonly<{
    decision: ConceptionDecision;
    draws: readonly RandomDrawMetadata[];
  }>[];
  readonly random: NamedRandomState;
  /** Objects that die in this plan (so the caller can integrate them first). */
  readonly dying: readonly ObjectId[];
  /** Objects born in this plan. */
  readonly births: readonly ObjectId[];
}

interface Overlay {
  readonly objectId: ObjectId;
  readonly householdId: string;
  readonly generation: number;
  readonly bornAt: bigint;
  stageIndex: number;
  conceptions: number;
  lastBirthAt: bigint | null;
  gestation: LifecycleEntry["gestation"];
  dead: boolean;
}

const byId = (left: string, right: string): number => (left === right ? 0 : left < right ? -1 : 1);

/**
 * Every lifecycle action due at exactly `time`, simulated over a per-actor overlay so that later
 * steps see earlier ones (a death frees its slot, a birth adds an actor). Pure: it neither
 * mutates the state nor the random state it is given.
 *
 * Order: deaths, stage changes, gestation milestones, births, conceptions; each in object id order.
 */
export function planLifecycleAt(
  policy: LifecyclePolicy,
  lifecycle: LifecycleState,
  time: bigint,
  healthDeaths: ReadonlySet<string>,
  random: NamedRandomState,
): LifecyclePlan {
  const reproduction = policy.reproduction;
  const overlay = new Map<string, Overlay>(
    lifecycle.entries.map((entry) => [
      entry.objectId,
      {
        objectId: entry.objectId,
        householdId: entry.householdId,
        generation: entry.generation,
        bornAt: entry.bornAt,
        stageIndex: entry.stageIndex,
        conceptions: entry.conceptions,
        lastBirthAt: entry.lastBirthAt,
        gestation: entry.gestation,
        dead: entry.death !== null,
      },
    ]),
  );
  const ordered = (): Overlay[] =>
    [...overlay.values()].sort((a, b) => byId(a.objectId, b.objectId));
  const actions: LifecycleAction[] = [];
  const dying: ObjectId[] = [];
  const births: ObjectId[] = [];
  const decisions: { decision: ConceptionDecision; draws: readonly RandomDrawMetadata[] }[] = [];
  let stream = random;

  for (const actor of ordered()) {
    if (actor.dead) continue;
    const cause = healthDeaths.has(actor.objectId)
      ? "health"
      : actor.bornAt + policy.lifespanMs <= time
        ? "lifespan"
        : undefined;
    if (cause === undefined) continue;
    actor.dead = true;
    actor.gestation = null;
    dying.push(actor.objectId);
    actions.push({ kind: "died", objectId: actor.objectId, cause });
  }
  for (const actor of ordered()) {
    if (actor.dead) continue;
    while (
      actor.stageIndex + 1 < policy.stages.length &&
      actor.bornAt + policy.stages[actor.stageIndex + 1]!.startsAtAgeMs <= time
    ) {
      actor.stageIndex += 1;
      actions.push({
        kind: "stage",
        objectId: actor.objectId,
        stageIndex: actor.stageIndex,
        stageName: policy.stages[actor.stageIndex]!.name,
      });
    }
  }
  for (const actor of ordered()) {
    const gestation = actor.gestation;
    if (actor.dead || gestation === null) continue;
    let index = gestation.milestoneIndex;
    while (
      index < reproduction.gestationMilestones.length &&
      gestation.conceivedAt + reproduction.gestationMilestones[index]!.atMs <= time
    ) {
      actions.push({
        kind: "milestone",
        objectId: actor.objectId,
        childId: gestation.childId,
        milestoneIndex: index,
        milestoneName: reproduction.gestationMilestones[index]!.name,
      });
      index += 1;
    }
    actor.gestation = { ...gestation, milestoneIndex: index };
  }
  for (const actor of ordered()) {
    const gestation = actor.gestation;
    if (actor.dead || gestation === null || gestation.dueAt > time) continue;
    actions.push({
      kind: "born",
      childId: gestation.childId,
      gestatingParentId: actor.objectId,
      coParentId: gestation.coParentId,
      householdId: actor.householdId,
    });
    births.push(gestation.childId);
    const coParent = gestation.coParentId === null ? undefined : overlay.get(gestation.coParentId);
    overlay.set(gestation.childId, {
      objectId: gestation.childId,
      householdId: actor.householdId,
      generation: Math.max(actor.generation, coParent?.generation ?? 0) + 1,
      bornAt: time,
      stageIndex: 0,
      conceptions: 0,
      lastBirthAt: null,
      gestation: null,
      dead: false,
    });
    actor.lastBirthAt = time;
    actor.gestation = null;
  }
  if (time > 0n && time % reproduction.conceptionIntervalMs === 0n) {
    const fertile = (actor: Overlay): boolean =>
      reproduction.fertileStages.includes(policy.stages[actor.stageIndex]!.name);
    const hook = policy.seasonal;
    const seasonAllowed =
      hook === undefined ||
      hook.conceptionSeasons.includes(hook.seasons[deriveLifecycleSeason(hook, time)]!.name);
    for (const actor of ordered()) {
      if (actor.dead) continue;
      const stageName = policy.stages[actor.stageIndex]!.name;
      const living = ordered().filter((candidate) => !candidate.dead);
      const pending = living.filter((candidate) => candidate.gestation !== null).length;
      const coParent =
        reproduction.coParent === "required"
          ? living.find(
              (candidate) =>
                candidate.objectId !== actor.objectId &&
                candidate.householdId === actor.householdId &&
                fertile(candidate),
            )
          : undefined;
      let exclusion: ConceptionExclusion | null = null;
      if (!fertile(actor)) exclusion = "not-fertile-stage";
      else if (actor.gestation !== null) exclusion = "gestating";
      else if (actor.lastBirthAt !== null && time - actor.lastBirthAt < reproduction.cooldownMs)
        exclusion = "cooldown";
      else if (!seasonAllowed) exclusion = "out-of-season";
      else if (reproduction.coParent === "required" && coParent === undefined)
        exclusion = "no-co-parent";
      else if (
        living.length + pending >= reproduction.maxPopulation ||
        overlay.size + pending >= 128
      )
        exclusion = "population-cap";
      const base = {
        schemaVersion: 1 as const,
        objectId: actor.objectId,
        simulationTime: time,
        stageIndex: actor.stageIndex,
        stageName,
        conceptionChance: reproduction.conceptionChance,
      };
      if (exclusion !== null) {
        decisions.push({
          decision: Object.freeze({
            ...base,
            exclusion,
            draw: null,
            outcome: "excluded" as const,
            coParentId: null,
            childId: null,
          }),
          draws: Object.freeze([]),
        });
        continue;
      }
      const drawn = drawNamedRandomStream(stream, LIFECYCLE_STREAM);
      stream = drawn.randomState;
      const value = Number(BigInt.asUintN(32, drawn.draw.rawValue) % 10000n);
      const conceived = value < reproduction.conceptionChance;
      const coParentId =
        reproduction.coParent === "required" ? (coParent!.objectId as ObjectId) : null;
      const childId = conceived ? lifecycleChildId(actor.objectId, actor.conceptions + 1) : null;
      decisions.push({
        decision: Object.freeze({
          ...base,
          exclusion: null,
          draw: Object.freeze({
            drawIndex: drawn.draw.drawIndex,
            rawValue: drawn.draw.rawValue,
            value,
          }),
          outcome: conceived ? ("conceived" as const) : ("not-conceived" as const),
          coParentId: conceived ? coParentId : null,
          childId,
        }),
        draws: Object.freeze([drawn.draw]),
      });
      if (conceived && childId !== null) {
        const dueAt = time + reproduction.gestationMs;
        actor.conceptions += 1;
        actor.gestation = {
          conceivedAt: time,
          dueAt,
          coParentId,
          childId,
          milestoneIndex: 0,
        } as never;
        actions.push({
          kind: "conceived",
          objectId: actor.objectId,
          coParentId,
          childId,
          dueAt,
          draw: drawn.draw,
        });
      }
    }
  }
  return Object.freeze({
    actions: Object.freeze(actions),
    decisions: Object.freeze(decisions),
    random: stream,
    dying: Object.freeze(dying),
    births: Object.freeze(births),
  });
}

/**
 * The next simulation time strictly after `after` at which the lifecycle has something to do for
 * the current state: a conception multiple, milestone, birth, stage threshold or lifespan death.
 */
export function nextLifecycleTime(
  policy: LifecyclePolicy,
  lifecycle: LifecycleState,
  after: bigint,
): bigint | undefined {
  const interval = policy.reproduction.conceptionIntervalMs;
  let next: bigint | undefined = (after / interval + 1n) * interval;
  if (after < 0n) next = interval;
  const consider = (time: bigint): void => {
    if (time > after && (next === undefined || time < next)) next = time;
  };
  for (const entry of lifecycle.entries) {
    if (entry.death !== null) continue;
    consider(entry.bornAt + policy.lifespanMs);
    const stage = policy.stages[entry.stageIndex + 1];
    if (stage !== undefined) consider(entry.bornAt + stage.startsAtAgeMs);
    const gestation = entry.gestation;
    if (gestation !== null) {
      consider(gestation.dueAt);
      const milestone = policy.reproduction.gestationMilestones[gestation.milestoneIndex];
      if (milestone !== undefined) consider(gestation.conceivedAt + milestone.atMs);
    }
  }
  return next;
}
