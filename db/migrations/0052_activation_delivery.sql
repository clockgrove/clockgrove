-- Snapshot intent with the admitted turn; later configuration edits cannot redirect recovery.
ALTER TABLE clockgrove.actor_activations ADD COLUMN delivery_intent jsonb
  CHECK (delivery_intent IS NULL OR (
    jsonb_typeof(delivery_intent)='object'
    AND delivery_intent ?& ARRAY['urgency','quietHoursBehavior']
    AND delivery_intent - ARRAY['urgency','quietHoursBehavior'] = '{}'::jsonb
    AND delivery_intent->>'urgency' IN ('normal','urgent')
    AND delivery_intent->>'quietHoursBehavior' IN ('delay','silent','reject')) IS TRUE);
CREATE FUNCTION clockgrove.guard_activation_delivery_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,clockgrove AS $$
BEGIN
  IF NEW.delivery_intent IS DISTINCT FROM OLD.delivery_intent THEN
    RAISE EXCEPTION 'activation delivery intent is immutable';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_activation_delivery_intent() FROM PUBLIC;
CREATE TRIGGER actor_activation_delivery_immutable BEFORE UPDATE ON clockgrove.actor_activations
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_activation_delivery_intent();

-- The runtime cannot read membership rows directly. Keep revocation serialized until dispatch
-- commits, without granting it membership mutation or direct authority-table access.
CREATE FUNCTION clockgrove.lock_activation_delivery_authority(t text,w text,tl text,s text,p text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
BEGIN
  IF (clockgrove.runtime_can_access(t,'conversation') AND p=clockgrove.runtime_principal_id()) IS NOT TRUE THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM clockgrove.world_memberships m
    WHERE m.tenant_id=t AND m.world_id=w AND m.timeline_id=tl AND m.space_id=s AND m.principal_id=p
      AND m.revoked_at IS NULL AND 'runtime:world-command'=ANY(m.grants)
      AND m.privacy_ceiling->'allowedCategories' ? 'conversation' FOR SHARE;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION clockgrove.lock_activation_delivery_authority(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.lock_activation_delivery_authority(text,text,text,text,text) TO clockgrove_runtime;
