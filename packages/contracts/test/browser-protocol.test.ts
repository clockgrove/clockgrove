import { expect, it } from "vitest";
import {
  decodeDiagnosticSceneProjection,
  decodeProjectionMessage,
  decodeRuntimeNoOpRequest,
} from "../src/index.js";

const scope = { tenantId: "tenant", worldId: "world", timelineId: "timeline", spaceId: "space" };

it("refuses authority fields and ambiguous epochs in the public no-op request", () => {
  const request = {
    ...scope,
    commandId: "command",
    actionId: "action",
    eventId: "event",
    authorityDecisionId: "decision",
    routingEpoch: "7",
    authorityEpoch: "7",
    expectedProjectionRevision: "0",
    issuedAt: "2026-10-01T00:00:00Z",
  };
  expect(decodeRuntimeNoOpRequest(request)).toEqual(request);
  expect(() => decodeRuntimeNoOpRequest({ ...request, context: {} })).toThrow();
  expect(() => decodeRuntimeNoOpRequest({ ...request, routingEpoch: "07" })).toThrow();
});

it("decodes the observer world directory and refuses unknown or missing fields at each level", async () => {
  const { decodeWorldDirectory, decodeWorldDirectoryRequest } = await import("../src/index.js");
  const entry = { ...scope, worldLabel: "world", spaceLabel: "space" };
  const directory = { version: 1, entries: [entry] };
  expect(decodeWorldDirectory(directory)).toEqual(directory);
  expect(decodeWorldDirectoryRequest({ version: 1 })).toEqual({ version: 1 });
  const { spaceLabel: _spaceLabel, ...unlabelled } = entry;
  for (const [value, message] of [
    [{ ...directory, grants: [] }, "directory.grants: unknown field"],
    [{ version: 1 }, "directory.entries: missing field"],
    [
      { version: 1, entries: [{ ...entry, grants: [] }] },
      "directory.entries[0].grants: unknown field",
    ],
    [{ version: 1, entries: [unlabelled] }, "directory.entries[0].spaceLabel: missing field"],
  ] as const)
    expect(() => decodeWorldDirectory(value)).toThrow(message);
  expect(() => decodeWorldDirectoryRequest({ version: 1, ...scope })).toThrow(
    "directoryRequest.tenantId: unknown field",
  );
  expect(() => decodeWorldDirectoryRequest({})).toThrow("directoryRequest.version: missing field");
});

it("decodes the observer clock and material feed and refuses raw payloads, open categories and a client calendar", async () => {
  const { decodeWorldStatus, encodeWorldStatus } = await import("../src/index.js");
  const clock = {
    simulationTime: "8726460000",
    runState: "paused",
    speed: 60,
    dayLengthMs: "86400000",
    day: "102",
    timeOfDayMs: "60000",
  };
  const item = {
    id: "event-1",
    simTimeMs: "8726460000",
    kind: "material",
    text: "A resource was offered.",
    sourceEventIds: ["event-1"],
    category: "resource",
    objectId: "grove.snack-dish",
  };
  const status = { version: 1, privacyClass: "public_scene", ...scope, revision: "3", clock };
  const decoded = decodeWorldStatus({ ...status, feed: [item] });
  expect(decoded.feed[0]?.simTimeMs).toBe(8_726_460_000n);
  expect(encodeWorldStatus(decoded)).toEqual({ ...status, feed: [item] });
  const calendarless = { ...clock, dayLengthMs: null, day: null, timeOfDayMs: null };
  expect(decodeWorldStatus({ ...status, clock: calendarless, feed: [] }).clock).toEqual(
    calendarless,
  );
  for (const [value, message] of [
    [{ ...status, feed: [{ ...item, payload: {} }] }, "status.feed[0].payload: unknown field"],
    [{ ...status, feed: [{ ...item, category: "time" }] }, "status.feed[0].category: unsupported"],
    [{ ...status, clock: { ...clock, day: "101" } }, "status.clock: day and time of day must"],
    [{ ...status, clock: { ...clock, runState: "stopped" } }, "status.clock.runState: unsupported"],
  ] as const)
    expect(() => decodeWorldStatus({ feed: [], ...value })).toThrow(message);
});

it("refuses private and operator data in the shared scene at every nesting level", () => {
  const scene = {
    ...scope,
    version: 1,
    privacyClass: "public_scene",
    revision: 0,
    title: "Fixture",
    entities: [{ id: "marker", label: "Marker", description: "Stationary" }],
  };
  expect(decodeDiagnosticSceneProjection(scene)).toEqual(scene);
  expect(() =>
    decodeDiagnosticSceneProjection({ ...scene, privacyClass: "operator_evidence" }),
  ).toThrow();
  expect(() =>
    decodeDiagnosticSceneProjection({
      ...scene,
      entities: [{ ...scene.entities[0], beliefs: [] }],
    }),
  ).toThrow();
});

it("decodes lossless public observation and excludes private fields at every nested boundary", async () => {
  const { decodeLivingScene, decodeObservationRequest } = await import("../src/index.js");
  const request = { ...scope, version: 1 };
  const frame = {
    frameId: "hall-frame",
    version: 1,
    dimensions: 2,
    unit: { name: "millimetre", fractionalDigits: 0 },
    axes: {
      axes: [
        { name: "x", positiveDirection: "east" },
        { name: "y", positiveDirection: "north" },
      ],
    },
    origin: ["0", "0"],
    gravity: { kind: "constant-vector", vector: ["0", "-9800"] },
  };
  const entity = {
    objectId: "resident",
    archetypeId: "resident",
    pose: { frameId: "hall-frame", frameVersion: 1, coordinates: ["-9007199254740993", "2"] },
    presentation: { kind: "placeholder", label: "Resident" },
  };
  const scene = {
    ...request,
    privacyClass: "public_scene",
    revision: "9007199254740993",
    simulationTime: "9007199254740995",
    weather: { rainIntensity: 6000 },
    frames: [frame],
    entities: [entity],
  };
  expect(decodeObservationRequest(request)).toEqual(request);
  expect(decodeLivingScene(scene)).toEqual(scene);
  expect(() => decodeObservationRequest({ ...request, context: {} })).toThrow();
  expect(() => decodeObservationRequest({ ...request, version: 2 })).toThrow();
  expect(() => decodeLivingScene({ ...scene, version: 2 })).toThrow();
  expect(() => decodeLivingScene({ ...scene, privacyClass: "private_cognition" })).toThrow();
  expect(() => decodeLivingScene({ ...scene, revision: 9007199254740992 })).toThrow();
  expect(() => decodeLivingScene({ ...scene, simulationTime: "-1" })).toThrow();
  expect(() => decodeLivingScene({ ...scene, revision: "01" })).toThrow();
  expect(() => decodeLivingScene({ ...scene, context: {} })).toThrow();
  expect(() =>
    decodeLivingScene({ ...scene, weather: { rainIntensity: 6000, secrets: [] } }),
  ).toThrow();
  expect(() => decodeLivingScene({ ...scene, weather: { rainIntensity: 10001 } })).toThrow();
  expect(() => decodeLivingScene({ ...scene, frames: [{ ...frame, secrets: [] }] })).toThrow();
  expect(() =>
    decodeLivingScene({ ...scene, frames: [{ ...frame, unit: { ...frame.unit, secrets: [] } }] }),
  ).toThrow();
  expect(() =>
    decodeLivingScene({ ...scene, frames: [{ ...frame, axes: { ...frame.axes, secrets: [] } }] }),
  ).toThrow();
  expect(() =>
    decodeLivingScene({
      ...scene,
      frames: [
        {
          ...frame,
          axes: {
            axes: [{ name: "x", positiveDirection: "east", secrets: [] }, frame.axes.axes[1]],
          },
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    decodeLivingScene({
      ...scene,
      frames: [{ ...frame, gravity: { ...frame.gravity, secrets: [] } }],
    }),
  ).toThrow();
  expect(() => decodeLivingScene({ ...scene, entities: [{ ...entity, secrets: [] }] })).toThrow();
  expect(() =>
    decodeLivingScene({
      ...scene,
      entities: [{ ...entity, pose: { ...entity.pose, secrets: [] } }],
    }),
  ).toThrow();
  expect(() =>
    decodeLivingScene({
      ...scene,
      entities: [{ ...entity, presentation: { ...entity.presentation, secrets: [] } }],
    }),
  ).toThrow();
  expect(() =>
    decodeLivingScene({
      ...scene,
      entities: [{ ...entity, pose: { ...entity.pose, frameVersion: 2 } }],
    }),
  ).toThrow();
  expect(() =>
    decodeLivingScene({
      ...scene,
      entities: [{ ...entity, pose: { ...entity.pose, coordinates: ["-0", "2"] } }],
    }),
  ).toThrow();
  expect(() => decodeLivingScene({ ...scene, entities: [entity, entity] })).toThrow();
  const parentTransform = {
    version: 1,
    translation: ["1", "-2"],
    basis: [
      ["1", "0"],
      ["0", "1"],
    ],
  };
  const child = { ...frame, frameId: "child", parentFrameId: "hall-frame", parentTransform };
  expect(decodeLivingScene({ ...scene, frames: [frame, child] }).frames).toEqual([frame, child]);
  expect(() =>
    decodeLivingScene({
      ...scene,
      frames: [frame, { ...child, parentTransform: { ...parentTransform, secrets: [] } }],
    }),
  ).toThrow();
});

it("decodes closed selected state with lossless time and descending command-bearing history", async () => {
  const { decodeEntitySelection, decodeEntitySelectionRequest } = await import("../src/index.js");
  const request = {
    ...scope,
    version: 1,
    objectId: "resident",
    cursor: { observedRevision: "9007199254740993", beforeSequence: "12" },
  };
  const needs = {
    hunger: 3000,
    wetness: 4000,
    integratedAt: "9007199254740995",
    hungerRemainder: "5",
    wetnessRemainder: "7",
  };
  const wellbeing = {
    thirst: 2000,
    health: 9000,
    comfort: "comfortable",
    integratedAt: "9007199254740995",
    thirstRemainder: "3",
    healthRemainder: "9",
  };
  const plant = {
    stage: 1,
    growingMs: "9007199254740996",
    wetness: 6000,
    wetnessRemainder: "2",
    integratedAt: "9007199254740995",
  };
  const action = {
    eventId: "event-two",
    actionId: "action-two",
    commandId: "command-two",
    type: "routine.action-selected",
    partitionSequence: "11",
    simulationTime: "9007199254740995",
    recordedAt: "2026-10-28T10:00:00.000Z",
  };
  const selection = {
    ...scope,
    version: 1,
    objectId: "resident",
    privacyClass: "public_scene",
    evidence: {
      entity: "canonical",
      physical: "canonical",
      derived: "derived",
      history: "canonical",
    },
    revision: "9007199254740993",
    simulationTime: "9007199254740995",
    entity: {
      objectId: "resident",
      archetypeId: "resident@1",
      pose: { frameId: "frame", frameVersion: 1, coordinates: ["-1", "2"] },
      presentation: { kind: "placeholder", label: "Resident" },
    },
    physical: {
      needs,
      wellbeing,
      plant,
      resource: { kind: "food", quantity: 2 },
      shelter: { rainProtection: 5000 },
      locationId: "den",
      selectedAction: { kind: "seek-food", targetObjectId: "bowl" },
      lifecycle: "active",
    },
    derived: {
      canonical: false,
      simulationTime: "9007199254741000",
      needs: { ...needs, hunger: 3001, integratedAt: "9007199254741000" },
      wellbeing: { thirst: 2001, health: 8999, thirstRemainder: "4", healthRemainder: "10" },
      plant: { growingMs: "9007199254740999", wetness: 6001, wetnessRemainder: "3" },
    },
    history: {
      observedRevision: "9007199254740993",
      actions: [
        action,
        {
          ...action,
          eventId: "event-one",
          actionId: "action-one",
          commandId: "command-one",
          partitionSequence: "9",
        },
      ],
      beforeSequence: "8",
    },
  };
  expect(decodeEntitySelectionRequest(request)).toEqual(request);
  expect(decodeEntitySelection(selection)).toEqual(selection);
  expect(
    decodeEntitySelection({
      ...selection,
      physical: {
        needs: null,
        wellbeing: null,
        plant: null,
        resource: null,
        shelter: null,
        locationId: null,
        selectedAction: null,
        lifecycle: null,
      },
      derived: {
        canonical: false,
        simulationTime: selection.simulationTime,
        needs: null,
        wellbeing: null,
        plant: null,
      },
      history: { observedRevision: selection.revision, actions: [], beforeSequence: null },
    }),
  ).toEqual({
    ...selection,
    physical: {
      needs: null,
      wellbeing: null,
      plant: null,
      resource: null,
      shelter: null,
      locationId: null,
      selectedAction: null,
      lifecycle: null,
    },
    derived: {
      canonical: false,
      simulationTime: selection.simulationTime,
      needs: null,
      wellbeing: null,
      plant: null,
    },
    history: { observedRevision: selection.revision, actions: [], beforeSequence: null },
  });
  expect(() => decodeEntitySelectionRequest({ ...request, authority: [] })).toThrow();
  expect(() =>
    decodeEntitySelectionRequest({
      ...request,
      cursor: { ...request.cursor, privateData: [] },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelectionRequest({
      ...request,
      cursor: { ...request.cursor, beforeSequence: "01" },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      privacyClass: "private_cognition",
    }),
  ).toThrow();
  expect(() => decodeEntitySelection({ ...selection, objectId: "different" })).toThrow();
  expect(() => decodeEntitySelection({ ...selection, revision: 9007199254740992 })).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      physical: { ...selection.physical, needs: { ...needs, thoughts: [] } },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      physical: { ...selection.physical, wellbeing: { ...wellbeing, thoughts: [] } },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      physical: { ...selection.physical, plant: { ...plant, thoughts: [] } },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      physical: { ...selection.physical, resource: { kind: "food", quantity: 2, privateData: [] } },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      physical: { ...selection.physical, shelter: { rainProtection: 5000, privateData: [] } },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      physical: {
        ...selection.physical,
        selectedAction: { kind: "stay", targetObjectId: null, privateData: [] },
      },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      derived: { ...selection.derived, canonical: true },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      derived: { ...selection.derived, simulationTime: "0" },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      derived: {
        ...selection.derived,
        wellbeing: { ...selection.derived.wellbeing, privateData: [] },
      },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      derived: { ...selection.derived, plant: { ...selection.derived.plant, privateData: [] } },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      history: { ...selection.history, actions: [...selection.history.actions].reverse() },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      history: { ...selection.history, observedRevision: "0" },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      history: { ...selection.history, beforeSequence: "12" },
    }),
  ).toThrow();
  expect(() =>
    decodeEntitySelection({
      ...selection,
      history: { ...selection.history, actions: [{ ...action, payload: {} }] },
    }),
  ).toThrow();
});

it("preserves immutable recorded Why evidence and distinguishes absent, redacted and empty decisions", async () => {
  const {
    ContractDecodeError,
    decodeRecordedWhy,
    decodeRecordedWhyRequest,
    decodePublicRoutineDraft,
  } = await import("../src/index.js");
  const request = { ...scope, version: 1, commandId: "original-command" };
  const stay = { kind: "stay", targetObjectId: null };
  const trace = {
    draftIndex: 2,
    schemaVersion: 1,
    objectId: "resident",
    inputRevision: "9007199254740993",
    simulationTime: "9007199254740995",
    policyVersion: "routine-v1",
    selectionTier: "utility",
    candidates: [
      {
        action: stay,
        features: [{ name: "hunger", value: "3000" }],
        score: "-9007199254740997",
        excludedReason: null,
      },
      {
        action: { kind: "seek-shelter", targetObjectId: "shelter" },
        features: [{ name: "protection", value: "0" }],
        score: "0",
        excludedReason: "no-rain-protection",
      },
    ],
    selectedAction: stay,
  };
  const why = {
    ...request,
    privacyClass: "public_scene",
    evidence: {
      receipt: "canonical",
      traces: "canonical",
      schedules: "canonical",
      links: "derived",
    },
    entry: { kind: "command" },
    actionId: "original-action",
    receiptStatus: "committed",
    traces: { status: "available", drafts: [trace] },
    schedules: [],
    links: { parents: ["cause"], children: ["continuation"] },
  };
  expect(decodeRecordedWhyRequest(request)).toEqual(request);
  expect(decodeRecordedWhyRequest({ ...request, commandId: "a".repeat(1024) })).toHaveProperty(
    "commandId",
    "a".repeat(1024),
  );
  expect(() => decodeRecordedWhyRequest({ ...request, commandId: "a".repeat(1025) })).toThrow(
    ContractDecodeError,
  );
  expect(() => decodeRecordedWhyRequest({ ...request, commandId: "é".repeat(513) })).toThrow(
    ContractDecodeError,
  );
  expect(decodeRecordedWhy(why)).toEqual(why);
  const retained = {
    kind: "routine",
    decision: {
      schemaVersion: 1,
      objectId: "resident",
      inputRevision: 9007199254740993n,
      simulationTime: 9007199254740995n,
      policyVersion: "routine-v1",
      selectionTier: "utility",
      candidates: [
        { action: { kind: "stay" }, features: { hunger: 3000n }, score: -9007199254740997n },
        {
          action: { kind: "seek-shelter", targetObjectId: "shelter" },
          features: { protection: 0n },
          score: 0n,
          excludedReason: "no-rain-protection",
        },
      ],
      selectedAction: { kind: "stay" },
      perceptionRefs: ["private-perception"],
      beliefRefs: ["private-belief"],
      memoryRefs: ["private-memory"],
      randomDraws: ["private-draw"],
      outcomeLinks: ["private-link"],
    },
  };
  expect(decodePublicRoutineDraft(retained, 2)).toEqual(trace);
  for (const status of ["available", "unavailable", "redacted"]) {
    expect(decodeRecordedWhy({ ...why, traces: { status, drafts: [] } }).traces).toEqual({
      status,
      drafts: [],
    });
  }
  for (const status of ["unavailable", "redacted"]) {
    expect(() => decodeRecordedWhy({ ...why, traces: { status, drafts: [trace] } })).toThrow(
      ContractDecodeError,
    );
  }
  expect(() => decodeRecordedWhyRequest({ ...request, context: {} })).toThrow(ContractDecodeError);
  expect(() => decodeRecordedWhyRequest({ ...request, expectedRevision: "1" })).toThrow(
    ContractDecodeError,
  );
  expect(() => decodeRecordedWhy({ ...why, decision: {} })).toThrow(ContractDecodeError);
  expect(() => decodeRecordedWhy({ ...why, privacyClass: "private_cognition" })).toThrow(
    ContractDecodeError,
  );
  expect(() => decodeRecordedWhy({ ...why, links: { ...why.links, authorization: {} } })).toThrow(
    ContractDecodeError,
  );
  expect(() => decodeRecordedWhy({ ...why, traces: { ...why.traces, receipt: {} } })).toThrow(
    ContractDecodeError,
  );
  for (const extra of [
    { ...trace, beliefRefs: [] },
    { ...trace, inputRevision: "01" },
    { ...trace, simulationTime: 9007199254740992 },
    { ...trace, draftIndex: -1 },
    { ...trace, candidates: [{ ...trace.candidates[0], score: "-0" }] },
    { ...trace, candidates: [{ ...trace.candidates[0], credential: "secret" }] },
    {
      ...trace,
      candidates: [{ ...trace.candidates[0], features: [{ name: "credential", value: "1" }] }],
    },
    {
      ...trace,
      candidates: [
        {
          ...trace.candidates[0],
          features: [{ name: "hunger", value: "1", identity: "provider" }],
        },
      ],
    },
    { ...trace, candidates: [{ ...trace.candidates[0], excludedReason: "private-sentinel" }] },
    { ...trace, selectedAction: { ...stay, context: {} } },
  ]) {
    expect(() =>
      decodeRecordedWhy({ ...why, traces: { status: "available", drafts: [extra] } }),
    ).toThrow(ContractDecodeError);
  }
});

it("preserves diagnostic v1 snapshot, whole-list patch and unavailable meanings", () => {
  const correlationId = "diagnostic-correlation";
  const entities = [{ id: "marker", label: "Marker", description: "Stationary" }];
  const scene = {
    ...scope,
    version: 1,
    privacyClass: "public_scene",
    revision: 3,
    title: "Diagnostic",
    entities,
  };
  const messages = [
    { version: 1, type: "snapshot", correlationId, scene },
    { version: 1, type: "patch", correlationId, scope, fromRevision: 3, revision: 4, entities },
    { version: 1, type: "unavailable", correlationId },
  ];
  expect(messages.map(decodeProjectionMessage)).toEqual(messages);
  expect(() => decodeProjectionMessage({ ...messages[1], fromRevision: 4 })).toThrow(
    "patch must advance revision",
  );
});
