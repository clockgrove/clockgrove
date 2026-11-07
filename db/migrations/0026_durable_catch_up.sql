-- Operational linkage is one fixed-size slot per physical partition, never world history.
ALTER TABLE clockgrove.partition_states
  ADD COLUMN catch_up_run_id text,
  ADD COLUMN catch_up_owner_generation bigint,
  ADD COLUMN catch_up_policy_version bigint,
  ADD COLUMN catch_up_wall_time bigint,
  ADD COLUMN catch_up_step bigint,
  ADD COLUMN catch_up_reconcile_attempted_at timestamptz,
  ADD CONSTRAINT catch_up_link_complete CHECK (
    (catch_up_run_id IS NULL AND catch_up_owner_generation IS NULL AND catch_up_policy_version IS NULL
      AND catch_up_wall_time IS NULL AND catch_up_step IS NULL AND catch_up_reconcile_attempted_at IS NULL)
    OR (catch_up_run_id IS NOT NULL AND octet_length(catch_up_run_id) BETWEEN 1 AND 1024
      AND catch_up_owner_generation IS NOT NULL AND catch_up_owner_generation >= 0
      AND catch_up_policy_version IS NOT NULL AND catch_up_policy_version >= 0
      AND catch_up_wall_time IS NOT NULL AND catch_up_wall_time >= 0
      AND catch_up_step IS NOT NULL AND catch_up_step >= 0)
  ),
  ADD CONSTRAINT catch_up_run_identity UNIQUE (catch_up_run_id);

-- Ordinary tenant membership cannot install, change or retire autonomous operation authority.
CREATE FUNCTION clockgrove.guard_catch_up_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- A canonical policy replacement retires only its old operational linkage, atomically with the
  -- already authorized clock-control command. Earned backlog and admission accounting stay intact.
  IF TG_OP = 'UPDATE' AND NEW.clock_policy IS DISTINCT FROM OLD.clock_policy
     AND ROW(NEW.catch_up_run_id, NEW.catch_up_owner_generation, NEW.catch_up_policy_version,
       NEW.catch_up_wall_time, NEW.catch_up_step, NEW.catch_up_reconcile_attempted_at)
       IS NOT DISTINCT FROM ROW(OLD.catch_up_run_id, OLD.catch_up_owner_generation,
       OLD.catch_up_policy_version, OLD.catch_up_wall_time, OLD.catch_up_step,
       OLD.catch_up_reconcile_attempted_at) THEN
    NEW.catch_up_run_id := NULL;
    NEW.catch_up_owner_generation := NULL;
    NEW.catch_up_policy_version := NULL;
    NEW.catch_up_wall_time := NULL;
    NEW.catch_up_step := NULL;
    NEW.catch_up_reconcile_attempted_at := NULL;
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.catch_up_run_id IS NOT NULL) OR
     (TG_OP = 'UPDATE' AND ROW(NEW.catch_up_run_id, NEW.catch_up_owner_generation,
       NEW.catch_up_policy_version, NEW.catch_up_wall_time, NEW.catch_up_step)
       IS DISTINCT FROM ROW(OLD.catch_up_run_id, OLD.catch_up_owner_generation,
       OLD.catch_up_policy_version, OLD.catch_up_wall_time, OLD.catch_up_step)) THEN
    IF clockgrove.runtime_tenant_id() IS DISTINCT FROM NEW.tenant_id
       OR clockgrove.runtime_principal_id() IS DISTINCT FROM
          clockgrove.resolve_ready_clock_principal(NEW.tenant_id, NEW.world_id, NEW.timeline_id, NEW.space_id)
       OR clockgrove.runtime_principal_id() IS NULL THEN
      RAISE EXCEPTION 'catch-up requires world system principal' USING ERRCODE = '42501';
    END IF;
    IF NEW.catch_up_run_id IS NOT NULL AND
       NEW.catch_up_owner_generation IS DISTINCT FROM NEW.clock_owner_generation THEN
      RAISE EXCEPTION 'catch-up owner is superseded' USING ERRCODE = 'CG006';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER partition_catch_up_guard BEFORE INSERT OR UPDATE ON clockgrove.partition_states
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_catch_up_link();

-- Lookup reveals only the accepted operation reference, never arbitrary caller-selected authority.
CREATE FUNCTION clockgrove.read_catch_up_operation(p_tenant text, p_world text, p_timeline text,
  p_space text, p_run text)
RETURNS TABLE (tenant_id text, world_id text, timeline_id text, space_id text, catch_up_run_id text,
  catch_up_owner_generation text, catch_up_policy_version text, catch_up_wall_time text, catch_up_step text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT state.tenant_id, state.world_id, state.timeline_id, state.space_id, state.catch_up_run_id,
    state.catch_up_owner_generation::text, state.catch_up_policy_version::text,
    state.catch_up_wall_time::text, state.catch_up_step::text
  FROM clockgrove.partition_states AS state
  WHERE state.tenant_id = p_tenant AND state.world_id = p_world AND state.timeline_id = p_timeline
    AND state.space_id = p_space AND state.catch_up_run_id = p_run
    AND (clockgrove.runtime_tenant_id() IS NULL OR clockgrove.runtime_tenant_id() = p_tenant);
$$;
REVOKE ALL ON FUNCTION clockgrove.read_catch_up_operation(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.read_catch_up_operation(text,text,text,text,text) TO clockgrove_runtime;

CREATE INDEX partition_open_catch_up ON clockgrove.partition_states
  (catch_up_reconcile_attempted_at NULLS FIRST, tenant_id, timeline_id, partition_id)
  WHERE catch_up_run_id IS NOT NULL;
-- A failing candidate rotates behind untouched candidates, even if its RPC never connects.
CREATE FUNCTION clockgrove.open_catch_up_operations(p_limit integer)
RETURNS TABLE (tenant_id text, world_id text, timeline_id text, space_id text, catch_up_run_id text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE clockgrove.partition_states AS state SET catch_up_reconcile_attempted_at = statement_timestamp()
  WHERE (state.tenant_id, state.timeline_id, state.partition_id) IN (
    SELECT candidate.tenant_id, candidate.timeline_id, candidate.partition_id
    FROM clockgrove.partition_states AS candidate WHERE candidate.catch_up_run_id IS NOT NULL
    ORDER BY candidate.catch_up_reconcile_attempted_at NULLS FIRST,
      candidate.tenant_id, candidate.timeline_id, candidate.partition_id
    LIMIT greatest(p_limit, 0) FOR UPDATE SKIP LOCKED)
  RETURNING state.tenant_id, state.world_id, state.timeline_id, state.space_id, state.catch_up_run_id;
$$;
REVOKE ALL ON FUNCTION clockgrove.open_catch_up_operations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.open_catch_up_operations(integer) TO clockgrove_runtime;
