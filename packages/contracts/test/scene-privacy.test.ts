import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  ContractDecodeError,
  decodeObserverSceneMessage,
  decodePrivateCaretakerTalk,
} from "../src/index.js";

it("refuses every private sentinel, private talk, operator lanes and nested extensions", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/realtime-projection/privacy.json", import.meta.url), "utf8"),
  );
  expect(fixture.excluded).toEqual({
    privateCognition: "sentinel-private-cognition",
    hiddenEntity: "sentinel-hidden-entity",
    rawEvent: "sentinel-raw-event",
    secretSentinel: "sentinel-secret-value",
    providerIdentity: "sentinel-provider-identity",
    irrelevantGrant: "sentinel-irrelevant-grant",
  });
  const observer = JSON.parse(
    await readFile(
      new URL("./fixtures/realtime-projection/snapshot.golden.json", import.meta.url),
      "utf8",
    ),
  );
  for (const [field, sentinel] of Object.entries(fixture.excluded)) {
    expect(() =>
      decodeObserverSceneMessage({
        ...observer,
        payload: { ...observer.payload, [field]: sentinel },
      }),
    ).toThrow(ContractDecodeError);
    expect(() =>
      decodeObserverSceneMessage({
        ...observer,
        payload: {
          ...observer.payload,
          entities: [{ ...observer.payload.entities[0], [field]: sentinel }],
        },
      }),
    ).toThrow(ContractDecodeError);
  }
  expect(decodePrivateCaretakerTalk(fixture.privateTalk).principalId).toBe("principal-caretaker");
  expect(() => decodeObserverSceneMessage(fixture.privateTalk)).toThrow(ContractDecodeError);
  for (const message of [
    {
      ...observer,
      lane: "operator",
      type: "diagnostic",
      payload: { rawEvent: fixture.excluded.rawEvent },
    },
    {
      ...observer,
      lane: "projection",
      type: "private_caretaker_talk",
      payload: fixture.privateTalk,
    },
    {
      ...observer,
      lane: "transient",
      type: "private_caretaker_talk",
      payload: fixture.privateTalk,
    },
  ])
    expect(() => decodeObserverSceneMessage(message)).toThrow(
      "message is not an observer projection or transient cue",
    );
  const projection = observer.payload;
  for (const payload of [
    {
      ...projection,
      hierarchy: [{ ...projection.hierarchy[0], secret: fixture.excluded.secretSentinel }],
    },
    {
      ...projection,
      presentationBindings: [
        {
          ...projection.presentationBindings[0],
          providerIdentity: fixture.excluded.providerIdentity,
        },
      ],
    },
    {
      ...projection,
      interactions: [
        { ...projection.interactions[0], irrelevantGrant: fixture.excluded.irrelevantGrant },
      ],
    },
  ])
    expect(() => decodeObserverSceneMessage({ ...observer, payload })).toThrow(ContractDecodeError);
});
