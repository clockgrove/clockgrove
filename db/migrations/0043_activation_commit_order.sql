-- Issue 128: journal positions come from one sequence, but the partitions of one timeline commit in
-- parallel under separate head locks (0014). A lower position can become visible after a higher
-- one, so an activation cursor that moved past a position number could skip an event for good.
--
-- Each event records the transaction that appended it. A reader takes an event only once that
-- transaction is older than its snapshot's xmin: every such transaction has ended, so nothing can
-- still appear at or before the cursor, which orders events by (transaction_id, journal_position).
-- Rows that predate this migration read transaction 0: the ALTER waits for every open append.
ALTER TABLE clockgrove.events ADD COLUMN transaction_id xid8 NOT NULL DEFAULT '0';

-- The database stamps the appending transaction; no writer chooses it.
CREATE FUNCTION clockgrove.stamp_event_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.transaction_id := pg_current_xact_id();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.stamp_event_transaction() FROM PUBLIC;
CREATE TRIGGER events_transaction_stamp BEFORE INSERT ON clockgrove.events
  FOR EACH ROW EXECUTE FUNCTION clockgrove.stamp_event_transaction();

CREATE INDEX events_commit_order_idx
  ON clockgrove.events (tenant_id, world_id, timeline_id, transaction_id, journal_position);

-- The cursor is the pair (event_cursor_transaction, event_cursor). Existing cursors keep their
-- position with transaction 0: they still read every later legacy row and every new one.
ALTER TABLE clockgrove.actor_activation_policies
  ADD COLUMN event_cursor_transaction xid8 NOT NULL DEFAULT '0';
GRANT UPDATE (event_cursor_transaction) ON clockgrove.actor_activation_policies TO clockgrove_runtime;
