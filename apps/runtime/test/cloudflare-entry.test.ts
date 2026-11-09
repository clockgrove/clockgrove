import { InMemoryRuntimeLogger } from "@clockgrove/application";
import { expect, it } from "vitest";
import {
  composeReferenceAuthentication,
  type ReferenceAuthenticationConfiguration,
  refusingAuthenticationProvider,
} from "../src/better-auth-adapter.js";
import * as native from "../src/cloudflare-entry.js";
import { authenticationFixture } from "./auth-fixture.js";

const config: ReferenceAuthenticationConfiguration = {
  baseURL: "https://auth.example.test",
  environment: "staging",
  connectionString: "postgres://localhost/auth",
  resolveIdentity: async () => undefined,
};
const fixtureSecret = "configuration".repeat(4);

it("refuses authentication for a missing or weak secret or malformed configuration", () => {
  expect(composeReferenceAuthentication(fixtureSecret, config)).not.toBe(
    refusingAuthenticationProvider,
  );
  for (const [authSecret, invalid] of [
    [undefined, config],
    [" ".repeat(32), config],
    [fixtureSecret, undefined],
    [fixtureSecret, { ...config, baseURL: "http://auth.example.test" }],
    [fixtureSecret, { ...config, baseURL: "https://auth.example.test/path" }],
    [fixtureSecret, { ...config, connectionString: "https://database.example.test" }],
  ] as const)
    expect(composeReferenceAuthentication(authSecret, invalid)).toBe(
      refusingAuthenticationProvider,
    );
});

it("never lets an injected test provider bypass the configured authentication", () => {
  const injected = authenticationFixture().provider;
  native.injectRuntimeComposition(
    () =>
      ({
        authentication: { provider: injected },
        journal: {},
        canonical: {},
      }) as unknown as ReturnType<native.RuntimeCompositionFunction>,
  );
  try {
    const env = {
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    } as native.RuntimeEnvironment;
    expect(native.composeRuntime(env).authentication.provider).toBe(refusingAuthenticationProvider);
  } finally {
    native.injectRuntimeComposition(undefined);
  }
});

it("logs a failed Queue delivery once through the composed logger, by transport identity", async () => {
  const sink = new InMemoryRuntimeLogger();
  const failing = {
    // A serialization failure (SQLSTATE 40001) whose text must not reach the log.
    consume: () => Promise.reject(Object.assign(new Error("private body"), { code: "40001" })),
  };
  native.injectRuntimeComposition(
    () =>
      ({
        authentication: { codeVersion: "release-1" },
        journal: {},
        canonical: {},
        consumers: { worldReactions: failing },
        logger: sink,
      }) as unknown as ReturnType<native.RuntimeCompositionFunction>,
  );
  try {
    const retries: unknown[] = [];
    await native.default.queue(
      {
        queue: "rw-ci-world-reactions",
        messages: [
          {
            id: "transport-1",
            body: { private: "must-never-be-logged" },
            attempts: 2,
            ack: () => retries.push("ack"),
            retry: (options) => retries.push(options),
          },
        ],
      },
      {
        WORLD_REACTIONS_QUEUE_NAME: "rw-ci-world-reactions",
        COGNITIVE_INDEXING_QUEUE_NAME: "rw-ci-cognitive-indexing",
        EXTERNAL_EFFECTS_QUEUE_NAME: "rw-ci-external-effects",
        PROVIDER_ENVIRONMENT: "ci",
      } as native.RuntimeEnvironment,
    );
    expect(retries).toEqual([{ delaySeconds: 2 }]);
    expect(sink.records.map(({ timestamp, ...record }) => record)).toEqual([
      {
        schemaVersion: 6,
        level: "warn",
        event: "world_reactions_delivery_failed",
        channel: "world-reactions",
        transportMessageId: "transport-1",
        attempt: 2,
        failureClass: "transient",
        retryable: true,
        disposition: "retry-or-dlq",
        codeVersion: "release-1",
        environment: "ci",
      },
    ]);
  } finally {
    native.injectRuntimeComposition(undefined);
  }
});
