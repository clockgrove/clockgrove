-- Preview timelines cannot record external effects (Wave 2 plan §17). Until effect intents exist
-- (deferred to Wave 5), an external effect is an `external-effects` dispatch row, so the gate sits on
-- clockgrove.event_dispatches: a row on that channel is refused unless its timeline is `live`.
-- Additive: one trigger and its function; no table, grant or row changes.

-- Runs as the inserting role, so the timeline lookup is under that role's RLS. A timeline the role
-- cannot see is not proven live and is refused (fail closed). The error aborts the command's whole
-- transaction, so nothing of it is written.
CREATE FUNCTION clockgrove.guard_preview_effect_dispatch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel = 'external-effects' AND NOT EXISTS (
    SELECT 1 FROM clockgrove.timelines AS timeline
     WHERE timeline.tenant_id = NEW.tenant_id
       AND timeline.world_id = NEW.world_id
       AND timeline.timeline_id = NEW.timeline_id
       AND timeline.kind = 'live'
  ) THEN
    RAISE EXCEPTION 'external effects are recorded only on live timelines' USING ERRCODE = 'CG012';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_dispatches_preview_effect_policy
  BEFORE INSERT ON clockgrove.event_dispatches
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_preview_effect_dispatch();

REVOKE ALL ON FUNCTION clockgrove.guard_preview_effect_dispatch() FROM PUBLIC;
