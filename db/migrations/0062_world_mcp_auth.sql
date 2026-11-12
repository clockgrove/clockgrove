-- Better Auth OAuth-provider/API-key 1.7.15 schema, confined to dedicated credential authority.
GRANT USAGE ON SCHEMA clockgrove_auth TO clockgrove_mcp_auth_writer;
GRANT SELECT ON clockgrove_auth."user", clockgrove_auth.session TO clockgrove_mcp_auth_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON clockgrove_auth.verification TO clockgrove_mcp_auth_writer;

CREATE TABLE clockgrove_auth."oauthClient" (
  id text PRIMARY KEY,
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" boolean DEFAULT false,
  "skipConsent" boolean,
  "enableEndSession" boolean,
  "subjectType" text,
  "scopes" jsonb,
  "clientCredentialsScopes" jsonb DEFAULT '[]'::jsonb,
  "userId" text REFERENCES clockgrove_auth."user"("id") ON DELETE CASCADE,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" jsonb,
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" jsonb NOT NULL,
  "postLogoutRedirectUris" jsonb,
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" boolean,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" jsonb,
  "responseTypes" jsonb,
  "requirePKCE" boolean,
  "dpopBoundAccessTokens" boolean DEFAULT false,
  "referenceId" text,
  "metadata" jsonb
);
CREATE INDEX "oauthClient_userId_idx" ON clockgrove_auth."oauthClient" ("userId");
REVOKE ALL ON clockgrove_auth."oauthClient" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON clockgrove_auth."oauthClient" TO clockgrove_mcp_auth_writer;

CREATE TABLE clockgrove_auth."oauthResource" (
  id text PRIMARY KEY,
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" jsonb,
  "customClaims" jsonb,
  "dpopBoundAccessTokensRequired" boolean DEFAULT false,
  "disabled" boolean DEFAULT false,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "policyVersion" integer DEFAULT 1,
  "metadata" jsonb
);
REVOKE ALL ON clockgrove_auth."oauthResource" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON clockgrove_auth."oauthResource" TO clockgrove_mcp_auth_writer;

CREATE TABLE clockgrove_auth."oauthClientResource" (
  id text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES clockgrove_auth."oauthClient"("clientId") ON DELETE CASCADE,
  "resourceId" text NOT NULL REFERENCES clockgrove_auth."oauthResource"("identifier") ON DELETE CASCADE,
  "metadata" jsonb,
  "createdAt" timestamptz,
  UNIQUE ("clientId", "resourceId")
);
CREATE INDEX "oauthClientResource_clientId_idx" ON clockgrove_auth."oauthClientResource" ("clientId");
CREATE INDEX "oauthClientResource_resourceId_idx" ON clockgrove_auth."oauthClientResource" ("resourceId");
REVOKE ALL ON clockgrove_auth."oauthClientResource" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON clockgrove_auth."oauthClientResource" TO clockgrove_mcp_auth_writer;

-- Both token tables must revoke on session deletion: the provider does not validate a NULL session pointer.
CREATE TABLE clockgrove_auth."oauthRefreshToken" (
  id text PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES clockgrove_auth."oauthClient"("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES clockgrove_auth."session"("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES clockgrove_auth."user"("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "revoked" timestamptz,
  "rotatedAt" timestamptz,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" timestamptz,
  "authTime" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb NOT NULL
);
CREATE INDEX "oauthRefreshToken_clientId_idx" ON clockgrove_auth."oauthRefreshToken" ("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON clockgrove_auth."oauthRefreshToken" ("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx" ON clockgrove_auth."oauthRefreshToken" ("userId");
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON clockgrove_auth."oauthRefreshToken" ("authorizationCodeId");
REVOKE ALL ON clockgrove_auth."oauthRefreshToken" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON clockgrove_auth."oauthRefreshToken" TO clockgrove_mcp_auth_writer;

CREATE TABLE clockgrove_auth."oauthAccessToken" (
  id text PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES clockgrove_auth."oauthClient"("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES clockgrove_auth."session"("id") ON DELETE CASCADE,
  "userId" text REFERENCES clockgrove_auth."user"("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "refreshId" text REFERENCES clockgrove_auth."oauthRefreshToken"("id") ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "revoked" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb NOT NULL
);
CREATE INDEX "oauthAccessToken_clientId_idx" ON clockgrove_auth."oauthAccessToken" ("clientId");
CREATE INDEX "oauthAccessToken_sessionId_idx" ON clockgrove_auth."oauthAccessToken" ("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx" ON clockgrove_auth."oauthAccessToken" ("userId");
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON clockgrove_auth."oauthAccessToken" ("authorizationCodeId");
CREATE INDEX "oauthAccessToken_refreshId_idx" ON clockgrove_auth."oauthAccessToken" ("refreshId");
REVOKE ALL ON clockgrove_auth."oauthAccessToken" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON clockgrove_auth."oauthAccessToken" TO clockgrove_mcp_auth_writer;

CREATE TABLE clockgrove_auth."oauthConsent" (
  id text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES clockgrove_auth."oauthClient"("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES clockgrove_auth."user"("id") ON DELETE CASCADE,
  "referenceId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "scopes" jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX "oauthConsent_clientId_idx" ON clockgrove_auth."oauthConsent" ("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON clockgrove_auth."oauthConsent" ("userId");
REVOKE ALL ON clockgrove_auth."oauthConsent" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON clockgrove_auth."oauthConsent" TO clockgrove_mcp_auth_writer;

CREATE TABLE clockgrove_auth."oauthClientAssertion" (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL
);
REVOKE ALL ON clockgrove_auth."oauthClientAssertion" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON clockgrove_auth."oauthClientAssertion" TO clockgrove_mcp_auth_writer;

CREATE TABLE clockgrove_auth."apikey" (
  id text PRIMARY KEY,
  "configId" text NOT NULL DEFAULT 'default',
  "name" text,
  "start" text,
  "referenceId" text NOT NULL REFERENCES clockgrove_auth."user"(id) ON DELETE CASCADE,
  "prefix" text,
  "key" text NOT NULL,
  "refillInterval" integer,
  "refillAmount" integer,
  "lastRefillAt" timestamptz,
  "enabled" boolean DEFAULT true,
  "rateLimitEnabled" boolean DEFAULT true,
  "rateLimitTimeWindow" integer DEFAULT 86400000,
  "rateLimitMax" integer DEFAULT 10,
  "requestCount" integer DEFAULT 0,
  "remaining" integer,
  "lastRequest" timestamptz,
  "expiresAt" timestamptz,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "permissions" text,
  "metadata" text
);
CREATE INDEX "apikey_configId_idx" ON clockgrove_auth."apikey" ("configId");
CREATE INDEX "apikey_referenceId_idx" ON clockgrove_auth."apikey" ("referenceId");
CREATE INDEX "apikey_key_idx" ON clockgrove_auth."apikey" ("key");
REVOKE ALL ON clockgrove_auth."apikey" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON clockgrove_auth."apikey" TO clockgrove_mcp_auth_writer;

