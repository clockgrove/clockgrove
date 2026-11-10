-- Decision: identifiers and policy list sizes reuse the installation's 256-candidate bound.
-- Binding rows are bounded to 128 KiB, matching the installation review map, to bound Journal
-- policy input. Each operator-supplied counter is an exact nonnegative JavaScript safe integer.
CREATE TABLE clockgrove.mcp_bindings (
 tenant_id text NOT NULL,
 world_id text NOT NULL,
 timeline_id text NOT NULL,
 installation_id text NOT NULL,
 binding_id text NOT NULL CHECK(octet_length(binding_id) BETWEEN 1 AND 256),
 space_id text NOT NULL,
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object' AND octet_length(binding::text)<=131072),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(tenant_id,world_id,timeline_id,installation_id,binding_id),
 FOREIGN KEY(tenant_id,world_id,timeline_id,installation_id)
   REFERENCES clockgrove.mcp_installations(tenant_id,world_id,timeline_id,installation_id)
);
ALTER TABLE clockgrove.mcp_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.mcp_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY binding_operator ON clockgrove.mcp_bindings FOR SELECT
 USING(clockgrove.mcp_install_authorized(tenant_id,world_id,timeline_id,space_id));
REVOKE ALL ON clockgrove.mcp_bindings FROM PUBLIC,clockgrove_runtime;
GRANT SELECT ON clockgrove.mcp_bindings TO clockgrove_runtime;
CREATE TRIGGER mcp_bindings_no_delete BEFORE DELETE OR TRUNCATE ON clockgrove.mcp_bindings
 FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

CREATE FUNCTION clockgrove.change_mcp_binding(command_bytes bytea,request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
DECLARE
 t text := request#>>'{target,tenantId}';
 w text := request#>>'{target,worldId}';
 tl text := request#>>'{target,timelineId}';
 s text := request#>>'{route,spaceId}';
 p text := clockgrove.runtime_principal_id();
 op jsonb := (request#>>'{events,0,payload,operationJson}')::jsonb;
 id text := op->>'installationId';
 binding_key text := op->>'bindingId';
 constraints jsonb := op->'constraints';
 prior clockgrove.mcp_installations%ROWTYPE;
 result jsonb;
 raw_command jsonb := convert_from(command_bytes,'UTF8')::jsonb;
 auth jsonb;
BEGIN
 IF clockgrove.mcp_install_authorized(t,w,tl,s) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'MCP installation authority required' USING ERRCODE='42501';
 END IF;
 auth:=clockgrove.mcp_install_authority(t,w,tl,s,request#>>'{route,partitionId}');
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(request) key WHERE key NOT IN ('commandId','target','expected','attribution','correlationId','authorityDecision','route','events','dispatches','stableResult','projectionDelta'))
   OR raw_command->>'type' IS DISTINCT FROM 'McpBindingChange'
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
   OR jsonb_array_length(request->'events')<>1 OR request#>>'{events,0,type}' IS DISTINCT FROM 'McpBindingChanged'
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
   OR id IS NULL OR binding_key IS NULL THEN
   RAISE EXCEPTION 'Invalid MCP governance request' USING ERRCODE='22023';
 END IF;
 -- This lock also serializes installation review, refresh and revoke against binding commits.
 PERFORM pg_advisory_xact_lock(hashtextextended(t||'/'||w||'/'||tl||'/mcp',0));
 IF EXISTS (SELECT 1 FROM clockgrove.command_receipts WHERE tenant_id=t AND command_id=request->>'commandId') THEN
   RETURN clockgrove.execute_journal(command_bytes,request,NULL);
 END IF;
 IF jsonb_typeof(op) IS DISTINCT FROM 'object' OR octet_length(op::text)>131072
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(op) k WHERE k NOT IN
     ('bindingId','installationId','candidateId','schemaHash','protocolVersion','scopeType','scopeId','effect','enabled','constraints'))
   OR jsonb_typeof(op->'enabled') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(constraints) IS DISTINCT FROM 'object'
   OR op->>'scopeType' IS NULL OR op->>'scopeType' NOT IN ('tenant','world','timeline','actor','session')
   OR op->>'effect' IS NULL OR op->>'effect' NOT IN ('allow','deny')
   OR op->>'schemaHash' IS NULL OR op->>'schemaHash' !~ '^[a-f0-9]{64}$'
   OR EXISTS(SELECT 1 FROM (VALUES('bindingId'),('installationId'),('candidateId'),('protocolVersion'),('scopeId')) fields(k)
      WHERE jsonb_typeof(op->k) IS DISTINCT FROM 'string' OR octet_length(op->>k) NOT BETWEEN 1 AND 256)
   OR (op->>'scopeType'='tenant' AND op->>'scopeId'<>t)
   OR (op->>'scopeType'='world' AND op->>'scopeId'<>w)
   OR (op->>'scopeType'='timeline' AND op->>'scopeId'<>tl)
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(constraints) k WHERE k NOT IN
     ('inputFields','destinations','callsPerTurn','effectClasses','budgetMicrousd','expiresAt')) THEN
   RAISE EXCEPTION 'Invalid MCP binding policy' USING ERRCODE='22023';
 END IF;
 IF jsonb_typeof(constraints->'callsPerTurn') IS DISTINCT FROM 'number'
   OR (constraints->>'callsPerTurn')::numeric NOT BETWEEN 0 AND 9007199254740991
   OR trunc((constraints->>'callsPerTurn')::numeric)<>(constraints->>'callsPerTurn')::numeric
   OR (constraints ? 'budgetMicrousd' AND
      (jsonb_typeof(constraints->'budgetMicrousd') IS DISTINCT FROM 'number'
       OR (constraints->>'budgetMicrousd')::numeric NOT BETWEEN 0 AND 9007199254740991
       OR trunc((constraints->>'budgetMicrousd')::numeric)<>(constraints->>'budgetMicrousd')::numeric))
   OR jsonb_typeof(constraints->'effectClasses') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Invalid MCP binding limits' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(constraints->'effectClasses') NOT BETWEEN 1 AND 6
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(constraints->'effectClasses') e
     WHERE jsonb_typeof(e) IS DISTINCT FROM 'string' OR e#>>'{}' NOT IN
       ('read','world-write','external-write','destructive','network','cost')) THEN
   RAISE EXCEPTION 'Invalid MCP effect constraints' USING ERRCODE='22023';
 END IF;
 IF constraints ? 'inputFields' THEN
   IF jsonb_typeof(constraints->'inputFields') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'Invalid MCP input constraints' USING ERRCODE='22023';
   END IF;
   IF jsonb_array_length(constraints->'inputFields')>256 OR EXISTS(
     SELECT 1 FROM jsonb_array_elements(constraints->'inputFields') e
      WHERE jsonb_typeof(e) IS DISTINCT FROM 'string' OR octet_length(e#>>'{}') NOT BETWEEN 1 AND 256) THEN
     RAISE EXCEPTION 'Invalid MCP input constraints' USING ERRCODE='22023';
   END IF;
 END IF;
 IF constraints ? 'destinations' THEN
   IF jsonb_typeof(constraints->'destinations') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'Invalid MCP destinations' USING ERRCODE='22023';
   END IF;
   IF jsonb_array_length(constraints->'destinations')>256 OR EXISTS(
     SELECT 1 FROM jsonb_array_elements(constraints->'destinations') e
      WHERE jsonb_typeof(e) IS DISTINCT FROM 'string' OR octet_length(e#>>'{}') NOT BETWEEN 1 AND 4096
        OR e#>>'{}' !~ '^https://' OR e#>>'{}' ~ '[?#@]') THEN
     RAISE EXCEPTION 'Invalid MCP destinations' USING ERRCODE='22023';
   END IF;
 END IF;
 IF constraints ? 'expiresAt' THEN
   IF jsonb_typeof(constraints->'expiresAt') IS DISTINCT FROM 'string'
      OR constraints->>'expiresAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      OR NOT isfinite((constraints->>'expiresAt')::timestamptz) THEN
     RAISE EXCEPTION 'Invalid MCP expiry' USING ERRCODE='22023';
   END IF;
 END IF;
 IF op->'enabled'='true'::jsonb AND op->>'scopeType'='session' AND NOT EXISTS(
   SELECT 1 FROM clockgrove.conversation_sessions session WHERE session.tenant_id=t
     AND session.world_id=w AND session.timeline_id=tl AND session.session_id=op->>'scopeId'
     AND session.state<>'deleted') THEN
   RAISE EXCEPTION 'MCP session scope unavailable' USING ERRCODE='22023';
 END IF;
 SELECT * INTO prior FROM clockgrove.mcp_installations
   WHERE tenant_id=t AND world_id=w AND timeline_id=tl AND installation_id=id FOR UPDATE;
 IF NOT FOUND OR prior.space_id<>s THEN
   RAISE EXCEPTION 'MCP installation unavailable' USING ERRCODE='22023';
 END IF;
 IF op->'enabled'='true'::jsonb THEN
   IF prior.status<>'active' OR op->>'protocolVersion' IS DISTINCT FROM prior.snapshot->>'protocolVersion'
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prior.snapshot->'candidates') c
        WHERE c->>'kind'='tool' AND c->>'id'=op->>'candidateId' AND c->>'schemaHash'=op->>'schemaHash')
      OR (op->>'effect'='allow' AND (
        prior.reviews#>ARRAY[op->>'candidateId','enabled'] IS DISTINCT FROM 'true'::jsonb
        OR prior.reviews#>>ARRAY[op->>'candidateId','schemaHash'] IS DISTINCT FROM op->>'schemaHash'
        OR prior.reviews#>>ARRAY[op->>'candidateId','protocolVersion'] IS DISTINCT FROM op->>'protocolVersion'
        OR op->>'candidateId'=ANY(prior.drifted)
        OR NOT (constraints->'effectClasses' ? (prior.reviews#>>ARRAY[op->>'candidateId','effectClass'])))) THEN
     RAISE EXCEPTION 'MCP binding requires current reviewed tool pin' USING ERRCODE='22023';
   END IF;
 END IF;
 result:=clockgrove.execute_journal(command_bytes,request,NULL);
 INSERT INTO clockgrove.mcp_bindings(tenant_id,world_id,timeline_id,installation_id,binding_id,space_id,binding)
   VALUES(t,w,tl,id,binding_key,s,op)
   ON CONFLICT(tenant_id,world_id,timeline_id,installation_id,binding_id)
   DO UPDATE SET binding=excluded.binding,revision=clockgrove.mcp_bindings.revision+1;
 UPDATE clockgrove.mcp_installations SET revision=revision+1
   WHERE tenant_id=t AND world_id=w AND timeline_id=tl AND installation_id=id;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.change_mcp_binding(bytea,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.change_mcp_binding(bytea,jsonb) TO clockgrove_runtime;
