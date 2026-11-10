-- Canonical governance only: no remote invocation or HTTP surface is installed here.
-- Decision: identifiers are capped at 256 bytes and endpoints at 4096 bytes to bound row keys
-- and operator input. Reviews fit 128 KiB for the transport's 256 candidates; these are storage
-- engineering limits, not MCP protocol limits.
CREATE TABLE clockgrove.mcp_installations (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  installation_id text NOT NULL CHECK (octet_length(installation_id) BETWEEN 1 AND 256),
  space_id text NOT NULL,
  owner_principal_id text NOT NULL,
  url text NOT NULL CHECK (octet_length(url) BETWEEN 1 AND 4096),
  status text NOT NULL CHECK (status IN ('active','disabled','revoked')),
  snapshot jsonb NOT NULL,
  reviews jsonb NOT NULL DEFAULT '{}',
  drifted text[] NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (tenant_id,world_id,timeline_id,installation_id),
  FOREIGN KEY (tenant_id,world_id,timeline_id) REFERENCES clockgrove.timelines(tenant_id,world_id,timeline_id),
  FOREIGN KEY (tenant_id,owner_principal_id) REFERENCES clockgrove.tenant_principals(tenant_id,principal_id),
  -- Decision: the discovery transport permits 256 bounded candidates. 8 MiB also bounds metadata
  -- repeated in canonical evidence, independently of JavaScript composition.
  CHECK (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=8388608),
  CHECK (jsonb_typeof(reviews)='object' AND octet_length(reviews::text)<=131072)
);

-- Canonical membership, not a caller's claimed grants. Owners receive this separate authority
-- by default; other members require the explicit grant. System/actor identities never qualify.
CREATE FUNCTION clockgrove.mcp_install_authorized(t text,w text,tl text,s text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
 SELECT clockgrove.runtime_can_access(t,'operator_evidence')
   AND EXISTS (SELECT 1 FROM clockgrove.world_memberships m
     JOIN clockgrove.worlds world USING(tenant_id,world_id)
     WHERE m.tenant_id=t AND m.world_id=w AND m.timeline_id=tl AND m.space_id=s
       AND m.principal_id=clockgrove.runtime_principal_id()
       AND m.principal_id NOT LIKE 'system:%' AND NOT ('actor'=ANY(m.roles))
       AND m.revoked_at IS NULL AND m.committed_at<=statement_timestamp()
       AND m.privacy_ceiling->'allowedCategories' ? 'operator_evidence'
       AND world.lifecycle_status='ready'
       AND ('runtime:mcp-install'=ANY(m.grants) OR 'owner'=ANY(m.roles)))
$$;
REVOKE ALL ON FUNCTION clockgrove.mcp_install_authorized(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.mcp_install_authorized(text,text,text,text) TO clockgrove_runtime;
CREATE FUNCTION clockgrove.mcp_install_authority(t text,w text,tl text,s text,part text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
 SELECT jsonb_build_object('membershipId',m.membership_id,'personaId',m.persona_id,
   'roles',m.roles,'grants',CASE WHEN 'owner'=ANY(m.roles) AND NOT ('runtime:mcp-install'=ANY(m.grants))
      THEN array_append(m.grants,'runtime:mcp-install') ELSE m.grants END,
   'simulationTime',coalesce(state.simulation_time,0)::text)
 FROM clockgrove.world_memberships m
 LEFT JOIN clockgrove.partition_states state ON state.tenant_id=t AND state.world_id=w
   AND state.timeline_id=tl AND state.partition_id=part AND state.space_id=s
 WHERE clockgrove.mcp_install_authorized(t,w,tl,s) AND m.tenant_id=t AND m.world_id=w
   AND m.timeline_id=tl AND m.space_id=s AND m.principal_id=clockgrove.runtime_principal_id()
$$;
REVOKE ALL ON FUNCTION clockgrove.mcp_install_authority(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.mcp_install_authority(text,text,text,text,text) TO clockgrove_runtime;
ALTER TABLE clockgrove.mcp_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.mcp_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY installation_operator ON clockgrove.mcp_installations FOR SELECT
 USING (clockgrove.mcp_install_authorized(tenant_id,world_id,timeline_id,space_id));
REVOKE ALL ON clockgrove.mcp_installations FROM PUBLIC,clockgrove_runtime;
GRANT SELECT ON clockgrove.mcp_installations TO clockgrove_runtime;
CREATE TRIGGER mcp_installations_no_delete BEFORE DELETE OR TRUNCATE ON clockgrove.mcp_installations
 FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- Only this function mutates governance, in the same transaction as execute_journal. Callers
-- cannot alter a row directly, omit its event, or retry a command with different operation bytes.
CREATE FUNCTION clockgrove.change_mcp_installation(command_bytes bytea,request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
DECLARE
 t text := request#>>'{target,tenantId}';
 w text := request#>>'{target,worldId}';
 tl text := request#>>'{target,timelineId}';
 s text := request#>>'{route,spaceId}';
 p text := clockgrove.runtime_principal_id();
 op jsonb := (request#>>'{events,0,payload,operationJson}')::jsonb;
 action text := op->>'action';
 id text := op->>'installationId';
 prior clockgrove.mcp_installations%ROWTYPE;
 snap jsonb;
 candidate jsonb;
 kept jsonb := '{}';
 drift text[] := '{}';
 result jsonb;
 raw_command jsonb := convert_from(command_bytes,'UTF8')::jsonb;
 auth jsonb;
BEGIN
 IF clockgrove.mcp_install_authorized(t,w,tl,s) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'MCP installation authority required' USING ERRCODE='42501';
 END IF;
 auth:=clockgrove.mcp_install_authority(t,w,tl,s,request#>>'{route,partitionId}');
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(request) key WHERE key NOT IN ('commandId','target','expected','attribution','correlationId','authorityDecision','route','events','dispatches','stableResult','projectionDelta'))
   OR raw_command->>'type' IS DISTINCT FROM 'McpInstallationChange'
   OR raw_command->'payload' IS DISTINCT FROM request#>'{events,0,payload}'
   OR request#>>'{target,kind}' IS DISTINCT FROM 'world'
   OR request#>>'{target,id}' IS DISTINCT FROM w
   OR request#>>'{attribution,effectiveActorId}' IS DISTINCT FROM auth->>'personaId'
   OR request#>>'{attribution,initiatorId}' IS DISTINCT FROM p
   OR request#>>'{authorityDecision,inputs,personaId}' IS DISTINCT FROM auth->>'personaId'
   OR request#>>'{authorityDecision,inputs,worldMembershipId}' IS DISTINCT FROM auth->>'membershipId'
   OR raw_command->>'commandId' IS DISTINCT FROM request->>'commandId'
   OR raw_command->'target' IS DISTINCT FROM request->'target'
   OR raw_command->'attribution' IS DISTINCT FROM request->'attribution'
   OR raw_command->'expected' IS DISTINCT FROM '{}'::jsonb
   OR request->'expected' IS DISTINCT FROM '{}'::jsonb
   OR request->'projectionDelta' IS DISTINCT FROM 'null'::jsonb
   OR request#>'{authorityDecision,inputs,roles}' IS DISTINCT FROM auth->'roles'
   OR request#>'{authorityDecision,inputs,grants}' IS DISTINCT FROM auth->'grants'
   OR request#>>'{events,0,spaceId}' IS DISTINCT FROM s
   OR request#>>'{events,0,partitionId}' IS DISTINCT FROM request#>>'{route,partitionId}'
   OR request#>>'{events,0,streamId}' IS DISTINCT FROM request#>>'{route,streamId}'
   OR request#>>'{events,0,simulationTime}' IS DISTINCT FROM auth->>'simulationTime'
   OR request#>'{events,0,attribution}' IS DISTINCT FROM (request->'attribution'||jsonb_build_object('authorityDecisionId',request#>>'{authorityDecision,authorityDecisionId}'))
   OR jsonb_array_length(request->'events')<>1 OR request#>>'{events,0,type}' IS DISTINCT FROM 'McpInstallationChanged'
   OR request#>>'{events,0,privacyClass}' IS DISTINCT FROM 'operator_evidence'
   OR request#>>'{events,0,principalId}' IS DISTINCT FROM p
   OR request#>>'{attribution,principalId}' IS DISTINCT FROM p
   OR request#>>'{events,0,attribution,principalId}' IS DISTINCT FROM p
   OR request#>>'{attribution,personaId}' IS DISTINCT FROM
      clockgrove.mcp_install_authority(t,w,tl,s,request#>>'{route,partitionId}')->>'personaId'
   OR request#>>'{attribution,worldMembershipId}' IS DISTINCT FROM
      clockgrove.mcp_install_authority(t,w,tl,s,request#>>'{route,partitionId}')->>'membershipId'
   OR request#>>'{authorityDecision,inputs,principalId}' IS DISTINCT FROM p
   OR request#>>'{authorityDecision,outcome}' IS DISTINCT FROM 'allow'
   OR request->'dispatches' IS DISTINCT FROM '[]'::jsonb
   OR action IS NULL OR action NOT IN ('install','refresh','review','disable','revoke')
   OR id IS NULL THEN
   RAISE EXCEPTION 'Invalid MCP governance request' USING ERRCODE='22023';
 END IF;
 -- Scope-wide serialization also orders idempotent retries before the mutable row is read.
 PERFORM pg_advisory_xact_lock(hashtextextended(t||'/'||w||'/'||tl||'/mcp',0));
 IF EXISTS (SELECT 1 FROM clockgrove.command_receipts WHERE tenant_id=t AND command_id=request->>'commandId') THEN
   RETURN clockgrove.execute_journal(command_bytes,request,NULL);
 END IF;
 SELECT * INTO prior FROM clockgrove.mcp_installations
   WHERE tenant_id=t AND world_id=w AND timeline_id=tl AND installation_id=id FOR UPDATE;
 IF action='install' THEN
   IF FOUND THEN RAISE EXCEPTION 'MCP installation already exists' USING ERRCODE='23505'; END IF;
   IF op->>'url' IS NULL OR op->>'url' !~ '^https://' OR op->>'url' ~ '[?#@]' THEN
     RAISE EXCEPTION 'MCP URL must be credential-free HTTPS' USING ERRCODE='22023';
   END IF;
 ELSIF NOT FOUND OR prior.space_id<>s THEN
   RAISE EXCEPTION 'MCP installation unavailable' USING ERRCODE='22023';
 ELSIF prior.status='revoked' THEN
   RAISE EXCEPTION 'MCP installation revoked' USING ERRCODE='22023';
 END IF;
 IF action IN ('install','refresh') THEN
   snap:=op->'snapshot';
   IF jsonb_typeof(snap->'candidates') IS DISTINCT FROM 'array'
     OR jsonb_array_length(snap->'candidates')>256
     OR jsonb_typeof(snap->'protocolVersion') IS DISTINCT FROM 'string'
     OR jsonb_typeof(snap->'serverIdentity') IS DISTINCT FROM 'object'
     OR jsonb_typeof(snap->'protocolMetadata') IS DISTINCT FROM 'object' THEN
     RAISE EXCEPTION 'Invalid MCP discovery' USING ERRCODE='22023';
   END IF;
   IF (SELECT count(*) FROM jsonb_array_elements(snap->'candidates')) <>
      (SELECT count(DISTINCT (c->>'kind',c->>'id')) FROM jsonb_array_elements(snap->'candidates') c) THEN
     RAISE EXCEPTION 'Duplicate MCP candidate' USING ERRCODE='22023';
   END IF;
   FOR candidate IN SELECT value FROM jsonb_array_elements(snap->'candidates') LOOP
     IF candidate->>'kind' IS NULL OR candidate->>'schemaHash' IS NULL OR candidate->>'kind' NOT IN ('tool','resource','prompt') OR candidate->>'id' IS NULL
       OR candidate->>'schemaHash' !~ '^[a-f0-9]{64}$'
       OR candidate->'enabled' IS DISTINCT FROM 'false'::jsonb
       OR candidate->>'effectClass' IS DISTINCT FROM 'external-write'
       OR jsonb_typeof(candidate->'schema') IS DISTINCT FROM 'object' THEN
       RAISE EXCEPTION 'Invalid MCP candidate' USING ERRCODE='22023';
     END IF;
     IF action='refresh' AND candidate->>'kind'='tool' AND (candidate->>'id'=ANY(prior.drifted)
       OR snap->>'protocolVersion' IS DISTINCT FROM prior.snapshot->>'protocolVersion'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(prior.snapshot->'candidates') old WHERE old->>'kind'='tool'
         AND old->>'id'=candidate->>'id' AND (old->>'schemaHash' IS DISTINCT FROM candidate->>'schemaHash'
           OR old->'schema' IS DISTINCT FROM candidate->'schema'))) THEN
       drift:=array_append(drift,candidate->>'id');
     END IF;
     IF action='refresh' AND snap->>'protocolVersion'=prior.snapshot->>'protocolVersion'
        AND candidate->>'kind'='tool'
        AND prior.reviews#>>ARRAY[candidate->>'id','schemaHash']=candidate->>'schemaHash'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(prior.snapshot->'candidates') old
          WHERE old->>'kind'='tool' AND old->>'id'=candidate->>'id' AND old->'schema'=candidate->'schema') THEN
       kept:=kept||jsonb_build_object(candidate->>'id',prior.reviews->(candidate->>'id'));
     END IF;
   END LOOP;
 ELSIF action='review' THEN
   IF op->>'effectClass' IS NULL OR op->>'effectClass' NOT IN ('read','world-write','external-write','destructive','network','cost')
      OR jsonb_typeof(op->'enabled') IS DISTINCT FROM 'boolean'
      OR op->>'protocolVersion' IS DISTINCT FROM prior.snapshot->>'protocolVersion'
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(prior.snapshot->'candidates') c
        WHERE c->>'kind'='tool' AND c->>'id'=op->>'candidateId' AND c->>'schemaHash'=op->>'schemaHash') THEN
     RAISE EXCEPTION 'MCP review must match current tool pin' USING ERRCODE='22023';
   END IF;
 END IF;
 result:=clockgrove.execute_journal(command_bytes,request,NULL);
 IF action='install' THEN
   INSERT INTO clockgrove.mcp_installations(tenant_id,world_id,timeline_id,installation_id,space_id,owner_principal_id,url,status,snapshot)
     VALUES(t,w,tl,id,s,p,op->>'url','active',snap);
 ELSIF action='refresh' THEN
   UPDATE clockgrove.mcp_installations SET snapshot=snap,reviews=kept,drifted=drift,revision=revision+1
     WHERE tenant_id=t AND world_id=w AND timeline_id=tl AND installation_id=id;
 ELSIF action='review' THEN
   UPDATE clockgrove.mcp_installations SET reviews=reviews||jsonb_build_object(op->>'candidateId',
     jsonb_build_object('schemaHash',op->>'schemaHash','protocolVersion',op->>'protocolVersion',
       'effectClass',op->>'effectClass','enabled',op->'enabled','reviewer',p)),
       drifted=array_remove(drifted,op->>'candidateId'),revision=revision+1
     WHERE tenant_id=t AND world_id=w AND timeline_id=tl AND installation_id=id;
 ELSE
   UPDATE clockgrove.mcp_installations SET status=CASE WHEN action='revoke' THEN 'revoked' ELSE 'disabled' END,
     reviews='{}',revision=revision+1 WHERE tenant_id=t AND world_id=w AND timeline_id=tl AND installation_id=id;
 END IF;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.change_mcp_installation(bytea,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.change_mcp_installation(bytea,jsonb) TO clockgrove_runtime;
