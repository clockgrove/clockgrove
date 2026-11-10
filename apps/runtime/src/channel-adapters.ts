import type { BrowserScope, TalkRequest } from "@clockgrove/contracts";

/** Deterministic first-party adapter; the caller supplies the existing authenticated HTTP transport. */
export class FakeConversationAdapter {
  constructor(
    private readonly post: (path: string, body: object) => Promise<unknown>,
    private readonly scope: BrowserScope,
  ) {}

  create(actorId: string, threadId: string): Promise<unknown> {
    return this.post("/v1/runtime/conversations/create", {
      version: 1,
      ...this.scope,
      actorId,
      channel: "fake",
      threadId,
    });
  }

  talk(
    sessionId: string,
    messageId: string,
    text: string,
    ingress?: TalkRequest["ingress"],
  ): Promise<unknown> {
    return this.post("/v1/runtime/talk", {
      version: 1,
      ...this.scope,
      sessionId,
      messageId,
      text,
      ...(ingress === undefined ? {} : { ingress }),
    });
  }

  say(actorId: string, threadId: string, messageId: string, text: string): Promise<unknown> {
    return this.post("/v1/runtime/say", {
      version: 1,
      ...this.scope,
      actorId,
      channel: "fake",
      threadId,
      messageId,
      text,
    });
  }
}
