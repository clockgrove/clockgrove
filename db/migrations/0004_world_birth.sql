-- World birth: immutable pack artifacts and installations, provisioning cases, and the versioned birth
-- state of a world. Additive only: no existing table or row changes except three value-set CHECKs on
-- columns that already hold only those values. Worlds, timelines, partitions, streams and events stay in
-- schema clockgrove; the journal (clockgrove.execute_journal) remains the only event writer.

CREATE SCHEMA clockgrove_birth AUTHORIZATION clockgrove_migrator;

ALTER TABLE clockgrove.worlds
  ADD CONSTRAINT worlds_lifecycle_status_check
    CHECK (lifecycle_status IN ('initializing', 'provisioning', 'ready', 'archived'));
ALTER TABLE clockgrove.timelines
  ADD CONSTRAINT timelines_kind_check CHECK (kind IN ('live', 'branch')),
  ADD CONSTRAINT timelines_state_check CHECK (state IN ('active', 'archived'));

CREATE TABLE clockgrove_birth.pack_artifacts (
  tenant_id text NOT NULL REFERENCES clockgrove.tenants (tenant_id),
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  engine_compatibility text NOT NULL,
  resource_manifest_hash text NOT NULL CHECK (resource_manifest_hash ~ '^[0-9a-f]{64}$'),
  asset_manifest_hash text NOT NULL CHECK (asset_manifest_hash ~ '^[0-9a-f]{64}$'),
  migration_set_hash text NOT NULL CHECK (migration_set_hash ~ '^[0-9a-f]{64}$'),
  build_tool_version text NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, pack_id, pack_version),
  UNIQUE (tenant_id, pack_id, pack_version, content_hash)
);

CREATE TABLE clockgrove_birth.pack_artifact_resources (
  tenant_id text NOT NULL,
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  resource_kind text NOT NULL CHECK (
    resource_kind IN ('archetypes', 'traits', 'actors', 'policies', 'cognitiveSeeds', 'spaces', 'rules')
  ),
  resource_id text NOT NULL,
  resource_version integer NOT NULL CHECK (resource_version >= 0),
  path text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  PRIMARY KEY (tenant_id, pack_id, pack_version, path),
  UNIQUE (tenant_id, pack_id, pack_version, resource_kind, resource_id, resource_version, sha256),
  CHECK (sha256 = encode(sha256(content), 'hex')),
  FOREIGN KEY (tenant_id, pack_id, pack_version)
    REFERENCES clockgrove_birth.pack_artifacts (tenant_id, pack_id, pack_version)
);

CREATE TABLE clockgrove_birth.provisioning_cases (
  tenant_id text NOT NULL REFERENCES clockgrove.tenants (tenant_id),
  case_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'seeding', 'verified', 'ready', 'failed')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  seeded_commands integer NOT NULL DEFAULT 0 CHECK (seeded_commands >= 0),
  world_id text,
  last_failure jsonb,
  failure jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, case_id),
  UNIQUE (tenant_id, case_id, world_id),
  FOREIGN KEY (tenant_id, world_id) REFERENCES clockgrove.worlds (tenant_id, world_id),
  CHECK ((status = 'failed') = (failure IS NOT NULL)),
  CHECK (world_id IS NOT NULL OR status IN ('requested', 'failed'))
);

CREATE TABLE clockgrove_birth.pack_installations (
  tenant_id text NOT NULL,
  installation_id text NOT NULL,
  case_id text NOT NULL,
  world_id text NOT NULL,
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('installed')),
  installed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, installation_id),
  UNIQUE (tenant_id, case_id),
  UNIQUE (tenant_id, world_id),
  FOREIGN KEY (tenant_id, case_id, world_id)
    REFERENCES clockgrove_birth.provisioning_cases (tenant_id, case_id, world_id),
  FOREIGN KEY (tenant_id, pack_id, pack_version, content_hash)
    REFERENCES clockgrove_birth.pack_artifacts (tenant_id, pack_id, pack_version, content_hash)
);

CREATE TABLE clockgrove_birth.world_birth_states (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  birth_version integer NOT NULL CHECK (birth_version >= 1),
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  content_hash text NOT NULL,
  state_schema_version integer NOT NULL,
  state_partition_id text NOT NULL,
  scalars jsonb NOT NULL,
  clock_policy jsonb NOT NULL,
  simulation_epoch bigint NOT NULL,
  seed_projection_hash text NOT NULL CHECK (seed_projection_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id),
  FOREIGN KEY (tenant_id, pack_id, pack_version, content_hash)
    REFERENCES clockgrove_birth.pack_artifacts (tenant_id, pack_id, pack_version, content_hash)
);

CREATE TABLE clockgrove_birth.birth_state_sections (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  birth_version integer NOT NULL,
  section text NOT NULL CHECK (section IN ('environment', 'ecology', 'wellbeing', 'lifecycle')),
  section_version integer NOT NULL,
  node jsonb NOT NULL,
  PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version, section),
  FOREIGN KEY (tenant_id, world_id, timeline_id, birth_version)
    REFERENCES clockgrove_birth.world_birth_states (tenant_id, world_id, timeline_id, birth_version)
);

-- Partition-relative state. `ordinal` is the element's position in the original state array and is
-- unique per kind across the world, so the array order is reconstructible exactly.
CREATE TABLE clockgrove_birth.birth_space_state (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  birth_version integer NOT NULL,
  partition_id text NOT NULL,
  space_id text NOT NULL,
  element_kind text NOT NULL CHECK (element_kind IN ('frame', 'region', 'anchor-graph', 'entity')),
  element_key text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  node jsonb NOT NULL,
  PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version, element_kind, element_key),
  UNIQUE (tenant_id, world_id, timeline_id, birth_version, element_kind, ordinal),
  FOREIGN KEY (tenant_id, world_id, timeline_id, birth_version)
    REFERENCES clockgrove_birth.world_birth_states (tenant_id, world_id, timeline_id, birth_version),
  FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id)
    REFERENCES clockgrove.timeline_partitions (tenant_id, world_id, timeline_id, partition_id, space_id)
);

CREATE TABLE clockgrove_birth.birth_schedules (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  birth_version integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  node jsonb NOT NULL,
  PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version, ordinal),
  FOREIGN KEY (tenant_id, world_id, timeline_id, birth_version)
    REFERENCES clockgrove_birth.world_birth_states (tenant_id, world_id, timeline_id, birth_version)
);

CREATE TABLE clockgrove_birth.birth_random_streams (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  birth_version integer NOT NULL,
  stream_name text NOT NULL,
  algorithm text NOT NULL,
  algorithm_version integer NOT NULL CHECK (algorithm_version = 1),
  draws bigint NOT NULL CHECK (draws >= 0),
  state_words text[] NOT NULL CHECK (cardinality(state_words) > 0),
  PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version, stream_name),
  FOREIGN KEY (tenant_id, world_id, timeline_id, birth_version)
    REFERENCES clockgrove_birth.world_birth_states (tenant_id, world_id, timeline_id, birth_version)
);

-- Cognitive seeds are references into the stored immutable artifact; their content is never copied.
CREATE TABLE clockgrove_birth.birth_cognitive_seed_refs (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  birth_version integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  seed_kind text NOT NULL DEFAULT 'cognitiveSeeds' CHECK (seed_kind = 'cognitiveSeeds'),
  seed_id text NOT NULL,
  seed_version integer NOT NULL,
  sha256 text NOT NULL,
  PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version, ordinal),
  FOREIGN KEY (tenant_id, world_id, timeline_id, birth_version)
    REFERENCES clockgrove_birth.world_birth_states (tenant_id, world_id, timeline_id, birth_version),
  FOREIGN KEY (tenant_id, pack_id, pack_version, seed_kind, seed_id, seed_version, sha256)
    REFERENCES clockgrove_birth.pack_artifact_resources (
      tenant_id, pack_id, pack_version, resource_kind, resource_id, resource_version, sha256
    )
);

CREATE FUNCTION clockgrove_birth.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'CG006';
END;
$$;

-- The provisioning case state machine. ready and failed are terminal; identity never changes; counters
-- only advance; a case is ready only after its world is ready.
CREATE FUNCTION clockgrove_birth.guard_case_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.pack_id IS DISTINCT FROM OLD.pack_id
    OR NEW.pack_version IS DISTINCT FROM OLD.pack_version
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'provisioning case identity is immutable' USING ERRCODE = 'CG006';
  END IF;
  IF OLD.status IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'provisioning case is terminal' USING ERRCODE = 'CG006';
  END IF;
  IF OLD.world_id IS NOT NULL AND NEW.world_id IS DISTINCT FROM OLD.world_id THEN
    RAISE EXCEPTION 'provisioning case world is immutable' USING ERRCODE = 'CG006';
  END IF;
  IF NEW.attempts < OLD.attempts
    OR NEW.seeded_commands < OLD.seeded_commands
    OR NEW.seeded_commands > OLD.seeded_commands + 1 THEN
    RAISE EXCEPTION 'provisioning case counters only advance' USING ERRCODE = 'CG006';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'requested' AND NEW.status IN ('seeding', 'failed'))
    OR (OLD.status = 'seeding' AND NEW.status IN ('verified', 'failed'))
    OR (OLD.status = 'verified' AND NEW.status IN ('ready', 'failed'))
  ) THEN
    RAISE EXCEPTION 'provisioning case cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'CG006';
  END IF;
  IF NEW.status = 'ready' AND NOT EXISTS (
    SELECT 1 FROM clockgrove.worlds world
    WHERE world.tenant_id = NEW.tenant_id AND world.world_id = NEW.world_id
      AND world.lifecycle_status = 'ready'
  ) THEN
    RAISE EXCEPTION 'provisioning case is ready only after its world is ready' USING ERRCODE = 'CG006';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provisioning_cases_guard_transition
  BEFORE UPDATE ON clockgrove_birth.provisioning_cases
  FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.guard_case_transition();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pack_artifacts',
    'pack_artifact_resources',
    'pack_installations',
    'world_birth_states',
    'birth_state_sections',
    'birth_space_state',
    'birth_schedules',
    'birth_random_streams',
    'birth_cognitive_seed_refs'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON clockgrove_birth.%I FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.reject_mutation()',
      table_name || '_immutable_rows', table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON clockgrove_birth.%I FOR EACH STATEMENT EXECUTE FUNCTION clockgrove_birth.reject_mutation()',
      table_name || '_immutable_truncate', table_name
    );
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'pack_artifacts',
    'pack_artifact_resources',
    'provisioning_cases',
    'pack_installations',
    'world_birth_states',
    'birth_state_sections',
    'birth_space_state',
    'birth_schedules',
    'birth_random_streams',
    'birth_cognitive_seed_refs'
  ] LOOP
    EXECUTE format('ALTER TABLE clockgrove_birth.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE clockgrove_birth.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON clockgrove_birth.%I USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id))',
      table_name
    );
  END LOOP;
END;
$$;

REVOKE ALL ON SCHEMA clockgrove_birth FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA clockgrove_birth FROM PUBLIC;
GRANT USAGE ON SCHEMA clockgrove_birth TO clockgrove_runtime;
GRANT SELECT, INSERT ON
  clockgrove_birth.pack_artifacts,
  clockgrove_birth.pack_artifact_resources,
  clockgrove_birth.pack_installations,
  clockgrove_birth.world_birth_states,
  clockgrove_birth.birth_state_sections,
  clockgrove_birth.birth_space_state,
  clockgrove_birth.birth_schedules,
  clockgrove_birth.birth_random_streams,
  clockgrove_birth.birth_cognitive_seed_refs
TO clockgrove_runtime;
GRANT SELECT, INSERT, UPDATE ON clockgrove_birth.provisioning_cases TO clockgrove_runtime;
