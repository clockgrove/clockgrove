import { type FormEvent, useState } from "react";

interface Consent {
  id: string;
  clientId: string;
  scopes: string[];
}
interface MemberKey {
  id: string;
  name: string | null;
  expiresAt: string | null;
}

/** Existing member sessions authorize credential management; credentials stay in component memory. */
export function WorldMcpAccess() {
  const [credential, setCredential] = useState("");
  const [name, setName] = useState("");
  const [keys, setKeys] = useState<MemberKey[]>([]);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [created, setCreated] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [consentQuery, setConsentQuery] = useState(
    location.pathname === "/mcp/consent" ? location.search.slice(1) : "",
  );
  const signIn = location.pathname === "/sign-in";
  const consent = consentQuery !== "";
  const request = async (path: string, body?: object) => {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(credential === "" ? {} : { authorization: `Bearer ${credential}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error("The request was refused. Check your member session and try again.");
    const text = await response.text();
    return text === "" ? null : JSON.parse(text);
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request was refused.");
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    const [result, approvals] = await Promise.all([
      request("/api/auth/api-key/list"),
      request("/api/auth/oauth2/get-consents"),
    ]);
    setConsents(approvals);
    setKeys(Array.isArray(result) ? result : (result.apiKeys ?? result.keys ?? []));
  };
  const continueAuthorization = async () => {
    const query = new URLSearchParams(location.search);
    const supplied = query.get("returnTo") ?? query.get("callbackURL");
    const target =
      supplied === null
        ? new URL(`/api/auth/oauth2/authorize?${location.search.slice(1)}`, location.origin)
        : new URL(supplied, location.origin);
    if (target.origin !== location.origin || target.pathname !== "/api/auth/oauth2/authorize")
      throw new Error("Invalid authorization request.");
    const result = await request(`${target.pathname}${target.search}`);
    if (typeof result.url !== "string") throw new Error("Invalid authorization response.");
    const next = new URL(result.url, location.origin);
    if (next.origin === location.origin && next.pathname === "/mcp/consent") {
      setConsentQuery(next.search.slice(1));
      history.replaceState(null, "", `${next.pathname}${next.search}`);
    } else location.assign(next.toString());
  };
  const approve = async (accept: boolean) => {
    const result = await request("/api/auth/oauth2/consent", { accept, oauth_query: consentQuery });
    if (typeof result.url !== "string") throw new Error("Invalid authorization response.");
    location.assign(result.url);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (signIn && !consent) await continueAuthorization();
      else if (!consent) await refresh();
    });
  };
  return (
    <main className="rw-mcp-access">
      <h1>
        {consent ? "Allow an MCP client" : signIn ? "Sign in to Clockgrove MCP" : "MCP access"}
      </h1>
      <p>
        MCP clients use your existing world permissions. They cannot gain additional permissions
        through this connection.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="member-session">Member session credential</label>
        <input
          id="member-session"
          type="password"
          autoComplete="off"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
        />
        <p>You can also use an existing signed-in browser session.</p>
        {!consent && (
          <button disabled={busy} type="submit">
            {signIn ? "Continue" : "Show my tokens"}
          </button>
        )}
      </form>
      {consent ? (
        <section aria-label="MCP consent">
          <p>
            Client: <code>{new URLSearchParams(consentQuery).get("client_id")}</code>
          </p>
          <p>
            Requested scope: <code>{new URLSearchParams(consentQuery).get("scope")}</code>
          </p>
          <p>
            Allow this client to observe, inspect and submit commands with your current permissions?
            Revoke access by revoking the credential or signing out of its authorizing session.
          </p>
          <button type="button" disabled={busy} onClick={() => void run(() => approve(true))}>
            Allow
          </button>
          <button type="button" disabled={busy} onClick={() => void run(() => approve(false))}>
            Deny
          </button>
        </section>
      ) : (
        !signIn && (
          <section aria-label="Member API tokens">
            <p>
              Server endpoint: <code>{location.origin}/mcp</code>
            </p>
            <label htmlFor="token-name">Token name</label>
            <input
              id="token-name"
              maxLength={128}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="button"
              disabled={busy || name.trim() === ""}
              onClick={() =>
                void run(async () => {
                  const result = await request("/api/auth/api-key/create", { name });
                  setCreated(result.key);
                  setName("");
                  await refresh();
                })
              }
            >
              Create token
            </button>
            {created !== "" && (
              <div role="status">
                <p>Copy this token now. It is shown only once.</p>
                <output aria-label="New API token">{created}</output>
                <button type="button" onClick={() => setCreated("")}>
                  Hide token
                </button>
              </div>
            )}
            <ul>
              {keys.map((key) => (
                <li key={key.id}>
                  {key.name ?? "Member token"} — expires {key.expiresAt ?? "unknown"}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await request("/api/auth/api-key/delete", { keyId: key.id });
                        setCreated("");
                        await refresh();
                      })
                    }
                  >
                    Revoke {key.name ?? "token"}
                  </button>
                </li>
              ))}
            </ul>
            <h2>OAuth client access</h2>
            <ul>
              {consents.map((approval) => (
                <li key={approval.id}>
                  <code>{approval.clientId}</code>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await request("/api/auth/oauth2/delete-consent", { id: approval.id });
                        await refresh();
                      })
                    }
                  >
                    Revoke client access
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      )}
      {error !== "" && <p role="alert">{error}</p>}
      <a href="/">Return to worlds</a>
    </main>
  );
}
