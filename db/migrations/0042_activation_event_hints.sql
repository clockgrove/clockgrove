-- Issue 91: a committed event wakes the actors whose enabled subscription or threshold names its
-- type (Wave 5 §5.2), instead of their next quiet poll. Policies are private to the configuring
-- participant, so the committing world's system principal reads only those actors' routes, never
-- a policy. The actor's owner then reads the journal under its own participant.
CREATE FUNCTION clockgrove.activation_event_subscribers(t text, w text, tl text, event_types text[])
RETURNS TABLE (actor_id text, space_id text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
  SELECT p.actor_id, p.space_id FROM clockgrove.actor_activation_policies p
  WHERE clockgrove.has_runtime_context(t) AND clockgrove.runtime_principal_id() = 'system:world:' || w
    AND p.tenant_id=t AND p.world_id=w AND p.timeline_id=tl
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.configurations) c
      WHERE c->>'enabled'='true' AND c->>'kind' IN ('subscription','threshold')
        AND c->>'eventType' = ANY(event_types))
  ORDER BY p.actor_id
$$;
REVOKE ALL ON FUNCTION clockgrove.activation_event_subscribers(text,text,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.activation_event_subscribers(text,text,text,text[]) TO clockgrove_runtime;
