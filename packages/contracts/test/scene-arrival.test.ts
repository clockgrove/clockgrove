import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  ContractDecodeError,
  decodeChangeViewedSpace,
  decodeFeedSummary,
  decodeFollowDisposition,
  decodeInteractionSummary,
  decodePrivateCaretakerTalk,
  decodePublicSpeech,
  decodeWorldBootState,
} from "../src/index.js";

it("preserves resumable arrival, terminal semantic fallback and authorized viewing contracts", async () => {
  const boots: readonly Record<string, unknown>[] = JSON.parse(
    await readFile(
      new URL("./fixtures/realtime-projection/boot-resume.json", import.meta.url),
      "utf8",
    ),
  );
  const decoded = boots.map(decodeWorldBootState);
  expect(decoded.map((boot) => boot.state)).toEqual([
    "route_resolving",
    "identity_resolved",
    "membership_authorized",
    "joining_space",
    "snapshot_ready",
    "critical_assets_ready",
    "scene_ready",
    "text_ready",
    "text_ready",
  ]);
  expect(decoded).toEqual(
    boots.map((boot) =>
      "projectionRevision" in boot ? { ...boot, projectionRevision: 9007199254740993n } : boot,
    ),
  );
  const textReady = {
    requestId: "arrival-request",
    state: "text_ready",
    progress: { completed: 6, total: 6, resumeToken: "resume-yard" },
    scope: { tenantId: "tenant", worldId: "world", timelineId: "timeline", spaceId: "yard" },
    projectionRevision: 9007199254740993n,
    terminal: true,
    reason: "assets_unavailable",
  };
  expect(decoded[7]).toEqual(textReady);
  expect(decoded[8]).toEqual({ ...textReady, reason: "renderer_unavailable" });
  expect(() => decodeWorldBootState({ ...boots[7], terminal: false })).toThrow(ContractDecodeError);
  expect(() => decodeWorldBootState({ ...boots[7], projectionRevision: undefined })).toThrow(
    ContractDecodeError,
  );
  for (const [boot, completed, total] of [
    [boots[0], 8, 6],
    [boots[0], 6, 6],
    [boots[6], 0, 6],
    [boots[6], 7, 7],
    [boots[7], 5, 6],
  ] as const)
    expect(() =>
      decodeWorldBootState({ ...boot, progress: { completed, total, resumeToken: "resume-yard" } }),
    ).toThrow(ContractDecodeError);
  expect(() => decodeWorldBootState({ ...boots[0], privateState: "hidden" })).toThrow(
    ContractDecodeError,
  );

  const navigation: {
    request: Record<string, unknown>;
    outcomes: readonly Record<string, unknown>[];
    privateTalk: Record<string, unknown>;
    publicSpeech: Record<string, unknown>;
  } = JSON.parse(
    await readFile(
      new URL("./fixtures/realtime-projection/navigation.json", import.meta.url),
      "utf8",
    ),
  );
  expect(decodeChangeViewedSpace(navigation.request)).toEqual(navigation.request);
  const outcomes = navigation.outcomes.map(decodeFollowDisposition);
  expect(outcomes).toEqual(navigation.outcomes);
  expect(outcomes.map((outcome) => [outcome.disposition, outcome.selectedEntityId])).toEqual([
    ["followed", "actor"],
    ["stayed_within_space", "actor"],
    ["permission_denied", null],
    ["target_hidden", null],
    ["unavailable", null],
  ]);
  for (const field of [
    "camera",
    "presenceId",
    "actorMovement",
    "objectTransfer",
    "inventoryPortability",
    "grant",
  ])
    expect(() => decodeChangeViewedSpace({ ...navigation.request, [field]: "forbidden" })).toThrow(
      ContractDecodeError,
    );
  for (const outcome of navigation.outcomes.slice(0, 2)) {
    expect(() => decodeFollowDisposition({ ...outcome, authorized: false })).toThrow(
      ContractDecodeError,
    );
    expect(() => decodeFollowDisposition({ ...outcome, projectable: false })).toThrow(
      ContractDecodeError,
    );
  }
  for (const outcome of navigation.outcomes.slice(2)) {
    expect(() => decodeFollowDisposition({ ...outcome, selectedEntityId: "actor" })).toThrow(
      ContractDecodeError,
    );
    // A refusal never names the destination, hidden or not.
    const hidden = {
      tenantId: "tenant",
      worldId: "world",
      timelineId: "timeline",
      spaceId: "vault",
    };
    expect(() => decodeFollowDisposition({ ...outcome, scope: hidden })).toThrow(
      "followDisposition.scope: unknown field",
    );
  }
  expect(decodePrivateCaretakerTalk(navigation.privateTalk)).toEqual(navigation.privateTalk);
  expect(decodePublicSpeech(navigation.publicSpeech)).toEqual(navigation.publicSpeech);
  expect(() => decodePublicSpeech(navigation.privateTalk)).toThrow(ContractDecodeError);
  expect(() => decodePrivateCaretakerTalk(navigation.publicSpeech)).toThrow(ContractDecodeError);
  expect(() =>
    decodePrivateCaretakerTalk({ ...navigation.privateTalk, providerId: "provider" }),
  ).toThrow(ContractDecodeError);
  expect(() =>
    decodePublicSpeech({ ...navigation.publicSpeech, caretakerId: "caretaker-persona" }),
  ).toThrow(ContractDecodeError);
});

it("keeps material summaries and all disclosed interaction modes closed", () => {
  const feed = {
    id: "feed-rain",
    simTimeMs: "9007199254740995",
    kind: "material",
    text: "Rain began",
    sourceEventIds: ["event-rain"],
  };
  expect(decodeFeedSummary(feed)).toEqual({
    id: "feed-rain",
    simTimeMs: 9007199254740995n,
    kind: "material",
    text: "Rain began",
    sourceEventIds: ["event-rain"],
  });
  expect(() => decodeFeedSummary({ ...feed, rawEvent: { private: "hidden" } })).toThrow(
    ContractDecodeError,
  );
  const interactions = [
    {
      entityId: "stone",
      mode: "inspectable",
      actions: [
        { kind: "inspect", availability: "enabled" },
        { kind: "history", availability: "enabled" },
        { kind: "why", availability: "enabled" },
      ],
    },
    {
      entityId: "feeder",
      mode: "reactive",
      actions: [
        { kind: "inspect", availability: "enabled" },
        { kind: "influence", availability: "disabled", reason: "command_grant_required" },
      ],
    },
    {
      entityId: "stevie",
      mode: "cognitive",
      actions: [
        { kind: "observe", availability: "enabled" },
        { kind: "talk", availability: "enabled" },
      ],
    },
    {
      entityId: "tree",
      mode: "interpreted",
      actions: [{ kind: "inspect", availability: "enabled" }],
    },
  ];
  expect(interactions.map((value) => decodeInteractionSummary(value))).toEqual(interactions);
  expect(() =>
    decodeInteractionSummary({ ...interactions[0], actions: ["arbitrary_command"] }),
  ).toThrow(ContractDecodeError);
  // A denied capability names its reason, and each capability is listed once.
  for (const actions of [
    [{ kind: "influence", availability: "disabled" }],
    [{ kind: "inspect", availability: "enabled", reason: "command_grant_required" }],
    [
      { kind: "why", availability: "enabled" },
      { kind: "why", availability: "enabled" },
    ],
  ])
    expect(() => decodeInteractionSummary({ ...interactions[0], actions })).toThrow(
      ContractDecodeError,
    );
  expect(() => decodeInteractionSummary({ ...interactions[0], grants: ["operator"] })).toThrow(
    ContractDecodeError,
  );
});
