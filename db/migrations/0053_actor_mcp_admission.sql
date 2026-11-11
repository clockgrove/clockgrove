-- A runtime actor reads admission policy through its current conversation participant only.
-- The snapshot deliberately excludes endpoint, owner and credential references. Operator RLS
-- remains unchanged; this read port grants no installation or binding mutation authority.
CREATE FUNCTION clockgrove.actor_mcp_admission(t text,w text,tl text,a text,sid text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
DECLARE s text; result jsonb;
BEGIN
 SELECT session.space_id INTO s FROM clockgrove.conversation_sessions session
 JOIN clockgrove.conversation_participants participant USING(tenant_id,session_id)
 JOIN clockgrove.world_memberships membership ON membership.tenant_id=session.tenant_id
   AND membership.world_id=session.world_id AND membership.timeline_id=session.timeline_id
   AND membership.space_id=session.space_id AND membership.principal_id=participant.principal_id
   AND membership.persona_id=participant.persona_id
 WHERE session.tenant_id=t AND session.world_id=w AND session.timeline_id=tl
   AND session.actor_id=a AND session.session_id=sid AND session.state='active'
   AND participant.principal_id=clockgrove.runtime_principal_id()
   AND membership.revoked_at IS NULL AND membership.committed_at<=statement_timestamp()
   AND membership.privacy_ceiling->'allowedCategories' ? 'conversation'
   AND clockgrove.runtime_can_access(t,'conversation');
 IF s IS NULL THEN RAISE EXCEPTION 'MCP actor context unavailable' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object(
   'revision',(SELECT coalesce(sum(revision),0)::text FROM clockgrove.mcp_installations
      WHERE tenant_id=t AND world_id=w AND timeline_id=tl),
   'installations',coalesce(jsonb_agg(jsonb_build_object(
      'tenantId',i.tenant_id,'worldId',i.world_id,'timelineId',i.timeline_id,
      'installationId',i.installation_id,'status',i.status,'snapshot',i.snapshot,
      'reviews',i.reviews,'drifted',i.drifted) ORDER BY i.installation_id),'[]'::jsonb),
   'bindings',coalesce((SELECT jsonb_agg(b.binding||jsonb_build_object(
      'tenantId',b.tenant_id,'worldId',b.world_id,'timelineId',b.timeline_id)
      ORDER BY b.installation_id,b.binding_id)
      FROM clockgrove.mcp_bindings b WHERE b.tenant_id=t AND b.world_id=w
      AND b.timeline_id=tl AND
      ((b.binding->>'scopeType'='tenant' AND b.binding->>'scopeId'=t) OR
       (b.binding->>'scopeType'='world' AND b.binding->>'scopeId'=w) OR
       (b.binding->>'scopeType'='timeline' AND b.binding->>'scopeId'=tl) OR
       (b.binding->>'scopeType'='actor' AND b.binding->>'scopeId'=a) OR
       (b.binding->>'scopeType'='session' AND b.binding->>'scopeId'=sid))),'[]'::jsonb))
 INTO result FROM clockgrove.mcp_installations i
 WHERE i.tenant_id=t AND i.world_id=w AND i.timeline_id=tl;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION clockgrove.actor_mcp_admission(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.actor_mcp_admission(text,text,text,text,text) TO clockgrove_runtime;

-- Operator changes announce only a revision and affected actor addresses, never conversation data.
CREATE FUNCTION clockgrove.mcp_actor_revision_targets(t text,w text,tl text,s text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
BEGIN
 IF clockgrove.mcp_install_authorized(t,w,tl,s) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'MCP installation authority required' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object(
   'revision',(SELECT coalesce(sum(revision),0)::text FROM clockgrove.mcp_installations
      WHERE tenant_id=t AND world_id=w AND timeline_id=tl),
   'actorIds',(SELECT coalesce(jsonb_agg(actor_id ORDER BY actor_id),'[]'::jsonb)
      FROM (SELECT DISTINCT actor_id FROM clockgrove.conversation_sessions
        WHERE tenant_id=t AND world_id=w AND timeline_id=tl
          AND state='active') actors));
END $$;
REVOKE ALL ON FUNCTION clockgrove.mcp_actor_revision_targets(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.mcp_actor_revision_targets(text,text,text,text) TO clockgrove_runtime;
