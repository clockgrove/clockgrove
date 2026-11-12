-- Issue 165 internal admission only. Privileged composition owns these tables; neither a
-- model nor clockgrove_runtime can reset reservations or change the emergency fence.
-- Engineering metadata bounds: 4 KiB policy and 32 KiB immutable identity keep a call
-- envelope finite; content is separately bounded and stored only in encrypted artifacts.
CREATE TABLE clockgrove.mcp_read_switches (
  scope text NOT NULL CHECK (scope IN ('global','world','installation')),
  tenant_id text NOT NULL DEFAULT '', world_id text NOT NULL DEFAULT '',
  timeline_id text NOT NULL DEFAULT '', installation_id text NOT NULL DEFAULT '',
  disabled boolean NOT NULL,
  PRIMARY KEY(scope,tenant_id,world_id,timeline_id,installation_id),
  CHECK ((scope='global' AND tenant_id='' AND world_id='' AND timeline_id='' AND installation_id='')
    OR (scope='world' AND tenant_id<>'' AND world_id<>'' AND timeline_id='' AND installation_id='')
    OR (scope='installation' AND tenant_id<>'' AND world_id<>'' AND timeline_id<>'' AND installation_id<>''))
);
CREATE TABLE clockgrove.mcp_read_turn_budgets (
  tenant_id text NOT NULL, world_id text NOT NULL, timeline_id text NOT NULL,
  turn_id text NOT NULL CHECK (octet_length(turn_id) BETWEEN 1 AND 1024),
  actor_id text NOT NULL, principal_id text NOT NULL, session_id text,
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy)='object' AND octet_length(policy::text)<=4096),
  calls integer NOT NULL DEFAULT 0 CHECK (calls>=0),
  reserved_microusd bigint NOT NULL DEFAULT 0 CHECK (reserved_microusd BETWEEN 0 AND 9007199254740991),
  reserved_time_ms bigint NOT NULL DEFAULT 0 CHECK (reserved_time_ms BETWEEN 0 AND 9007199254740991),
  reserved_output_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_output_bytes BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(tenant_id,world_id,timeline_id,turn_id),
  FOREIGN KEY(tenant_id,world_id,timeline_id) REFERENCES clockgrove.timelines(tenant_id,world_id,timeline_id),
  FOREIGN KEY(tenant_id,principal_id) REFERENCES clockgrove.tenant_principals(tenant_id,principal_id)
);
CREATE TABLE clockgrove.mcp_read_admissions (
  tenant_id text NOT NULL, world_id text NOT NULL, timeline_id text NOT NULL,
  effect_id text NOT NULL, turn_id text NOT NULL, installation_id text NOT NULL,
  -- Complete immutable retry identity contains references and hash only, never arguments or secrets.
  identity jsonb NOT NULL CHECK (jsonb_typeof(identity)='object' AND octet_length(identity::text)<=32768),
  reserved_time_ms bigint NOT NULL CHECK (reserved_time_ms BETWEEN 1 AND 9007199254740991),
  reserved_output_bytes bigint NOT NULL CHECK (reserved_output_bytes BETWEEN 1 AND 65536),
  admitted boolean NOT NULL,
  PRIMARY KEY(tenant_id,world_id,timeline_id,effect_id),
  FOREIGN KEY(tenant_id,world_id,timeline_id,effect_id)
    REFERENCES clockgrove.effect_intents(tenant_id,world_id,timeline_id,effect_id),
  FOREIGN KEY(tenant_id,world_id,timeline_id,turn_id)
    REFERENCES clockgrove.mcp_read_turn_budgets(tenant_id,world_id,timeline_id,turn_id)
);
DO $$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['mcp_read_switches','mcp_read_turn_budgets','mcp_read_admissions'] LOOP
    EXECUTE format('ALTER TABLE clockgrove.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('ALTER TABLE clockgrove.%I FORCE ROW LEVEL SECURITY',n);
    EXECUTE format('REVOKE ALL ON clockgrove.%I FROM PUBLIC,clockgrove_runtime',n);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON clockgrove.%I
      FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation()',n||'_no_delete',n);
  END LOOP;
END $$;
CREATE TRIGGER mcp_read_admission_immutable BEFORE UPDATE ON clockgrove.mcp_read_admissions
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
