import {
  AuthenticationRefusedError,
  type AuthProviderPort,
  type PrincipalMappingPort,
  type VerifiedExternalIdentity,
} from "@clockgrove/application";
import { decodeOpaqueId, type ExternalIdentityId, type PrincipalId } from "@clockgrove/contracts";

/** Identity fixtures only: world grants are supplied separately by local authorization. */
export const LOCAL_TEST_PRINCIPALS = {
  observer: {
    identity: { provider: "test-auth", environment: "local", subject: "observer" },
    externalIdentityId: decodeOpaqueId("identity-observer", "ExternalIdentityId"),
    principalId: decodeOpaqueId("principal-observer", "PrincipalId"),
    credential: "local-observer",
  },
  operator: {
    identity: { provider: "test-auth", environment: "local", subject: "operator" },
    externalIdentityId: decodeOpaqueId("identity-operator", "ExternalIdentityId"),
    principalId: decodeOpaqueId("principal-operator", "PrincipalId"),
    credential: "local-operator",
  },
} as const;

export type LocalTestRole = keyof typeof LOCAL_TEST_PRINCIPALS;

interface ProviderSubject {
  readonly provider: string;
  readonly environment: string;
  readonly subject: string;
}

export interface TestSessionEvent {
  readonly eventId: string;
  readonly revision: number;
  readonly credential: string;
  readonly identity: ProviderSubject;
  readonly expiresAt: number;
  readonly revoked: boolean;
  readonly organization?: string;
}

/** Explicit local/test adapter; never exported from the production runtime entry point. */
export class DeterministicTestAuthProvider implements AuthProviderPort, PrincipalMappingPort {
  private readonly sessions = new Map<string, TestSessionEvent>();
  private readonly events = new Map<string, string>();
  private readonly identities = new Map<string, ExternalIdentityId>();
  private readonly principals = new Map<ExternalIdentityId, PrincipalId>();
  available = true;

  constructor(private readonly now: () => number) {}

  /** Explicit opt-in; constructing the provider alone installs no identities or sessions. */
  createRoleSession(
    role: LocalTestRole,
    session: Pick<TestSessionEvent, "revision" | "expiresAt">,
  ): TestSessionEvent {
    const principal = LOCAL_TEST_PRINCIPALS[role];
    this.linkAccount(principal.identity, principal.externalIdentityId, principal.principalId);
    const event: TestSessionEvent = {
      ...session,
      eventId: `event-session-${role}`,
      credential: principal.credential,
      identity: principal.identity,
      revoked: false,
    };
    this.applyEvent(event);
    return event;
  }

  /** Management-only explicit account linking. No world persistence capability is available. */
  linkAccount(
    subject: ProviderSubject,
    identityId: ExternalIdentityId,
    principalId: PrincipalId,
  ): void {
    const key = subjectKey(subject);
    const existingIdentity = this.identities.get(key);
    const existingPrincipal = this.principals.get(identityId);
    if (
      (existingIdentity !== undefined && existingIdentity !== identityId) ||
      (existingPrincipal !== undefined && existingPrincipal !== principalId)
    ) {
      throw new AuthenticationRefusedError("identity already linked");
    }
    this.identities.set(key, identityId);
    this.principals.set(identityId, principalId);
  }

  applyEvent(event: TestSessionEvent): void {
    if (
      !Number.isSafeInteger(event.revision) ||
      event.revision < 0 ||
      !Number.isFinite(event.expiresAt)
    ) {
      throw new TypeError("invalid provider event");
    }
    const bytes = JSON.stringify(event);
    const duplicate = this.events.get(event.eventId);
    if (duplicate !== undefined) {
      if (duplicate !== bytes) throw new AuthenticationRefusedError("conflicting provider event");
      return;
    }
    const current = this.sessions.get(event.credential);
    if (
      current !== undefined &&
      current.revision === event.revision &&
      JSON.stringify(current) !== bytes
    ) {
      throw new AuthenticationRefusedError("conflicting session revision");
    }
    this.events.set(event.eventId, bytes);
    if (current === undefined || event.revision > current.revision) {
      this.sessions.set(event.credential, structuredClone(event));
    }
  }

  async authenticate(credential: string): Promise<VerifiedExternalIdentity> {
    if (!this.available) throw new AuthenticationRefusedError("provider unavailable");
    const session = this.sessions.get(credential);
    if (session === undefined || session.revoked || session.expiresAt <= this.now()) {
      throw new AuthenticationRefusedError("invalid session");
    }
    const externalIdentityId = this.identities.get(subjectKey(session.identity));
    if (externalIdentityId === undefined) throw new AuthenticationRefusedError("unmapped identity");
    return Object.freeze({ externalIdentityId });
  }

  async resolvePrincipal(identity: VerifiedExternalIdentity): Promise<PrincipalId | undefined> {
    return this.principals.get(identity.externalIdentityId);
  }
}

function subjectKey(identity: ProviderSubject): string {
  return JSON.stringify([identity.provider, identity.environment, identity.subject]);
}
