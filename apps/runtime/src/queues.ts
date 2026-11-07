import {
  ContractDecodeError,
  decodeQueueEnvelope,
  type QueueChannel,
  type QueueEnvelope,
} from "@clockgrove/contracts";

/** A transport-boundary refusal; handler failures keep their original error type. */
export class QueueMessageRefusedError extends Error {
  constructor(
    readonly code: "malformed" | "inconsistent",
    message: string = code,
  ) {
    super(message);
    this.name = "QueueMessageRefusedError";
  }
}

export interface QueueMessageHandler<TPayload = unknown> {
  handle(message: QueueEnvelope<TPayload>): Promise<void>;
}

export class TypedQueueConsumer<TPayload = unknown> {
  constructor(
    readonly channel: QueueChannel,
    private readonly handler: QueueMessageHandler<TPayload>,
  ) {}

  async consume(value: unknown, decodePayload: (value: unknown) => TPayload): Promise<void> {
    let envelope: QueueEnvelope<TPayload>;
    try {
      envelope = decodeQueueEnvelope(value, (payload) => decodePayload(payload));
    } catch (error) {
      if (error instanceof ContractDecodeError) throw new QueueMessageRefusedError("malformed");
      throw error;
    }
    if (envelope.channel !== this.channel)
      throw new QueueMessageRefusedError("malformed", "queue channel does not match consumer");
    // Decoding preserves untrusted data; it does not construct an execution context.
    await this.handler.handle(envelope);
  }
}

export type RuntimeQueueConsumers = Readonly<{
  worldReactions: TypedQueueConsumer;
  cognitiveIndexing: TypedQueueConsumer;
  externalEffects: TypedQueueConsumer;
}>;

/** Channels whose effect handlers have not shipped keep refusing delivery. */
export function refusingRuntimeQueueConsumers(): RuntimeQueueConsumers {
  const handler: QueueMessageHandler = {
    async handle() {
      throw new Error("runtime queue effect is unavailable in Wave 0");
    },
  };
  return {
    worldReactions: new TypedQueueConsumer("world-reactions", handler),
    cognitiveIndexing: new TypedQueueConsumer("cognitive-indexing", handler),
    externalEffects: new TypedQueueConsumer("external-effects", handler),
  };
}
