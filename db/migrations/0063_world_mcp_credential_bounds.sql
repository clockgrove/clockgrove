-- Issue 167 engineering bounds: 16 member keys and 64 active OAuth tokens/consents
-- per auth subject; 1024 public clients; 2048 short-lived verification values.
-- Serial admission makes capacity shared across workers and credentials. Thirty-day
-- clients/consents expire to bound abandoned registrations; re-consent is then required.
CREATE TABLE clockgrove_auth.mcp_issuance_budget (
  singleton boolean PRIMARY KEY CHECK (singleton),
  window_start timestamptz NOT NULL,
  insertions integer NOT NULL CHECK (insertions BETWEEN 0 AND 240)
);
REVOKE ALL ON clockgrove_auth.mcp_issuance_budget FROM PUBLIC, clockgrove_mcp_auth_writer;

CREATE FUNCTION clockgrove_auth.retire_mcp_credentials() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove_auth AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(167, 63);
  DELETE FROM clockgrove_auth.apikey WHERE "expiresAt" <= clock_timestamp() OR "enabled" = false;
  DELETE FROM clockgrove_auth."oauthAccessToken" WHERE "expiresAt" <= clock_timestamp() OR revoked IS NOT NULL;
  DELETE FROM clockgrove_auth."oauthRefreshToken" WHERE "expiresAt" <= clock_timestamp() OR revoked IS NOT NULL;
  DELETE FROM clockgrove_auth."oauthClientAssertion" WHERE "expiresAt" <= clock_timestamp();
  DELETE FROM clockgrove_auth.verification WHERE "expiresAt" <= clock_timestamp();
  DELETE FROM clockgrove_auth."oauthClient" WHERE "createdAt" < clock_timestamp() - interval '30 days';
  DELETE FROM clockgrove_auth."oauthConsent" WHERE "updatedAt" < clock_timestamp() - interval '30 days';
END;
$$;
REVOKE ALL ON FUNCTION clockgrove_auth.retire_mcp_credentials() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove_auth.retire_mcp_credentials() TO clockgrove_mcp_auth_writer;

CREATE FUNCTION clockgrove_auth.bound_mcp_credential() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove_auth AS $$
DECLARE
  total bigint;
  subject_total bigint;
  maximum integer;
  minute_start timestamptz;
BEGIN
  PERFORM clockgrove_auth.retire_mcp_credentials();
  minute_start := date_trunc('minute', clock_timestamp());
  -- Decision: at most 240 committed credential rows/minute across public issuance;
  -- dependent rows count too. Failed transactions retain neither rows nor capacity.
  INSERT INTO clockgrove_auth.mcp_issuance_budget VALUES (true, minute_start, 0)
    ON CONFLICT (singleton) DO NOTHING;
  UPDATE clockgrove_auth.mcp_issuance_budget SET
    insertions = CASE WHEN window_start < minute_start THEN 1 ELSE insertions + 1 END,
    window_start = greatest(window_start, minute_start)
    WHERE singleton AND (window_start < minute_start OR insertions < 240);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP credential capacity exhausted' USING ERRCODE = '54000';
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'apikey' THEN
      SELECT count(*), count(*) FILTER (WHERE "referenceId" = NEW."referenceId") INTO total, subject_total FROM clockgrove_auth.apikey;
      maximum := 16384; -- 1024 subjects at their 16-key cap, an installation storage bound.
      IF subject_total >= 16 THEN RAISE EXCEPTION 'MCP credential capacity exhausted' USING ERRCODE = '54000'; END IF;
    WHEN 'oauthClient' THEN
      SELECT count(*) INTO total FROM clockgrove_auth."oauthClient";
      maximum := 1024;
    WHEN 'oauthAccessToken' THEN
      -- The SDK consumes authorization codes before creating the token and does not
      -- recheck consent. Fence an in-flight exchange against committed revocation.
      IF NOT EXISTS (SELECT 1 FROM clockgrove_auth."oauthConsent" consent
        WHERE consent."clientId" = NEW."clientId" AND consent."userId" = NEW."userId"
          AND consent.scopes @> NEW.scopes
          AND coalesce(consent.resources, '[]'::jsonb) @> coalesce(NEW.resources, '[]'::jsonb)) THEN
        RAISE EXCEPTION 'MCP consent required' USING ERRCODE = '42501';
      END IF;
      SELECT count(*), count(*) FILTER (WHERE "userId" = NEW."userId") INTO total, subject_total FROM clockgrove_auth."oauthAccessToken";
      maximum := 65536; -- 1024 subjects at their 64-token cap.
      IF subject_total >= 64 THEN RAISE EXCEPTION 'MCP credential capacity exhausted' USING ERRCODE = '54000'; END IF;
    WHEN 'oauthConsent' THEN
      SELECT count(*), count(*) FILTER (WHERE "userId" = NEW."userId") INTO total, subject_total FROM clockgrove_auth."oauthConsent";
      maximum := 65536;
      IF subject_total >= 64 THEN RAISE EXCEPTION 'MCP credential capacity exhausted' USING ERRCODE = '54000'; END IF;
    WHEN 'verification' THEN
      SELECT count(*) INTO total FROM clockgrove_auth.verification;
      maximum := 2048;
    ELSE
      RAISE EXCEPTION 'unsupported MCP credential' USING ERRCODE = '42501';
  END CASE;
  IF total >= maximum THEN
    RAISE EXCEPTION 'MCP credential capacity exhausted' USING ERRCODE = '54000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove_auth.bound_mcp_credential() FROM PUBLIC;
CREATE TRIGGER bound_mcp_key BEFORE INSERT ON clockgrove_auth.apikey FOR EACH ROW EXECUTE FUNCTION clockgrove_auth.bound_mcp_credential();
CREATE TRIGGER bound_mcp_client BEFORE INSERT ON clockgrove_auth."oauthClient" FOR EACH ROW EXECUTE FUNCTION clockgrove_auth.bound_mcp_credential();
CREATE TRIGGER bound_mcp_access BEFORE INSERT ON clockgrove_auth."oauthAccessToken" FOR EACH ROW EXECUTE FUNCTION clockgrove_auth.bound_mcp_credential();
CREATE TRIGGER bound_mcp_consent BEFORE INSERT ON clockgrove_auth."oauthConsent" FOR EACH ROW EXECUTE FUNCTION clockgrove_auth.bound_mcp_credential();
CREATE TRIGGER bound_mcp_verification BEFORE INSERT ON clockgrove_auth.verification FOR EACH ROW WHEN (current_user = 'clockgrove_mcp_auth_writer') EXECUTE FUNCTION clockgrove_auth.bound_mcp_credential();

-- Revoking a consent revokes its existing credentials as well as future exchanges.
CREATE FUNCTION clockgrove_auth.revoke_mcp_consent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove_auth AS $$
BEGIN
  -- Shares issuance's transaction fence, so a token created by an exchange that
  -- already consumed its code is either deleted here or refused by live consent.
  PERFORM pg_advisory_xact_lock(167, 63);
  DELETE FROM clockgrove_auth.verification WHERE CASE WHEN value IS JSON OBJECT THEN
    value::jsonb->>'type' = 'authorization_code'
      AND value::jsonb->>'userId' = OLD."userId"
      AND value::jsonb #>> '{query,client_id}' = OLD."clientId"
    ELSE false END;
  DELETE FROM clockgrove_auth."oauthAccessToken" WHERE "clientId" = OLD."clientId" AND "userId" = OLD."userId";
  DELETE FROM clockgrove_auth."oauthRefreshToken" WHERE "clientId" = OLD."clientId" AND "userId" = OLD."userId";
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove_auth.revoke_mcp_consent() FROM PUBLIC;
CREATE TRIGGER revoke_mcp_consent AFTER DELETE ON clockgrove_auth."oauthConsent" FOR EACH ROW EXECUTE FUNCTION clockgrove_auth.revoke_mcp_consent();
CREATE INDEX mcp_key_expiry_idx ON clockgrove_auth.apikey ("expiresAt");
CREATE INDEX mcp_access_expiry_idx ON clockgrove_auth."oauthAccessToken" ("expiresAt");
CREATE INDEX mcp_refresh_expiry_idx ON clockgrove_auth."oauthRefreshToken" ("expiresAt");
CREATE INDEX mcp_client_retirement_idx ON clockgrove_auth."oauthClient" ("createdAt");
CREATE INDEX mcp_consent_retirement_idx ON clockgrove_auth."oauthConsent" ("updatedAt");
