import { readFile } from "node:fs/promises";
import { ArtifactDecryptionError, KeyEncryptionKeyUnavailableError } from "@clockgrove/application";
import { describe, expect, it } from "vitest";
import { sealArtifactWithNonce } from "../src/artifact-crypto.js";
import type { ArtifactAadFields, DataKeyAadFields } from "../src/index.js";
import {
  artifactAad,
  dataKeyAad,
  generateDataKey,
  InvalidKeyringError,
  openArtifact,
  sealArtifact,
  WebCryptoKeyring,
} from "../src/index.js";

const golden = JSON.parse(
  await readFile(new URL("goldens/artifact-envelope-v1.json", import.meta.url), "utf8"),
);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const artifact: ArtifactAadFields = golden.envelope.fields;
const wrapping: DataKeyAadFields = golden.wrappedDataKey.fields;
const plaintext = new TextEncoder().encode(golden.envelope.plaintext);
const envelope = bytes(golden.envelope.bytes);
const wrapped = bytes(golden.wrappedDataKey.bytes);
const keyring = await WebCryptoKeyring.fromJson(
  JSON.stringify({ version: 1, current: golden.kekId, keys: { [golden.kekId]: golden.kek } }),
);
const dataKey = await keyring.unwrap(golden.kekId, wrapped, dataKeyAad(wrapping));

describe("artifact envelope v1 and data-key wrap formats", () => {
  it("reproduces and opens the pinned golden bytes", async () => {
    expect(artifactAad(artifact)).toEqual(bytes(golden.envelope.aad));
    expect(dataKeyAad(wrapping)).toEqual(bytes(golden.wrappedDataKey.aad));
    expect(
      await sealArtifactWithNonce(
        dataKey,
        artifactAad(artifact),
        plaintext,
        bytes(golden.envelope.nonce),
      ),
    ).toEqual(envelope);
    expect(await openArtifact(dataKey, artifactAad(artifact), envelope)).toEqual(plaintext);
  });

  it("draws a fresh nonce for every seal and wrap", async () => {
    const fresh = await generateDataKey();
    const [first, second] = await Promise.all(
      [1, 2].map(() => sealArtifact(fresh, artifactAad(artifact), plaintext)),
    );
    expect(first).toHaveLength(plaintext.length + 29);
    expect(first).not.toEqual(second);
    const rewrapped = await keyring.wrap(golden.kekId, fresh, dataKeyAad(wrapping));
    expect(rewrapped).toHaveLength(61);
    expect(await keyring.wrap(golden.kekId, fresh, dataKeyAad(wrapping))).not.toEqual(rewrapped);
    const reopened = await keyring.unwrap(golden.kekId, rewrapped, dataKeyAad(wrapping));
    expect(await openArtifact(reopened, artifactAad(artifact), first!)).toEqual(plaintext);
  });

  it("fails closed on wrong AAD, wrong key, tampering and an unknown KEK", async () => {
    const tampered = envelope.slice();
    tampered[20]! ^= 1;
    const wrongKey = await generateDataKey();
    const failures = [
      () =>
        openArtifact(dataKey, artifactAad({ ...artifact, spaceId: "space-b" as never }), envelope),
      () => openArtifact(dataKey, artifactAad({ ...artifact, dataKeyVersion: 2 }), envelope),
      () => openArtifact(wrongKey, artifactAad(artifact), envelope),
      () => openArtifact(dataKey, artifactAad(artifact), tampered),
      () =>
        keyring.unwrap(
          golden.kekId,
          wrapped,
          dataKeyAad({ ...wrapping, tenantId: "tenant-b" as never }),
        ),
    ];
    for (const failure of failures)
      await expect(failure()).rejects.toBeInstanceOf(ArtifactDecryptionError);
    await expect(
      keyring.unwrap("retired-kek", wrapped, dataKeyAad(wrapping)),
    ).rejects.toBeInstanceOf(KeyEncryptionKeyUnavailableError);
    const leaked = WebCryptoKeyring.fromJson(
      `{"version":2,"current":"k","keys":{"k":"${golden.kek}"}}`,
    );
    await expect(leaked).rejects.toBeInstanceOf(InvalidKeyringError);
    await expect(leaked).rejects.not.toThrow(golden.kek);
  });
});
