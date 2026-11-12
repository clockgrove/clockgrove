import type { WorldMcpAdmission } from "@clockgrove/application";
import type { WorldMcpAuthentication } from "./better-auth-adapter.js";
import { handleAdmittedWorldMcpRequest } from "./world-mcp-admission.js";
import type { WorldMcpApplication } from "./world-mcp-commands.js";

const RESOURCE_METADATA = "/.well-known/oauth-protected-resource/mcp";

export function isWorldMcpRoute(pathname: string): boolean {
  return (
    pathname === "/mcp" ||
    pathname === RESOURCE_METADATA ||
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/oauth-authorization-server/api/auth" ||
    pathname.startsWith("/api/auth/oauth2/") ||
    pathname.startsWith("/api/auth/api-key/") ||
    pathname === "/api/auth/.well-known/oauth-authorization-server"
  );
}

export interface WorldMcpEndpoint {
  readonly resourceURL: string;
  readonly authentication: WorldMcpAuthentication;
  readonly admission: WorldMcpAdmission;
  /** A new application facade for this exchange; client identity comes only from verification. */
  readonly application: (clientId: string) => WorldMcpApplication;
}

/** Public, stateless composition over ordinary application use cases and live credentials. */
export async function handleWorldMcpEndpoint(
  request: Request,
  endpoint: WorldMcpEndpoint,
): Promise<Response> {
  const url = new URL(request.url);
  const resource = new URL(endpoint.resourceURL);
  const metadataURL = new URL(RESOURCE_METADATA, resource.origin).toString();
  const challenge = (status = 401, error = "authentication_refused") =>
    Response.json(
      { error },
      {
        status,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${metadataURL}", scope="clockgrove:mcp"`,
          "cache-control": "no-store",
        },
      },
    );
  if (url.origin !== resource.origin || !isWorldMcpRoute(url.pathname))
    return Response.json({ error: "not_found" }, { status: 404 });
  // Browser origins cannot select a different authenticated principal through ambient state.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== resource.origin)
    return Response.json({ error: "origin_refused" }, { status: 403 });
  if (
    url.pathname === RESOURCE_METADATA ||
    url.pathname === "/.well-known/oauth-protected-resource"
  ) {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    return Response.json({
      resource: endpoint.resourceURL,
      authorization_servers: [new URL("/api/auth", resource.origin).toString()],
      scopes_supported: ["clockgrove:mcp"],
      bearer_methods_supported: ["header"],
      resource_name: "Clockgrove world MCP",
    });
  }
  if (url.pathname !== resource.pathname) return endpoint.authentication.handle(request);
  const credential = /^Bearer (\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
  if (credential === undefined) return challenge();
  let verified: Awaited<ReturnType<WorldMcpAuthentication["authenticate"]>>;
  try {
    verified = await endpoint.authentication.authenticate(credential);
  } catch {
    return challenge();
  }
  const response = await handleAdmittedWorldMcpRequest(
    endpoint.application(verified.clientId),
    endpoint.admission,
    request,
  );
  if (response.status === 401) return challenge();
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
