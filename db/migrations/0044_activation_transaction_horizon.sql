-- Issue 138: the activation cursor (0043) orders events by the transaction ID of the cluster that
-- wrote them. A logical dump carries those IDs to any cluster it is restored into. Where the new
-- cluster's transaction counter is behind them, every new event sorts at or before a restored
-- cursor and is never read, and a restored event stays unsettled until the counter passes it.
--
-- So no stored activation transaction ID may be ahead of the transaction that stores it. Every write
-- in this cluster meets that: the stamp is the writer's own ID, a cursor is a settled event's ID or a
-- snapshot's xmax. A restore whose IDs are ahead of the new cluster is refused row by row, before
-- anything can read it. PITR, branches, pg_upgrade and a restore into the same cluster keep the
-- counter ahead, so they pass. The repair is rebase_activation_order() below, run before the dump.
ALTER TABLE clockgrove.events
  ADD CONSTRAINT events_transaction_not_ahead CHECK (transaction_id <= pg_current_xact_id());
ALTER TABLE clockgrove.actor_activation_policies
  ADD CONSTRAINT actor_activation_policies_cursor_not_ahead
  CHECK (event_cursor_transaction <= pg_current_xact_id());

-- Replaces every stored activation transaction ID with a small ordinal that keeps each cursor's
-- split exactly: per timeline, an event becomes the number of distinct cursors below its
-- (transaction, position) pair, and a cursor of rank r becomes (r - 1, the highest position). Each
-- cursor then has read exactly the events it had read, and its unread events stay unread. Every ID
-- left is at most the timeline's number of distinct cursors, below any cluster's counter, so the
-- database restores anywhere; IDs drawn afterwards sort after all of them.
--
-- An operator tool, run as the migrator or an administrator with the runtime stopped. The lock
-- waits for every open append and acknowledgement, and holds off new ones until commit; read
-- committed lets the rewrite see every append that committed before it.
CREATE FUNCTION clockgrove.rebase_activation_order() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rebase_activation_order needs a read committed transaction'
      USING ERRCODE = '25000';
  END IF;
  LOCK TABLE clockgrove.events, clockgrove.actor_activation_policies IN EXCLUSIVE MODE;
  WITH cursors AS (
    SELECT DISTINCT tenant_id, world_id, timeline_id,
      event_cursor_transaction AS transaction_id, event_cursor AS position
    FROM clockgrove.actor_activation_policies
  ), keys AS (
    -- A cursor sorts after an event with the same pair: that event is at, not below, the cursor.
    SELECT tenant_id, world_id, timeline_id, transaction_id, position, 1 AS is_cursor,
      NULL::text AS event_id
    FROM cursors
    UNION ALL
    SELECT tenant_id, world_id, timeline_id, transaction_id, journal_position, 0, event_id
    FROM clockgrove.events
  ), ranked AS (
    SELECT keys.*, count(*) FILTER (WHERE is_cursor = 1) OVER (
      PARTITION BY tenant_id, world_id, timeline_id
      ORDER BY transaction_id, position, is_cursor ROWS UNBOUNDED PRECEDING) AS cursors_at_or_below
    FROM keys
  ), rebased_events AS (
    UPDATE clockgrove.events AS e
    SET transaction_id = r.cursors_at_or_below::text::xid8
    FROM ranked AS r
    WHERE r.is_cursor = 0 AND e.event_id = r.event_id
  )
  UPDATE clockgrove.actor_activation_policies AS p
  SET event_cursor_transaction = (r.cursors_at_or_below - 1)::text::xid8,
    event_cursor = (SELECT coalesce(max(journal_position), 0) FROM clockgrove.events)
  FROM ranked AS r
  WHERE r.is_cursor = 1 AND p.tenant_id = r.tenant_id AND p.world_id = r.world_id
    AND p.timeline_id = r.timeline_id AND p.event_cursor_transaction = r.transaction_id
    AND p.event_cursor = r.position;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.rebase_activation_order() FROM PUBLIC;
