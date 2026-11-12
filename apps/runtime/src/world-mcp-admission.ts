import {
  AuthenticationRefusedError,
  type WorldMcpAdmission,
  WorldMcpAdmissionRefusedError,
} from "@clockgrove/application";
import type { WorldMcpReadApplication } from "./world-mcp-reads.js";
import {
  boundedWorldMcpBody,
  handleWorldMcpRequest,
  WORLD_MCP_MAX_REQUEST_BYTES,
} from "./world-mcp-server.js";

function refusal(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }, { status });
}

/** Internal only: public routing still requires the approved OAuth and member-token composition. */
export async function handleAdmittedWorldMcpRequest(
  application: WorldMcpReadApplication,
  admission: WorldMcpAdmission,
  request: Request,
): Promise<Response> {
  try {
    const credential =
      /^Bearer (\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    const principalId = await admission.begin(credential);
    let body = { text: "", byteLength: 0 };
    let invalidBody = false;
    try {
      body = await boundedWorldMcpBody(request);
    } catch {
      invalidBody = true;
    }
    // Oversized/invalid encodings consume the maximum body-work reservation before refusing.
    await admission.chargeBody(
      principalId,
      invalidBody ? WORLD_MCP_MAX_REQUEST_BYTES : body.byteLength,
    );
    if (invalidBody) return refusal(413, "invalid_request_body");
    if (request.method !== "POST") return refusal(405, "method_refused");
    return await handleWorldMcpRequest(
      application,
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: body.text,
        signal: request.signal,
      }),
    );
  } catch (error) {
    if (error instanceof AuthenticationRefusedError) return refusal(401, "authentication_refused");
    if (error instanceof WorldMcpAdmissionRefusedError)
      return refusal(error.code === "mcp_rate_limited" ? 429 : 503, error.code);
    return refusal(503, "mcp_admission_unavailable");
  }
}
