import { AuthenticationRefusedError } from "@clockgrove/application";
import {
  ContractDecodeError,
  decodeSceneConnectionAttachment,
  exactKeys,
  nonNegativeInteger,
  type PrincipalId,
  record,
  SCENE_PROTOCOL,
  type SceneConnectionAudience,
} from "@clockgrove/contracts";

export const SCENE_JOIN_HEADER = "x-clockgrove-scene-join";
/** Engineering replay window for the single gateway-to-owner forwarding hop, not a session lifetime. */
export const SCENE_JOIN_LIFETIME_MS = 30_000;
export interface SceneJoinClaims {
  readonly principalId: PrincipalId;
  readonly audience: SceneConnectionAudience;
  readonly protocol: typeof SCENE_PROTOCOL;
  readonly authorityEpoch: bigint;
}

async function sceneJoinKey(secret: string) {
  if (secret.length === 0) throw new Error("scene assertion signing secret required");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Only the gateway, after provider verification and scoped authorization, signs this capability. */
export async function signSceneJoin(
  secret: string,
  claims: SceneJoinClaims,
  now = Date.now(),
): Promise<string> {
  const payload = btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(
        JSON.stringify({
          ...claims,
          authorityEpoch: claims.authorityEpoch.toString(),
          expiresAt: now + SCENE_JOIN_LIFETIME_MS,
        }),
      ),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await sceneJoinKey(secret),
    new TextEncoder().encode(`clockgrove.scene.join.v1:${payload}`),
  );
  return `${payload}.${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** `signSceneJoin` writes the epoch as a canonical unsigned decimal string. */
function decodeAuthorityEpoch(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value))
    throw new ContractDecodeError("join.authorityEpoch", "expected canonical unsigned decimal");
  return BigInt(value);
}

export async function verifySceneJoin(
  secret: string,
  assertion: string,
  now = Date.now(),
): Promise<SceneJoinClaims & { readonly expiresAt: number }> {
  const parts = assertion.split(".");
  const payload = parts[0];
  const signature = parts[1];
  if (
    parts.length !== 2 ||
    payload === undefined ||
    signature === undefined ||
    !/^[0-9a-f]{64}$/u.test(signature)
  )
    throw new AuthenticationRefusedError("invalid scene join assertion");
  const signatureBytes = new Uint8Array(
    signature.match(/../gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await sceneJoinKey(secret),
      signatureBytes,
      new TextEncoder().encode(`clockgrove.scene.join.v1:${payload}`),
    ))
  )
    throw new AuthenticationRefusedError("invalid scene join assertion");
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)),
      ),
    );
    const input = record(value, "join");
    exactKeys(
      input,
      ["principalId", "audience", "protocol", "authorityEpoch", "expiresAt"],
      [],
      "join",
    );
    const expiresAt = nonNegativeInteger(input.expiresAt, "join.expiresAt");
    if (
      input.protocol !== SCENE_PROTOCOL ||
      expiresAt <= now ||
      expiresAt > now + SCENE_JOIN_LIFETIME_MS
    )
      throw new ContractDecodeError("join", "invalid assertion claims");
    const attachment = decodeSceneConnectionAttachment({
      principalId: input.principalId,
      audience: input.audience,
      acknowledgedRevision: null,
      connectionVersion: 1,
    });
    return {
      expiresAt,
      principalId: attachment.principalId,
      audience: attachment.audience,
      protocol: SCENE_PROTOCOL,
      authorityEpoch: decodeAuthorityEpoch(input.authorityEpoch),
    };
  } catch (error) {
    if (
      error instanceof ContractDecodeError ||
      error instanceof SyntaxError ||
      (error instanceof DOMException && error.name === "InvalidCharacterError")
    )
      throw new AuthenticationRefusedError("invalid scene join assertion");
    throw error;
  }
}
