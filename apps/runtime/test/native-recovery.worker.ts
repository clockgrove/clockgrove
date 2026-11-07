// Test-only inspection entry. Ordinary requests delegate directly to the production Worker.

import { decodeOpaqueId } from "@clockgrove/contracts";
import worker, { composeRuntime, type RuntimeEnvironment } from "../src/cloudflare-entry.js";
import { stableRuntimeRouteName } from "../src/routing.js";
import { TrustedRuntimeRequestAuthenticator } from "../src/trusted-composition.js";
import { unwrapWorldCommandRpc } from "../src/world-commands.js";

export * from "../src/cloudflare-entry.js";

export default {
  async fetch(request: Request, env: RuntimeEnvironment): Promise<Response> {
    if (new URL(request.url).pathname !== "/inspect") return worker.fetch(request, env);
    const context = await new TrustedRuntimeRequestAuthenticator(
      composeRuntime(env).authentication,
    ).authenticate(request);
    const scope = {
      tenantId: context.tenantId,
      worldId: context.worldId!,
      timelineId: context.timelineId!,
      spaceId: context.spaceId!,
    };
    const worldName = await stableRuntimeRouteName("world", [
      scope.tenantId,
      scope.worldId,
      scope.timelineId,
    ]);
    const spaceName = await stableRuntimeRouteName("space", Object.values(scope));
    const subject = decodeOpaqueId("subject-native", "SubjectId");
    const actorName = await stableRuntimeRouteName("actor-agent", [
      scope.tenantId,
      scope.worldId,
      scope.timelineId,
      subject,
    ]);
    const result = await Promise.all([
      env.WORLD_DO.get(env.WORLD_DO.idFromName(worldName)).initialize(scope, context),
      env.SPACE_DO.get(env.SPACE_DO.idFromName(spaceName))
        .initialize(scope, context)
        .then(unwrapWorldCommandRpc),
      env.ACTOR_AGENT_DO.get(env.ACTOR_AGENT_DO.idFromName(actorName)).initialize(
        scope,
        context,
        subject,
      ),
    ]);
    return new Response(
      JSON.stringify(result, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
      { headers: { "x-native-runtime": "Cloudflare-Workers" } },
    );
  },
};
