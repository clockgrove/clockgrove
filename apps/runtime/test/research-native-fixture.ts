import {
  type McpNetworkPort,
  RemoteHttpMcpReadAdapter,
  SafeMcpHttpClient,
} from "@clockgrove/application";
import { PostgreSqlArtifactStore, WebCryptoKeyring } from "@clockgrove/persistence";
import {
  composeResearchInternalRead,
  composeRuntime,
  type RuntimeEnvironment,
} from "../src/cloudflare-entry.js";
import { withHyperdrivePostgreSqlClient } from "../src/hyperdrive-postgres.js";
import { composeResearch } from "../src/research.js";
import { stableRuntimeRouteName } from "../src/routing.js";

export type NativeResearchEnvironment = RuntimeEnvironment & {
  readonly NATIVE_RESEARCH_ORIGIN?: string;
  readonly NATIVE_RESEARCH_DATABASE_URL?: string;
};
let cached: { origin: string; service: ReturnType<typeof composeResearch> } | undefined;

/** Test-owned public DNS mapping to the actual loopback fixture HTTP server, never production. */
export function nativeResearch(
  env: NativeResearchEnvironment,
): ReturnType<typeof composeResearch> | undefined {
  const origin = env.NATIVE_RESEARCH_ORIGIN;
  if (!origin || !env.NATIVE_RESEARCH_DATABASE_URL) return undefined;
  if (cached?.origin === origin) return cached.service;
  const network: McpNetworkPort = {
    resolve: async () => ["93.184.216.34"],
    request: (url, init, addresses) => {
      if (new URL(url).hostname !== "fixture.example" || addresses.join() !== "93.184.216.34")
        throw new Error("fixture destination refused");
      return fetch(`${origin}${new URL(url).pathname}`, init);
    },
  };
  const keyring = WebCryptoKeyring.fromJson(env.ARTIFACT_KEYRING!);
  const service = composeResearch({
    environment: "local",
    withClient: (operation) =>
      withHyperdrivePostgreSqlClient(env.NATIVE_RESEARCH_DATABASE_URL!, operation),
    artifacts: (client) => ({
      put: async (authorization, input) =>
        new PostgreSqlArtifactStore(client, { keyring: await keyring }).put(authorization, input),
      get: async (authorization, at) =>
        new PostgreSqlArtifactStore(client, { keyring: await keyring }).get(authorization, at),
    }),
    network,
    internalRead: composeResearchInternalRead(env, composeRuntime(env).authentication),
    adapter: new RemoteHttpMcpReadAdapter(new SafeMcpHttpClient(network)),
    publish: async (envelope) => {
      await env.EXTERNAL_EFFECTS_QUEUE!.send(envelope);
    },
    wake: async (target) => {
      const name = await stableRuntimeRouteName("actor-agent", [
        target.scope.tenantId,
        target.scope.worldId,
        target.scope.timelineId,
        target.actorId,
      ]);
      await env.ACTOR_AGENT_DO.get(env.ACTOR_AGENT_DO.idFromName(name)).toolCompleted(target);
    },
    policy: {
      maxCalls: 3,
      maxModelSteps: 4,
      maxCostMicrousd: 250000,
      modelStepReserveMicrousd: 50000,
    },
    toolCallReserveMicrousd: 1000,
  });
  cached = { origin, service };
  return service;
}
