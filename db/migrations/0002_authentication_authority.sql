-- Read-only verification and authority storage. No enrollment or participation is seeded.
-- Roles are provisioned by the owned setup, never by request initialization.
CREATE SCHEMA clockgrove_auth AUTHORIZATION clockgrove_migrator;
CREATE SCHEMA clockgrove_management AUTHORIZATION clockgrove_migrator;

-- Better Auth 1.7.7 core verification schema; SDK names remain in its own schema.
CREATE TABLE clockgrove_auth."user" (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false, image text,
  "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE TABLE clockgrove_auth.session (
  id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
  "ipAddress" text, "userAgent" text,
  "userId" text NOT NULL REFERENCES clockgrove_auth."user"(id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON clockgrove_auth.session ("userId");
CREATE TABLE clockgrove_auth.account (
  id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES clockgrove_auth."user"(id) ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  scope text, password text, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE INDEX account_user_idx ON clockgrove_auth.account ("userId");
CREATE TABLE clockgrove_auth.verification (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
  "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE INDEX verification_identifier_idx ON clockgrove_auth.verification (identifier);

CREATE TABLE clockgrove_management.principals (
  principal_id text PRIMARY KEY, revoked_at timestamptz
);
CREATE TABLE clockgrove_management.identity_links (
  environment text NOT NULL, subject text NOT NULL,
  external_identity_id text NOT NULL UNIQUE,
  principal_id text NOT NULL REFERENCES clockgrove_management.principals(principal_id),
  revoked_at timestamptz, PRIMARY KEY(environment, subject)
);
CREATE TABLE clockgrove_management.workspace_memberships (
  tenant_id text NOT NULL, principal_id text NOT NULL REFERENCES clockgrove_management.principals(principal_id),
  membership_id text NOT NULL UNIQUE, roles text[] NOT NULL, grants text[] NOT NULL,
  revoked_at timestamptz, PRIMARY KEY(tenant_id, principal_id)
);
-- Runtime-owned committed participation, distinct from administrative membership.
CREATE TABLE clockgrove.world_memberships (
  tenant_id text NOT NULL, world_id text NOT NULL, timeline_id text NOT NULL, space_id text NOT NULL,
  principal_id text NOT NULL, membership_id text NOT NULL, persona_id text NOT NULL,
  roles text[] NOT NULL, grants text[] NOT NULL, privacy_ceiling jsonb NOT NULL,
  committed_at timestamptz NOT NULL, revoked_at timestamptz,
  PRIMARY KEY(tenant_id, world_id, timeline_id, space_id, principal_id),
  FOREIGN KEY(tenant_id, principal_id) REFERENCES clockgrove.tenant_principals(tenant_id, principal_id),
  FOREIGN KEY(tenant_id, world_id, timeline_id) REFERENCES clockgrove.timelines(tenant_id, world_id, timeline_id)
);
ALTER TABLE clockgrove.world_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.world_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped_authority_read ON clockgrove.world_memberships FOR SELECT TO clockgrove_world_reader
  USING (
    revoked_at IS NULL AND tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true)
    AND world_id = current_setting('app.world_id', true)
    AND timeline_id = current_setting('app.timeline_id', true)
    AND space_id = current_setting('app.space_id', true)
  );
ALTER TABLE clockgrove_management.principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove_management.principals FORCE ROW LEVEL SECURITY;
CREATE POLICY principal_lookup ON clockgrove_management.principals FOR SELECT TO clockgrove_management_reader
  USING (revoked_at IS NULL AND (
    principal_id = current_setting('app.principal_id', true) OR EXISTS (
      SELECT 1 FROM clockgrove_management.identity_links link WHERE link.principal_id = principals.principal_id
        AND link.environment = current_setting('lookup.environment', true)
        AND (link.subject = current_setting('lookup.subject', true) OR link.external_identity_id = current_setting('lookup.identity', true))
    )
  ));
ALTER TABLE clockgrove_management.identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove_management.identity_links FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_lookup ON clockgrove_management.identity_links FOR SELECT TO clockgrove_management_reader
  USING (revoked_at IS NULL AND environment = current_setting('lookup.environment', true)
    AND (subject = current_setting('lookup.subject', true)
      OR external_identity_id = current_setting('lookup.identity', true)));
ALTER TABLE clockgrove_management.workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove_management.workspace_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_lookup ON clockgrove_management.workspace_memberships FOR SELECT TO clockgrove_management_reader
  USING (revoked_at IS NULL AND tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true));
REVOKE ALL ON SCHEMA clockgrove_auth, clockgrove_management FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA clockgrove_auth, clockgrove_management FROM PUBLIC;
REVOKE ALL ON clockgrove.world_memberships FROM PUBLIC, clockgrove_runtime;
GRANT USAGE ON SCHEMA clockgrove_auth TO clockgrove_auth_verifier;
-- Verification cannot refresh, enroll, link accounts, or write provider state.
GRANT SELECT ON clockgrove_auth."user", clockgrove_auth.session TO clockgrove_auth_verifier;
GRANT USAGE ON SCHEMA clockgrove_management TO clockgrove_management_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA clockgrove_management TO clockgrove_management_reader;
GRANT USAGE ON SCHEMA clockgrove TO clockgrove_world_reader;
GRANT SELECT ON clockgrove.world_memberships TO clockgrove_world_reader;
