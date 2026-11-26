-- Issue 329, part 6: offers. The developer's server defines in-world offers (a shop, a character
-- suggesting an upgrade), each presented by an actor of a space. The world shows them in a
-- player's conversation with that actor and records when one is shown and when one is chosen; each
-- record becomes a usage event (`offer_shown`, `offer_chosen`), so it reaches the developer through
-- the query, the feed and the webhooks. Checkout stays the developer's: no price, payment or
-- account lives here. Both tables have row-level security with no policy and no grant; the runtime
-- reaches them only through the definer functions below.

ALTER TABLE clockgrove.usage_events DROP CONSTRAINT usage_events_category_check,
  ADD CONSTRAINT usage_events_category_check CHECK (
    category IN ('model_call', 'tool_call', 'delivery', 'offer_shown', 'offer_chosen'));
ALTER TABLE clockgrove.usage_events DROP CONSTRAINT usage_events_source_check,
  ADD CONSTRAINT usage_events_source_check CHECK (
    source IN ('run_step', 'delivery_receipt', 'wake_triage', 'moderation_shadow',
      'offer_presentation'));

-- One row per space and offer, updated in place and never deleted: a withdrawn offer keeps its row
-- so its past events still name it. Title and text are the developer's plain text, shown to every
-- player who talks to the actor. Decision: a title of 1 to 80 characters, a text of at most 280.
CREATE TABLE clockgrove.world_offers (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  offer_id text NOT NULL CHECK (offer_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  actor_id text NOT NULL CHECK (octet_length(actor_id) BETWEEN 1 AND 1024),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (char_length(body) <= 280),
  checkout_url text CHECK (checkout_url ~ '^https://' AND octet_length(checkout_url) <= 2048),
  withdrawn boolean NOT NULL DEFAULT false,
  -- Who set it last.
  principal_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, world_id, timeline_id, space_id, offer_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id)
);
CREATE INDEX world_offers_actor
  ON clockgrove.world_offers (tenant_id, world_id, timeline_id, space_id, actor_id);
ALTER TABLE clockgrove.world_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.world_offers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON clockgrove.world_offers FROM PUBLIC;
CREATE TRIGGER world_offers_no_delete BEFORE DELETE ON clockgrove.world_offers
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER world_offers_no_truncate BEFORE TRUNCATE ON clockgrove.world_offers
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- One row per conversation session and offer: the offer was shown in that session, and perhaps
-- chosen. Attribution is fixed when it is shown: the session's participant (the player and their
-- persona), the presenting actor and the session.
CREATE TABLE clockgrove.offer_presentations (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  offer_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  principal_id text NOT NULL,
  persona_id text,
  actor_id text NOT NULL,
  shown_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  chosen_at timestamptz CHECK (chosen_at >= shown_at),
  PRIMARY KEY (tenant_id, session_id, offer_id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES clockgrove.conversation_sessions (tenant_id, session_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id, space_id, offer_id)
    REFERENCES clockgrove.world_offers (tenant_id, world_id, timeline_id, space_id, offer_id)
);
ALTER TABLE clockgrove.offer_presentations ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.offer_presentations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON clockgrove.offer_presentations FROM PUBLIC;
CREATE TRIGGER offer_presentations_no_delete BEFORE DELETE ON clockgrove.offer_presentations
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER offer_presentations_no_truncate BEFORE TRUNCATE ON clockgrove.offer_presentations
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- The offers of a space the developer's server set and has not withdrawn, in offer order.
CREATE FUNCTION clockgrove.space_offers(t text, w text, tl text, s text)
RETURNS TABLE (offer_id text, actor_id text, title text, body text, checkout_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
  SELECT o.offer_id, o.actor_id, o.title, o.body, o.checkout_url
    FROM clockgrove.world_offers o
   WHERE o.tenant_id = t AND o.world_id = w AND o.timeline_id = tl AND o.space_id = s
     AND NOT o.withdrawn
   ORDER BY o.offer_id
$$;
REVOKE ALL ON FUNCTION clockgrove.space_offers(text, text, text, text) FROM PUBLIC;

-- Sets or (with `withdraw`) withdraws one offer of the space, and answers the space's offers.
-- An offer puts the developer's commerce in front of every player who talks to its actor, with a
-- link to a checkout host the caller names, so it takes the purchase's authority, not the
-- operator's: the usage reader's grant and ceiling, and `runtime:world-purchase`, which a world's
-- owner holds by default and may delegate (the owner's decision of 2026-11-26 on purchases); an
-- actor or system identity never qualifies. `runtime:world-operate` never implies it.
-- Decision: at most 100 offer ids a space, a page. Rows are never deleted, so a withdrawn offer's id
-- still counts; setting it again reuses it.
CREATE FUNCTION clockgrove.set_world_offer(t text, w text, tl text, s text, oid text, actor text,
  ttl text, txt text, url text, withdraw boolean)
RETURNS TABLE (offer_id text, actor_id text, title text, body text, checkout_url text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
#variable_conflict use_column
BEGIN
  IF NOT clockgrove.runtime_usage_reader(t, w, tl, s) OR NOT EXISTS (
       SELECT 1 FROM clockgrove.world_memberships m
        WHERE m.tenant_id = t AND m.world_id = w AND m.timeline_id = tl AND m.space_id = s
          AND m.principal_id = clockgrove.runtime_principal_id() AND m.revoked_at IS NULL
          AND NOT 'actor' = ANY(m.roles) AND left(m.principal_id, 7) <> 'system:'
          AND ('runtime:world-purchase' = ANY(m.grants) OR 'owner' = ANY(m.roles))) THEN
    RAISE EXCEPTION 'world offer refused' USING ERRCODE = '42501';
  END IF;
  IF withdraw THEN
    UPDATE clockgrove.world_offers o
       SET withdrawn = true, principal_id = clockgrove.runtime_principal_id(),
           updated_at = statement_timestamp()
     WHERE o.tenant_id = t AND o.world_id = w AND o.timeline_id = tl AND o.space_id = s
       AND o.offer_id = oid;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM clockgrove.world_offers o
                    WHERE o.tenant_id = t AND o.world_id = w AND o.timeline_id = tl
                      AND o.space_id = s AND o.offer_id = oid)
       AND (SELECT count(*) FROM clockgrove.world_offers o
             WHERE o.tenant_id = t AND o.world_id = w AND o.timeline_id = tl
               AND o.space_id = s) >= 100 THEN
      RAISE EXCEPTION 'world offer limit' USING ERRCODE = '54000';
    END IF;
    INSERT INTO clockgrove.world_offers AS x (tenant_id, world_id, timeline_id, space_id,
      offer_id, actor_id, title, body, checkout_url, withdrawn, principal_id, updated_at)
    VALUES (t, w, tl, s, oid, actor, ttl, txt, url, false, clockgrove.runtime_principal_id(),
      statement_timestamp())
    ON CONFLICT (tenant_id, world_id, timeline_id, space_id, offer_id)
    DO UPDATE SET actor_id = EXCLUDED.actor_id, title = EXCLUDED.title, body = EXCLUDED.body,
      checkout_url = EXCLUDED.checkout_url, withdrawn = false,
      principal_id = EXCLUDED.principal_id, updated_at = EXCLUDED.updated_at;
  END IF;
  RETURN QUERY SELECT * FROM clockgrove.space_offers(t, w, tl, s);
END $$;
REVOKE ALL ON FUNCTION clockgrove.set_world_offer(text, text, text, text, text, text, text, text,
  text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.set_world_offer(text, text, text, text, text, text, text,
  text, text, boolean) TO clockgrove_runtime;

-- The caller's own live session in the world and timeline, as its participant with the
-- `conversation` category; refuses anything else.
CREATE FUNCTION clockgrove.offer_session(t text, w text, tl text, sess text)
RETURNS clockgrove.conversation_sessions
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
DECLARE c clockgrove.conversation_sessions%ROWTYPE;
BEGIN
  SELECT * INTO c FROM clockgrove.conversation_sessions x
   WHERE x.tenant_id = t AND x.session_id = sess AND x.world_id = w AND x.timeline_id = tl
     AND x.state <> 'deleted';
  IF NOT FOUND OR NOT clockgrove.runtime_can_access(t, 'conversation')
     OR NOT clockgrove.runtime_conversation_participant(t, sess) THEN
    RAISE EXCEPTION 'offer refused' USING ERRCODE = '42501';
  END IF;
  RETURN c;
END $$;
REVOKE ALL ON FUNCTION clockgrove.offer_session(text, text, text, text) FROM PUBLIC;

-- An offer event's ID: its category and SHA-256 hex of `[sessionId, offerId]`.
CREATE FUNCTION clockgrove.offer_event_id(kind text, sess text, oid text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, clockgrove AS $$
  SELECT kind || ':' || encode(sha256(convert_to(jsonb_build_array(sess, oid)::text, 'UTF8')),
    'hex')
$$;
REVOKE ALL ON FUNCTION clockgrove.offer_event_id(text, text, text) FROM PUBLIC;

-- The offers the session's actor presents in its space, shown to the session's participant: each
-- is recorded as shown in that session once (its `offer_shown` event); showing them again records
-- nothing new. No world mode refuses it: it spends nothing.
CREATE FUNCTION clockgrove.show_offers(t text, w text, tl text, sess text)
RETURNS TABLE (offer_id text, actor_id text, title text, body text, checkout_url text,
  chosen boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
#variable_conflict use_column
DECLARE c clockgrove.conversation_sessions%ROWTYPE;
BEGIN
  c := clockgrove.offer_session(t, w, tl, sess);
  INSERT INTO clockgrove.offer_presentations (tenant_id, session_id, offer_id, world_id,
    timeline_id, space_id, principal_id, persona_id, actor_id)
  SELECT t, sess, o.offer_id, w, tl, c.space_id, clockgrove.runtime_principal_id(),
    (SELECT p.persona_id FROM clockgrove.conversation_participants p
      WHERE p.tenant_id = t AND p.session_id = sess
        AND p.principal_id = clockgrove.runtime_principal_id()
      ORDER BY p.persona_id LIMIT 1),
    c.actor_id
    FROM clockgrove.space_offers(t, w, tl, c.space_id) o
   WHERE o.actor_id = c.actor_id
  ON CONFLICT (tenant_id, session_id, offer_id) DO NOTHING;
  RETURN QUERY
    SELECT o.offer_id, o.actor_id, o.title, o.body, o.checkout_url, p.chosen_at IS NOT NULL
      FROM clockgrove.space_offers(t, w, tl, c.space_id) o
      JOIN clockgrove.offer_presentations p
        ON p.tenant_id = t AND p.session_id = sess AND p.offer_id = o.offer_id
     WHERE o.actor_id = c.actor_id
     ORDER BY o.offer_id;
END $$;
REVOKE ALL ON FUNCTION clockgrove.show_offers(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.show_offers(text, text, text, text) TO clockgrove_runtime;

-- The participant chooses an offer shown in this session and not withdrawn since: recorded once
-- (its `offer_chosen` event). Answers the offer and that event's ID, or no row when it cannot be
-- chosen.
CREATE FUNCTION clockgrove.choose_offer(t text, w text, tl text, sess text, oid text)
RETURNS TABLE (offer_id text, actor_id text, title text, body text, checkout_url text,
  chosen boolean, event_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
#variable_conflict use_column
DECLARE c clockgrove.conversation_sessions%ROWTYPE;
BEGIN
  c := clockgrove.offer_session(t, w, tl, sess);
  UPDATE clockgrove.offer_presentations p SET chosen_at = statement_timestamp()
   WHERE p.tenant_id = t AND p.session_id = sess AND p.offer_id = oid AND p.chosen_at IS NULL
     AND EXISTS (SELECT 1 FROM clockgrove.space_offers(t, w, tl, c.space_id) o
                  WHERE o.offer_id = oid AND o.actor_id = c.actor_id);
  RETURN QUERY
    SELECT o.offer_id, o.actor_id, o.title, o.body, o.checkout_url, true,
      clockgrove.offer_event_id('offer_chosen', sess, o.offer_id)
      FROM clockgrove.space_offers(t, w, tl, c.space_id) o
      JOIN clockgrove.offer_presentations p
        ON p.tenant_id = t AND p.session_id = sess AND p.offer_id = o.offer_id
     WHERE o.offer_id = oid AND o.actor_id = c.actor_id AND p.chosen_at IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION clockgrove.choose_offer(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.choose_offer(text, text, text, text, text)
  TO clockgrove_runtime;

-- One usage event when an offer is shown in a session and one when it is chosen there, written at
-- commit from the presentation row. Its id is the kind and SHA-256 hex of `[sessionId, offerId]`;
-- the resource is the offer, the quantity one offer.
CREATE FUNCTION clockgrove.record_offer_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
DECLARE kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    kind := 'offer_shown';
  ELSIF OLD.chosen_at IS NULL AND NEW.chosen_at IS NOT NULL THEN
    kind := 'offer_chosen';
  ELSE
    RETURN NULL;
  END IF;
  PERFORM clockgrove.usage_feed_lock(NEW.tenant_id, NEW.world_id, NEW.timeline_id);
  INSERT INTO clockgrove.usage_events (
    tenant_id, event_id, world_id, timeline_id, space_id, category, source, resource, status,
    principal_id, persona_id, actor_id, session_id, quantities, occurred_at, world_time
  ) VALUES (
    NEW.tenant_id,
    clockgrove.offer_event_id(kind, NEW.session_id, NEW.offer_id),
    NEW.world_id, NEW.timeline_id, NEW.space_id, kind, 'offer_presentation', NEW.offer_id,
    CASE kind WHEN 'offer_shown' THEN 'shown' ELSE 'chosen' END, NEW.principal_id,
    NEW.persona_id, NEW.actor_id, NEW.session_id, jsonb_build_object('offers', 1),
    CASE kind WHEN 'offer_shown' THEN NEW.shown_at ELSE NEW.chosen_at END,
    clockgrove.usage_world_time(NEW.tenant_id, NEW.world_id, NEW.timeline_id, NEW.space_id)
  ) ON CONFLICT (tenant_id, event_id) DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.record_offer_usage() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER offer_presentations_usage
  AFTER INSERT OR UPDATE OF chosen_at ON clockgrove.offer_presentations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION clockgrove.record_offer_usage();

-- Each change of an offer is audited as its own subject, the entry the offer's ID.
ALTER TABLE clockgrove.inspector_accesses
  DROP CONSTRAINT inspector_accesses_subject_check,
  DROP CONSTRAINT inspector_accesses_subject_entry,
  ADD CONSTRAINT inspector_accesses_subject_check CHECK (
    subject IN (
      'causal-chain', 'runtime-state', 'event', 'scheduled-action', 'client-view', 'agent-runs',
      'context-manifest', 'actor-documents', 'usage-events', 'actor-mute', 'journal',
      'usage-webhook', 'usage-budget', 'usage-admission-hook', 'world-mode', 'world-offer'
    )
  ),
  ADD CONSTRAINT inspector_accesses_subject_entry
    CHECK ((subject IN ('event', 'scheduled-action', 'usage-webhook', 'usage-budget',
      'usage-admission-hook', 'world-mode', 'world-offer')) = (entry_id IS NOT NULL));
