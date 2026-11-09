import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  ContractDecodeError,
  decodeFeedSummary,
  decodeFollowDisposition,
  decodeInteractionSummary,
  decodeObserverSceneMessage,
  decodeSceneAsset,
  decodeSceneAudience,
  decodeSceneTransientCue,
  decodeWorldBootState,
} from "../src/index.js";

const fixture = async (name: string) =>
  JSON.parse(
    await readFile(new URL(`./fixtures/realtime-projection/${name}.json`, import.meta.url), "utf8"),
  );
const accepts = (decode: () => unknown) => {
  try {
    decode();
    return true;
  } catch (error) {
    if (error instanceof ContractDecodeError) return false;
    throw error;
  }
};
/** The values a decoder accepts in place of one field, from its closed list plus an outsider. */
const accepted = (closed: readonly string[], decode: (value: string) => unknown) =>
  [...closed, "arbitrary"].filter((value) => accepts(() => decode(value)));

it("accepts exactly each closed scene vocabulary, and each boot state only its own shape", async () => {
  const [cue] = await fixture("cues");
  const [asset] = (await fixture("asset-manifest")).assets;
  const boots: Record<string, unknown>[] = await fixture("boot-resume");
  const { outcomes } = await fixture("navigation");
  const interaction = {
    entityId: "keeper",
    mode: "cognitive",
    actions: [{ kind: "inspect", availability: "enabled" }],
  };
  const feed = { id: "feed", simTimeMs: "0", text: "Rain", sourceEventIds: [] };
  for (const [closed, decode] of [
    [
      ["footstep", "splash", "particle", "sound", "emote", "hover_hint", "animation_transition"],
      (kind) => decodeSceneTransientCue({ ...cue, kind }),
    ],
    [
      ["pending", "approved", "rejected"],
      (status) => decodeSceneAsset({ ...asset, reviewStatus: status }),
    ],
    [
      ["inspectable", "reactive", "cognitive", "interpreted"],
      (mode) => decodeInteractionSummary({ ...interaction, mode }),
    ],
    [
      ["talk", "observe", "inspect", "remember", "history", "influence", "why"],
      (kind) =>
        decodeInteractionSummary({ ...interaction, actions: [{ kind, availability: "enabled" }] }),
    ],
    [
      ["command_grant_required", "conversation_not_permitted"],
      (reason) =>
        decodeInteractionSummary({
          ...interaction,
          actions: [{ kind: "talk", availability: "disabled", reason }],
        }),
    ],
    [["material"], (kind) => decodeFeedSummary({ ...feed, kind })],
    [["observer"], (kind) => decodeSceneAudience({ kind, hash: "audience", spaceIds: [] })],
    [
      ["assets_unavailable", "renderer_unavailable"],
      (reason) => decodeWorldBootState({ ...boots[7], reason }),
    ],
    [
      ["followed", "stayed_within_space"],
      (disposition) => decodeFollowDisposition({ ...outcomes[0], disposition }),
    ],
    [
      ["permission_denied", "target_hidden", "unavailable"],
      (disposition) => decodeFollowDisposition({ ...outcomes[2], disposition }),
    ],
  ] as [readonly string[], (value: string) => unknown][])
    expect(accepted(closed, decode)).toEqual(closed);
  const states = [...new Set(boots.map((boot) => String(boot.state)))];
  const fields = Object.assign({}, ...boots);
  for (const boot of boots) {
    expect(accepted(states, (state) => decodeWorldBootState({ ...boot, state }))).toEqual([
      boot.state,
    ]);
    for (const [field, value] of Object.entries(fields))
      if (!(field in boot))
        expect(
          accepts(() => decodeWorldBootState({ ...boot, [field]: value })),
          field,
        ).toBe(false);
  }
});

it("decodes only the observer lane and type pairs, and only when envelope and payload agree", async () => {
  const snapshot = await fixture("snapshot.golden");
  const patch = await fixture("patch.golden");
  const [cue] = await fixture("cues");
  const { projectionRevision: _revision, ...envelope } = snapshot;
  const transient = { ...envelope, lane: "transient", type: "cue", payload: cue };
  for (const message of [snapshot, patch, transient])
    expect(
      ["projection", "transient", "operator", "arbitrary"].flatMap((lane) =>
        accepted(["snapshot", "patch", "cue"], (type) =>
          decodeObserverSceneMessage({ ...message, lane, type }),
        ).map((type) => `${lane}/${type}`),
      ),
    ).toEqual([`${message.lane}/${message.type}`]);
  for (const message of [
    { ...snapshot, extra: "forbidden" },
    { ...transient, extra: "forbidden" },
    ...["tenantId", "worldId", "timelineId", "spaceId"].map((field) => ({
      ...snapshot,
      [field]: "other",
    })),
    { ...patch, payload: { ...patch.payload, fromRevision: "-1" } },
  ])
    expect(
      accepts(() => decodeObserverSceneMessage(message)),
      JSON.stringify(message),
    ).toBe(false);
});
