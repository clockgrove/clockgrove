import type { ChannelIngressMetadata, InboundEnvelope } from "@clockgrove/contracts";
import { type ConversationParticipant, ConversationRefusedError } from "./conversations.js";

/** Authentication has already mapped the assertion to this authorized world participant. */
export function normalizeInboundEnvelope(
  participant: ConversationParticipant,
  input: Omit<
    InboundEnvelope,
    | "version"
    | "sourceIdentityAssertion"
    | "resolvedPrincipal"
    | "mediaReferences"
    | "replyMetadata"
    | "authorityMode"
  >,
  metadata?: ChannelIngressMetadata,
): InboundEnvelope {
  const source = resolveInboundSourceIdentity(participant, metadata);
  return Object.freeze({
    version: 1,
    sourceIdentityAssertion: source,
    resolvedPrincipal: participant.principalId,
    ...input,
    mediaReferences: metadata?.mediaReferences ?? [],
    replyMetadata: metadata?.replyMetadata ?? null,
    authorityMode: "member",
  });
}

export function resolveInboundSourceIdentity(
  participant: ConversationParticipant,
  metadata?: ChannelIngressMetadata,
) {
  const source = participant.sourceIdentityAssertion ?? {
    kind: "runtime_principal" as const,
    subject: participant.principalId,
  };
  if (
    metadata?.sourceIdentityAssertion !== undefined &&
    (metadata.sourceIdentityAssertion.kind !== source.kind ||
      metadata.sourceIdentityAssertion.subject !== source.subject)
  )
    throw new ConversationRefusedError("channel_identity_unverified");
  return source;
}
