import type { BrowserScope } from "./browser-protocol.js";
import type { ConversationSessionParticipant } from "./conversations.js";
import type { PrincipalId } from "./ids.js";
import { ContractDecodeError, exactKeys, literal, record, string } from "./validation.js";

export const CONVERSATION_CHANNELS = ["browser", "cli", "fake"] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

/** A first-party assertion is resolved against the authenticated credential, never a provider claim. */
export interface SourceIdentityAssertion {
  readonly kind: "authenticated_session" | "runtime_principal";
  readonly subject: string;
}

export interface ChannelIngressMetadata {
  readonly sourceIdentityAssertion?: SourceIdentityAssertion;
  readonly mediaReferences?: readonly string[];
  readonly replyMetadata?: { readonly messageId: string } | null;
  readonly authorityMode?: "member";
}

/** The normalized, server-resolved portal boundary. Content remains in encrypted artifacts. */
export interface InboundEnvelope {
  readonly version: 1;
  readonly sourceIdentityAssertion: SourceIdentityAssertion;
  readonly resolvedPrincipal: PrincipalId;
  readonly scope: BrowserScope;
  readonly actorId: string;
  readonly participants: readonly ConversationSessionParticipant[];
  readonly channel: ConversationChannel;
  readonly threadId: string;
  readonly action: "talk" | "say";
  readonly privacyPolicy: "conversation" | "public_scene";
  readonly contentParts: readonly (
    | { readonly type: "text"; readonly artifactId: string }
    | { readonly type: "text"; readonly text: string }
  )[];
  readonly mediaReferences: readonly string[];
  readonly replyMetadata: { readonly messageId: string } | null;
  readonly authorityMode: "member";
  readonly idempotencyKey: string;
}

export function decodeChannelId(value: unknown, path: string): string {
  const id = string(value, path);
  if (id.trim() !== id || new TextEncoder().encode(id).length > 1024)
    throw new ContractDecodeError(path, "ID length out of range");
  return id;
}

export function decodeChannelIngressMetadata(value: unknown): ChannelIngressMetadata {
  const path = "ingress";
  const v = record(value, path);
  exactKeys(
    v,
    [],
    ["sourceIdentityAssertion", "mediaReferences", "replyMetadata", "authorityMode"],
    path,
  );
  let sourceIdentityAssertion: SourceIdentityAssertion | undefined;
  if (v.sourceIdentityAssertion !== undefined) {
    const source = record(v.sourceIdentityAssertion, `${path}.sourceIdentityAssertion`);
    exactKeys(source, ["kind", "subject"], [], `${path}.sourceIdentityAssertion`);
    sourceIdentityAssertion = {
      kind: literal(source.kind, ["authenticated_session"], `${path}.sourceIdentityAssertion.kind`),
      subject: decodeChannelId(source.subject, `${path}.sourceIdentityAssertion.subject`),
    };
  }
  let replyMetadata: ChannelIngressMetadata["replyMetadata"];
  if (v.replyMetadata !== undefined && v.replyMetadata !== null) {
    const reply = record(v.replyMetadata, `${path}.replyMetadata`);
    exactKeys(reply, ["messageId"], [], `${path}.replyMetadata`);
    replyMetadata = {
      messageId: decodeChannelId(reply.messageId, `${path}.replyMetadata.messageId`),
    };
  } else replyMetadata = v.replyMetadata as null | undefined;
  if (
    v.mediaReferences !== undefined &&
    (!Array.isArray(v.mediaReferences) || v.mediaReferences.length !== 0)
  )
    throw new ContractDecodeError(`${path}.mediaReferences`, "media ingress is not supported");
  return Object.freeze({
    ...(sourceIdentityAssertion === undefined ? {} : { sourceIdentityAssertion }),
    ...(replyMetadata === undefined ? {} : { replyMetadata }),
    ...(v.mediaReferences === undefined ? {} : { mediaReferences: [] }),
    ...(v.authorityMode === undefined
      ? {}
      : { authorityMode: literal(v.authorityMode, ["member"], `${path}.authorityMode`) }),
  });
}
