-- Issue 167: one shared, mutable budget per canonical principal, never per connection or token.
CREATE TABLE clockgrove.world_mcp_budgets (
  principal_id text PRIMARY KEY REFERENCES clockgrove_management.principals(principal_id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  calls integer NOT NULL CHECK (calls BETWEEN 0 AND 60),
  work_units integer NOT NULL CHECK (work_units BETWEEN 0 AND 240)
);
ALTER TABLE clockgrove.world_mcp_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.world_mcp_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY principal_isolation ON clockgrove.world_mcp_budgets
  USING (principal_id = clockgrove.runtime_principal_id())
  WITH CHECK (principal_id = clockgrove.runtime_principal_id());
REVOKE ALL ON clockgrove.world_mcp_budgets FROM PUBLIC, clockgrove_runtime;

CREATE FUNCTION clockgrove.reserve_world_mcp_request(p_phase text, p_work_units integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  principal text := clockgrove.runtime_principal_id();
  minute_start timestamptz;
  admitted boolean;
BEGIN
  IF principal IS NULL OR p_phase IS NULL OR p_work_units IS NULL
    OR NOT ((p_phase = 'exchange' AND p_work_units = 1)
      OR (p_phase = 'body' AND p_work_units BETWEEN 0 AND 32))
    OR NOT EXISTS (SELECT 1 FROM clockgrove_management.principals
      WHERE principal_id = principal AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'MCP reservation requires an active principal and bounded work' USING ERRCODE = '42501';
  END IF;
  -- Create once, then lock before sampling database time: a waiter cannot reset a newer
  -- window using a timestamp captured before its lock was granted.
  INSERT INTO clockgrove.world_mcp_budgets (principal_id, window_start, calls, work_units)
    VALUES (principal, date_trunc('minute', clock_timestamp()), 0, 0)
    ON CONFLICT (principal_id) DO NOTHING;
  PERFORM 1 FROM clockgrove.world_mcp_budgets WHERE principal_id = principal FOR UPDATE;
  minute_start := date_trunc('minute', clock_timestamp());
  -- Decision: 60 exchanges and 240 input-work units per database minute. These engineering
  -- bounds cap local request work without inventing a dollar price for non-billable tools.
  UPDATE clockgrove.world_mcp_budgets AS budget SET
      window_start = CASE WHEN budget.window_start < minute_start THEN minute_start ELSE budget.window_start END,
      calls = (CASE WHEN budget.window_start < minute_start THEN 0 ELSE budget.calls END)
        + CASE WHEN p_phase = 'exchange' THEN 1 ELSE 0 END,
      work_units = CASE WHEN budget.window_start < minute_start THEN p_work_units ELSE budget.work_units + p_work_units END
    WHERE budget.principal_id = principal AND (budget.window_start < minute_start
      OR ((p_phase = 'body' OR budget.calls < 60) AND budget.work_units + p_work_units <= 240))
    RETURNING true INTO admitted;
  RETURN coalesce(admitted, false);
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.reserve_world_mcp_request(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.reserve_world_mcp_request(text, integer) TO clockgrove_runtime;
