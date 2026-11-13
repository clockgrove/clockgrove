import {
  AuthorizationRefusedError,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import { type BrowserScope, decodeBrowserScope } from "@clockgrove/contracts";
import { composeEffectControls, type EffectControlsConfiguration } from "./effect-controls.js";
import type { ResearchConfiguration, ResearchResumeTarget } from "./research.js";
import {
  type RuntimeAuthenticationDependencies,
  TrustedRuntimeRequestAuthenticator,
} from "./trusted-composition.js";

export interface EffectEndpointConfiguration {
  readonly authentication: RuntimeAuthenticationDependencies;
  readonly research: {
    readonly admitApproval: EffectControlsConfiguration["admitCall"];
    readonly approvalTarget: (
      scope: BrowserScope,
      approvalId: string,
    ) => Promise<ResearchResumeTarget | null>;
    readonly retry: (
      scope: BrowserScope,
      effectId: string,
      authorization: RuntimeAuthorizationContext,
    ) => Promise<unknown>;
  };
  readonly configuration: Pick<ResearchConfiguration, "withClient" | "artifacts">;
  readonly wake: (target: ResearchResumeTarget) => Promise<void>;
}

export function isEffectRoute(pathname: string): boolean {
  return pathname.startsWith("/v1/runtime/effects/");
}

/** Identity comes exclusively from the verified human session, never the request payload. */
export async function handleEffectEndpoint(
  request: Request,
  ports: EffectEndpointConfiguration,
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (request.method !== "POST") return new Response(null, { status: 405, headers });
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin)
    return Response.json({ error: "effect_origin_refused" }, { status: 403, headers });
  try {
    const auth = new TrustedRuntimeRequestAuthenticator(ports.authentication);
    const identified = await auth.identify(request);
    const action = new URL(request.url).pathname.slice("/v1/runtime/effects/".length);
    const body = (await request.json()) as Record<string, unknown>;
    if (body.sessionId !== undefined && typeof body.sessionId !== "string") throw new Error();
    const operatorAction =
      ["resolve", "retry"].includes(action) ||
      (action === "uncertain" && body.sessionId === undefined);
    let context;
    try {
      context = await auth.authorize(
        identified,
        undefined,
        operatorAction ? "runtime:world-operate" : "runtime:world-observe",
      );
    } catch (error) {
      if (operatorAction || !(error instanceof AuthorizationRefusedError)) throw error;
      context = await auth.authorize(identified, undefined, "runtime:world-operate");
    }
    const scope = decodeBrowserScope({
      tenantId: body.tenantId,
      worldId: body.worldId,
      timelineId: body.timelineId,
      spaceId: body.spaceId,
    });
    const controls = composeEffectControls({
      ...ports.configuration,
      authenticate: async () => context,
      admitCall: ports.research.admitApproval,
    });
    const text = (key: string): string => {
      const value = body[key];
      if (typeof value !== "string" || !value || value.length > 1024) throw new Error();
      return value;
    };
    let value: unknown;
    if (action === "approvals") {
      if (body.sessionId !== undefined && typeof body.sessionId !== "string") throw new Error();
      value = { approvals: await controls.approvals(scope, body.sessionId as string | undefined) };
    } else if (action === "approval") {
      value = await controls.approval({ scope, approvalId: text("approvalId") });
    } else if (action === "decide" || action === "revoke") {
      const approvalId = text("approvalId");
      const target = { scope, approvalId };
      if (action === "revoke") value = await controls.revoke(target);
      else {
        if (body.decision !== "approved" && body.decision !== "denied") throw new Error();
        value = await controls.decide(target, body.decision);
      }
      const resume = await ports.research.approvalTarget(scope, approvalId);
      if (resume) await ports.wake(resume);
    } else if (action === "uncertain") {
      value = { uncertain: await controls.uncertain(scope, body.sessionId as string | undefined) };
    } else if (action === "retry") {
      value = await ports.research.retry(scope, text("effectId"), context);
    } else if (action === "resolve") {
      if (body.disposition !== "done" && body.disposition !== "failed") throw new Error();
      value = await controls.resolve(
        { scope, effectId: text("effectId") },
        text("attemptId"),
        body.disposition,
      );
    } else return Response.json({ error: "not_found" }, { status: 404, headers });
    return Response.json(value, { headers });
  } catch {
    return Response.json({ error: "effect_control_refused" }, { status: 403, headers });
  }
}
