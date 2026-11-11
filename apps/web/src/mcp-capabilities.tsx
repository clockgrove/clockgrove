import type { BrowserScope } from "@clockgrove/contracts";
import { type FormEvent, useEffect, useState } from "react";
import type { SceneSession } from "./scene-api.js";

type EffectClass = "read" | "world-write" | "external-write" | "destructive" | "network" | "cost";
interface Candidate {
  id: string;
  kind: "tool" | "resource" | "prompt";
  schemaHash: string;
  metadata: object;
  schema: object;
}
interface Binding {
  bindingId: string;
  candidateId: string;
  installationId: string;
  schemaHash: string;
  protocolVersion: string;
  effect: "allow" | "deny";
  scopeType: string;
  scopeId: string;
  enabled: boolean;
  constraints: object;
}
interface Installation {
  installation_id: string;
  url: string;
  status: string;
  drifted: string[];
  bindings: Binding[];
  snapshot: {
    protocolVersion: string;
    serverIdentity: object;
    protocolMetadata: object;
    candidates: Candidate[];
  };
  reviews: Record<string, { enabled: boolean; effectClass: EffectClass }>;
}

/** Remote text is rendered as text, never instructions, markup, or capability authority. */
export function McpCapabilities({
  session,
  scope,
}: {
  session: SceneSession;
  scope: BrowserScope;
}) {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [authKind, setAuthKind] = useState("static");
  const pendingKey = `mcp-oauth:${JSON.stringify([scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId])}`;
  const read = async () => {
    const result = await session.mcpRequest<{ installations: Installation[] }>(scope, "list");
    setInstallations(result.installations);
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "MCP request failed");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let current = true;
    setBusy(true);
    const callback = new URLSearchParams(location.search);
    const installationId = sessionStorage.getItem(pendingKey);
    const load = async () => {
      if (installationId && callback.has("state") && callback.has("iss") && callback.has("code")) {
        sessionStorage.removeItem(pendingKey);
        history.replaceState(null, "", location.pathname);
        await session.mcpRequest(scope, "oauth-callback", {
          installationId,
          state: callback.get("state"),
          iss: callback.get("iss"),
          code: callback.get("code"),
        });
      }
      return session.mcpRequest<{ installations: Installation[] }>(scope, "list");
    };
    load()
      .then(
        (result) => {
          if (current) setInstallations(result.installations);
        },
        () => {
          if (current) setError("Capabilities unavailable. Installation authority is required.");
        },
      )
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [session, scope, pendingKey]);
  const change = (operation: string, payload: object) =>
    run(async () => {
      await session.mcpRequest(scope, operation, payload);
      await read();
      setNotice("Canonical capability state updated.");
    });
  const connect = (event: FormEvent) => {
    event.preventDefault();
    const secret = token;
    setToken("");
    void run(async () => {
      const installationId = crypto.randomUUID();
      const result = await session.mcpRequest<{ authorizationUrl?: string }>(
        scope,
        authKind === "static" ? "connect-static" : authKind === "oauth" ? "oauth-begin" : "connect",
        {
          installationId,
          url,
          ...(authKind === "static" ? { token: secret } : {}),
        },
      );
      if (result.authorizationUrl) {
        sessionStorage.setItem(pendingKey, installationId);
        location.assign(result.authorizationUrl);
        return;
      }
      await read();
      setNotice("Connected. Discovered candidates are disabled until reviewed.");
    });
  };
  return (
    <section className="rw-mcp" aria-label="Capabilities" aria-busy={busy}>
      <h2>Remote capabilities</h2>
      <p>
        Installation authority is required. Review exact tool versions before granting actor access.
      </p>
      <p>Hosted connections remain unavailable until hosted network safety is verified.</p>
      {error && <p role="alert">{error}</p>}
      <p role="status">{notice}</p>
      <form onSubmit={connect}>
        <label>
          Server URL
          <input required type="url" value={url} onChange={(event) => setUrl(event.target.value)} />
        </label>
        <label>
          Authentication
          <select
            aria-label="Authentication"
            value={authKind}
            onChange={(event) => {
              setAuthKind(event.target.value);
              setToken("");
            }}
          >
            <option value="anonymous">Anonymous</option>
            <option value="static">Static token</option>
            <option value="oauth">OAuth</option>
          </select>
        </label>
        {authKind === "static" && (
          <label>
            Server credential
            <input
              required
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
        )}
        <button disabled={busy} type="submit">
          {authKind === "oauth" ? "Connect with OAuth" : "Connect server"}
        </button>
      </form>
      <button disabled={busy} type="button" onClick={() => void run(read)}>
        Reload capabilities
      </button>
      {installations.map((installation) => (
        <article
          key={installation.installation_id}
          aria-label={`Installation ${installation.installation_id}`}
        >
          <h3>{installation.url}</h3>
          <p>
            Installation: {installation.installation_id}. Status: {installation.status}
          </p>
          <p>Protocol: {installation.snapshot.protocolVersion}</p>
          <h4>Server identity (untrusted)</h4>
          <pre>{JSON.stringify(installation.snapshot.serverIdentity, null, 2)}</pre>
          <h4>Protocol metadata (untrusted)</h4>
          <pre>{JSON.stringify(installation.snapshot.protocolMetadata, null, 2)}</pre>
          <button
            disabled={busy || installation.status !== "active"}
            type="button"
            onClick={() => void change("refresh", { installationId: installation.installation_id })}
          >
            Refresh discovery
          </button>
          <button
            disabled={busy || installation.status === "revoked"}
            type="button"
            onClick={() => void change("revoke", { installationId: installation.installation_id })}
          >
            Revoke installation
          </button>
          <h4>Scoped bindings</h4>
          {(installation.bindings ?? []).map((binding) => (
            <section key={binding.bindingId} aria-label={`Binding ${binding.bindingId}`}>
              <p>
                {binding.candidateId}: {binding.scopeType} {binding.scopeId}.{" "}
                {binding.enabled ? "Binding enabled" : "Binding disabled"}
              </p>
              <pre>{JSON.stringify(binding.constraints, null, 2)}</pre>
              <button
                type="button"
                disabled={busy || !binding.enabled || installation.status !== "active"}
                onClick={() =>
                  void change("bind", {
                    installationId: installation.installation_id,
                    binding: {
                      bindingId: binding.bindingId,
                      installationId: binding.installationId,
                      candidateId: binding.candidateId,
                      schemaHash: binding.schemaHash,
                      protocolVersion: binding.protocolVersion,
                      scopeType: binding.scopeType,
                      scopeId: binding.scopeId,
                      effect: binding.effect,
                      constraints: binding.constraints,
                      enabled: false,
                    },
                  })
                }
              >
                Revoke binding
              </button>
            </section>
          ))}
          {installation.snapshot.candidates.map((candidate) => (
            <CandidateReview
              key={`${candidate.kind}:${candidate.id}:${candidate.schemaHash}`}
              candidate={candidate}
              installation={installation}
              busy={busy}
              change={change}
            />
          ))}
        </article>
      ))}
    </section>
  );
}

function CandidateReview({
  candidate,
  installation,
  busy,
  change,
}: {
  candidate: Candidate;
  installation: Installation;
  busy: boolean;
  change: (operation: string, payload: object) => Promise<void>;
}) {
  const review = installation.reviews[candidate.id];
  const [effectClass, setEffectClass] = useState<EffectClass>(
    review?.effectClass ?? "external-write",
  );
  const [actorId, setActorId] = useState("");
  const [fields, setFields] = useState("");
  const [destinations, setDestinations] = useState("");
  // Conservative operator-editable default: one call, no spend or allowed fields/destinations.
  const [calls, setCalls] = useState(1);
  const [budget, setBudget] = useState(0);
  const [expiry, setExpiry] = useState("");
  const pin = {
    installationId: installation.installation_id,
    candidateId: candidate.id,
    schemaHash: candidate.schemaHash,
    protocolVersion: installation.snapshot.protocolVersion,
  };
  const disabled = busy || installation.status !== "active";
  const split = (value: string) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return (
    <section aria-label={`Candidate ${candidate.id}`}>
      <h4>{candidate.id}</h4>
      <p>
        Kind: {candidate.kind}. Class: {review?.effectClass ?? "external-write"}.{" "}
        {review?.enabled ? "Enabled" : "Disabled"}
      </p>
      <p>Schema hash: {candidate.schemaHash}</p>
      {installation.drifted.includes(candidate.id) && (
        <p role="alert">Schema or protocol drift: review this version again.</p>
      )}
      <p>Remote description and schema are untrusted data.</p>
      <pre>{JSON.stringify(candidate.metadata, null, 2)}</pre>
      <pre>{JSON.stringify(candidate.schema, null, 2)}</pre>
      {candidate.kind !== "tool" ? (
        <p>Resources and prompts remain disabled.</p>
      ) : (
        <>
          <label>
            Effect class
            <select
              value={effectClass}
              onChange={(event) => setEffectClass(event.target.value as EffectClass)}
            >
              {(
                ["read", "world-write", "external-write", "destructive", "network", "cost"] as const
              ).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              void change("review", { ...pin, effectClass, enabled: !review?.enabled })
            }
          >
            {review?.enabled ? "Disable tool" : "Review and enable tool"}
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void change("bind", {
                installationId: installation.installation_id,
                binding: {
                  ...pin,
                  bindingId: crypto.randomUUID(),
                  scopeType: "actor",
                  scopeId: actorId,
                  effect: "allow",
                  enabled: true,
                  constraints: {
                    inputFields: split(fields),
                    destinations: split(destinations),
                    callsPerTurn: calls,
                    budgetMicrousd: budget,
                    effectClasses: [effectClass],
                    ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : {}),
                  },
                },
              });
            }}
          >
            <label>
              Actor ID
              <input
                required
                value={actorId}
                onChange={(event) => setActorId(event.target.value)}
              />
            </label>
            <label>
              Allowed input fields (comma separated)
              <input value={fields} onChange={(event) => setFields(event.target.value)} />
            </label>
            <label>
              Allowed destinations (comma separated)
              <input
                value={destinations}
                onChange={(event) => setDestinations(event.target.value)}
              />
            </label>
            <label>
              Calls per turn
              <input
                type="number"
                required
                min="0"
                step="1"
                value={calls}
                onChange={(event) => setCalls(Number(event.target.value))}
              />
            </label>
            <label>
              Budget (microdollars)
              <input
                type="number"
                required
                min="0"
                step="1"
                value={budget}
                onChange={(event) => setBudget(Number(event.target.value))}
              />
            </label>
            <label>
              Grant expiry
              <input
                type="datetime-local"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
              />
            </label>
            <button type="submit" disabled={disabled || !review?.enabled}>
              Bind actor
            </button>
          </form>
        </>
      )}
    </section>
  );
}
