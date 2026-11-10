-- Process cursors live in the canonical state, rather than the actor decision queue. Materialize
-- only their minimum for the existing partition-key alarm reads; document writes (including birth
-- and rollback) keep the hint atomic without changing journal, queue or canonical document bytes.
CREATE FUNCTION clockgrove.world_process_deadline(p_document jsonb) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  v_state jsonb;
  v_processes jsonb;
  v_cursor jsonb;
  v_next jsonb;
  v_due bigint;
  v_min bigint;
BEGIN
  SELECT entry->1 INTO v_state
    FROM jsonb_array_elements(p_document->1) AS entry WHERE entry->>0 = 'state';
  SELECT entry->1 INTO v_processes
    FROM jsonb_array_elements(v_state->1) AS entry WHERE entry->>0 = 'processes';
  IF v_processes IS NULL THEN RETURN NULL; END IF;
  IF v_processes->>0 IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_processes->1) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'malformed process cursor list' USING ERRCODE = '22023';
  END IF;
  FOR v_cursor IN SELECT value FROM jsonb_array_elements(v_processes->1) LOOP
    IF v_cursor->>0 IS DISTINCT FROM 'record'
       OR jsonb_typeof(v_cursor->1) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'malformed process cursor' USING ERRCODE = '22023';
    END IF;
    SELECT entry->1 INTO v_next
      FROM jsonb_array_elements(v_cursor->1) AS entry WHERE entry->>0 = 'nextAt';
    IF v_next = '["null"]'::jsonb THEN CONTINUE; END IF;
    IF v_next IS NULL OR v_next->>0 IS DISTINCT FROM 'bigint'
       OR jsonb_array_length(v_next) <> 2 OR v_next->>1 !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'malformed process deadline' USING ERRCODE = '22023';
    END IF;
    v_due := (v_next->>1)::bigint;
    v_min := least(v_min, v_due);
  END LOOP;
  RETURN v_min;
END;
$$;

-- Let PostgreSQL populate existing rows during DDL, then retain those values as an ordinary
-- column so full-row clones/restores can supply it. Subsequent writes are derived by the trigger.
ALTER TABLE clockgrove.partition_states
  ADD COLUMN next_process_due_at bigint GENERATED ALWAYS AS
    (clockgrove.world_process_deadline(document)) STORED;
ALTER TABLE clockgrove.partition_states
  ALTER COLUMN next_process_due_at DROP EXPRESSION;

-- Derive supplied hints too: whole-row restores/clones may name this column, but cannot change
-- the deadline independently of the canonical cursor list.
CREATE FUNCTION clockgrove.derive_world_process_deadline() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.next_process_due_at := clockgrove.world_process_deadline(NEW.document);
  RETURN NEW;
END;
$$;

CREATE TRIGGER partition_world_process_deadline
  BEFORE INSERT OR UPDATE OF document, next_process_due_at ON clockgrove.partition_states
  FOR EACH ROW EXECUTE FUNCTION clockgrove.derive_world_process_deadline();

-- Preserve the optional cursor list (including an explicitly empty list) in the reconstructable
-- birth rows, exactly like the other optional canonical state sections.
ALTER TABLE clockgrove_birth.birth_state_sections
  DROP CONSTRAINT birth_state_sections_section_check,
  ADD CONSTRAINT birth_state_sections_section_check
    CHECK (section IN ('environment', 'ecology', 'wellbeing', 'lifecycle', 'processes'));
