import worker, {
  composeRuntime,
  injectRuntimeComposition,
  McpOperatorDO as Owner,
  type RuntimeEnvironment,
} from "../src/cloudflare-entry.js";

type Environment = RuntimeEnvironment & { SECRET_DATABASE_URL: string; FIXTURE_ORIGIN: string };
let ready: Promise<void> | undefined;
function configure(env: Environment) {
  return (ready ??= crypto.subtle
    .importKey("raw", new Uint8Array(32).fill(4), "AES-GCM", false, ["encrypt", "decrypt"])
    .then((key) => {
      const supplied = composeRuntime(env);
      injectRuntimeComposition(() => ({
        ...supplied,
        mcpConfiguration: {
          secretDatabaseUrl: env.SECRET_DATABASE_URL,
          credentialKeyring: { activeVersion: "v1", keys: new Map([["v1", key]]) },
          network: {
            resolve: async () => ["93.184.216.34"],
            request: (url, init) => fetch(`${env.FIXTURE_ORIGIN}${new URL(url).pathname}`, init),
          },
          maxInstallations: 4,
          oauthClient: (url) => ({
            clientId: "fixture",
            issuer: "https://fixture.example/issuer",
            resource: url,
            redirectUri: "https://operator.example/callback",
            scopes: ["lookup"],
          }),
        },
      }));
    }));
}

export class McpOperatorDO extends Owner {
  declare protected env: Environment;
  override async execute(...args: Parameters<Owner["execute"]>) {
    await configure(this.env);
    return super.execute(...args);
  }
}
export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    await configure(env);
    if (new URL(request.url).pathname === "/close") {
      await env.MCP_OPERATOR_DO!.get(env.MCP_OPERATOR_DO!.idFromName("local-mcp-operator")).close();
      return Response.json({ ok: true });
    }
    return worker.fetch(request, env);
  },
};
