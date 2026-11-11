BEGIN;
INSERT INTO clockgrove.timelines(tenant_id,world_id,timeline_id,kind) VALUES
 ('tenant-j-a','world-j-a','effect-preview','branch'),
 ('tenant-j-a','world-j-a','effect-other','live');
INSERT INTO clockgrove.worlds(tenant_id,world_id,lifecycle_status) VALUES ('tenant-j-a','effect-world','ready');
INSERT INTO clockgrove.timelines(tenant_id,world_id,timeline_id) VALUES ('tenant-j-a','effect-world','effect-world-timeline');
INSERT INTO clockgrove.timeline_partitions(tenant_id,world_id,timeline_id,partition_id,space_id) VALUES
 ('tenant-j-a','world-j-a','effect-preview','effect-preview','space-j-a'),
 ('tenant-j-a','world-j-a','effect-other','effect-other','space-j-a'),
 ('tenant-j-a','effect-world','effect-world-timeline','effect-world','space-j-a');
INSERT INTO clockgrove.world_memberships(tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
 VALUES ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-a','effect-owner','effect-persona',ARRAY['owner'],'{}','{"version":1,"allowedCategories":["operator_evidence"]}',statement_timestamp());
INSERT INTO clockgrove.effect_intents(tenant_id,world_id,timeline_id,space_id,effect_id,idempotency_key,actor_id,principal_id,call_id,capability_id,grant_id,policy_version,arguments_hash,reserved_microusd)
 VALUES ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','effect-a','key-a','fixture-actor','principal-j-a','call-a','fixture-read','grant-a','policy-a',repeat('a',64),250000);
INSERT INTO clockgrove.effect_intents SELECT tenant_id,world_id,'effect-other',space_id,effect_id,idempotency_key,actor_id,principal_id,run_id,call_id,capability_id,grant_id,policy_version,arguments_hash,arguments_artifact_id,privacy_class,reserved_microusd,disposition,outcome_code,created_at,ended_at FROM clockgrove.effect_intents WHERE effect_id='effect-a';
INSERT INTO clockgrove.effect_intents SELECT tenant_id,'effect-world','effect-world-timeline',space_id,effect_id,idempotency_key,actor_id,principal_id,run_id,call_id,capability_id,grant_id,policy_version,arguments_hash,arguments_artifact_id,privacy_class,reserved_microusd,disposition,outcome_code,created_at,ended_at FROM clockgrove.effect_intents WHERE timeline_id='timeline-j-a';
INSERT INTO clockgrove.effect_intents SELECT 'tenant-j-b','world-j-b','timeline-j-b','space-j-b',effect_id,idempotency_key,actor_id,'principal-j-b',run_id,call_id,capability_id,grant_id,policy_version,arguments_hash,arguments_artifact_id,privacy_class,reserved_microusd,disposition,outcome_code,created_at,ended_at FROM clockgrove.effect_intents WHERE timeline_id='timeline-j-a';
DO $$ BEGIN
 BEGIN
  INSERT INTO clockgrove.effect_intents SELECT tenant_id,world_id,timeline_id,space_id,'changed-effect',idempotency_key,actor_id,principal_id,run_id,'changed-call',capability_id,grant_id,policy_version,repeat('b',64),arguments_artifact_id,privacy_class,reserved_microusd,disposition,outcome_code,created_at,ended_at FROM clockgrove.effect_intents WHERE timeline_id='timeline-j-a';
  RAISE EXCEPTION 'changed arguments reused idempotency key';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  UPDATE clockgrove.effect_intents SET arguments_hash=repeat('b',64) WHERE timeline_id='timeline-j-a';
  RAISE EXCEPTION 'arguments changed';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  INSERT INTO clockgrove.effect_intents SELECT tenant_id,world_id,'effect-preview',space_id,'preview-pending','preview-key',actor_id,principal_id,run_id,'preview-call',capability_id,grant_id,policy_version,arguments_hash,arguments_artifact_id,privacy_class,reserved_microusd,disposition,outcome_code,created_at,ended_at FROM clockgrove.effect_intents WHERE timeline_id='timeline-j-a';
  RAISE EXCEPTION 'preview intent could execute';
 EXCEPTION WHEN SQLSTATE 'CG012' THEN NULL; END;
END $$;
INSERT INTO clockgrove.effect_intents SELECT tenant_id,world_id,'effect-preview',space_id,'preview-blocked','preview-key',actor_id,principal_id,run_id,'preview-call',capability_id,grant_id,policy_version,arguments_hash,arguments_artifact_id,privacy_class,reserved_microusd,'blocked','preview',created_at,statement_timestamp() FROM clockgrove.effect_intents WHERE timeline_id='timeline-j-a';
UPDATE clockgrove.effect_intents SET disposition='started' WHERE timeline_id='timeline-j-a';
INSERT INTO clockgrove.effect_attempts(tenant_id,world_id,timeline_id,effect_id,attempt_id)
 VALUES ('tenant-j-a','world-j-a','timeline-j-a','effect-a','attempt-a');
DO $$ BEGIN
 BEGIN
  INSERT INTO clockgrove.effect_attempts(tenant_id,world_id,timeline_id,effect_id,attempt_id)
   VALUES ('tenant-j-a','world-j-a','timeline-j-a','effect-a','attempt-b');
  RAISE EXCEPTION 'second attempt allowed';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  INSERT INTO clockgrove.effect_attempts(tenant_id,world_id,timeline_id,effect_id,attempt_id)
   VALUES ('tenant-j-a','world-j-a','effect-preview','preview-blocked','attempt-preview');
  RAISE EXCEPTION 'preview attempt allowed';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  UPDATE clockgrove.effect_intents SET disposition='succeeded',outcome_code='ok',ended_at=statement_timestamp() WHERE timeline_id='timeline-j-a';
  RAISE EXCEPTION 'effect completed without attempt result';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
UPDATE clockgrove.effect_attempts SET disposition='uncertain',outcome_code='connection_lost',ended_at=statement_timestamp();
UPDATE clockgrove.effect_intents SET disposition='uncertain',outcome_code='connection_lost',ended_at=(SELECT ended_at FROM clockgrove.effect_attempts) WHERE timeline_id='timeline-j-a';
DO $$ DECLARE q text; BEGIN
 IF (SELECT count(*) FROM clockgrove.effect_attempts WHERE cost_microusd IS NULL)<>1 THEN RAISE EXCEPTION 'unknown cost lost'; END IF;
 FOREACH q IN ARRAY ARRAY[
  'UPDATE clockgrove.effect_attempts SET disposition=''succeeded'',outcome_code=''ok''',
  'UPDATE clockgrove.effect_intents SET disposition=''pending'',ended_at=NULL,outcome_code=NULL WHERE timeline_id=''timeline-j-a''',
  'DELETE FROM clockgrove.effect_attempts', 'TRUNCATE clockgrove.effect_intents CASCADE'] LOOP
  BEGIN EXECUTE q; RAISE EXCEPTION 'immutable ledger accepted %',q;
  EXCEPTION WHEN invalid_parameter_value OR SQLSTATE 'CG006' THEN NULL; END;
 END LOOP;
END $$;
-- Foreign attempts ensure the attempt policy is exercised against populated scopes.
UPDATE clockgrove.effect_intents SET disposition='started' WHERE disposition='pending';
INSERT INTO clockgrove.effect_attempts(tenant_id,world_id,timeline_id,effect_id,attempt_id)
 SELECT tenant_id,world_id,timeline_id,effect_id,'foreign-attempt' FROM clockgrove.effect_intents WHERE disposition='started';
INSERT INTO clockgrove.artifact_data_keys(tenant_id,world_id,privacy_class,key_version,kek_id,wrapped_key)
 VALUES ('tenant-j-a','world-j-a','conversation',1,'fixture',decode(repeat('01',61),'hex'));
INSERT INTO clockgrove.artifact_references(tenant_id,world_id,timeline_id,partition_id,space_id,artifact_id,content_hash,media_type,inline_content,byte_length,privacy_class,retention_class,encryption,data_key_version)
 VALUES ('tenant-j-a','world-j-a','timeline-j-a','partition-j-a','space-j-a','effect-result','sha256:'||encode(sha256(decode(repeat('01',32),'hex')),'hex'),'application/json',decode(repeat('01',32),'hex'),32,'conversation','durable','aes-256-gcm-v1',1);
DO $$ BEGIN
 BEGIN
  UPDATE clockgrove.effect_attempts SET disposition='succeeded',outcome_code='ok',ended_at=statement_timestamp(),result_artifact_id='effect-result' WHERE timeline_id='effect-other';
  RAISE EXCEPTION 'foreign result artifact accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  INSERT INTO clockgrove.effect_intents SELECT tenant_id,world_id,timeline_id,space_id,'bad-artifact','bad-artifact',actor_id,principal_id,run_id,'bad-artifact',capability_id,grant_id,policy_version,arguments_hash,'artifact-a-private',privacy_class,reserved_microusd,'pending',NULL,created_at,NULL FROM clockgrove.effect_intents WHERE timeline_id='timeline-j-a';
  RAISE EXCEPTION 'foreign arguments artifact accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
INSERT INTO clockgrove.effect_intents SELECT tenant_id,world_id,timeline_id,space_id,'success','success',actor_id,principal_id,run_id,'success',capability_id,grant_id,policy_version,arguments_hash,'effect-result',privacy_class,reserved_microusd,'pending',NULL,created_at,NULL FROM clockgrove.effect_intents WHERE timeline_id='timeline-j-a';
UPDATE clockgrove.effect_intents SET disposition='started' WHERE effect_id='success';
INSERT INTO clockgrove.effect_attempts(tenant_id,world_id,timeline_id,effect_id,attempt_id) VALUES ('tenant-j-a','world-j-a','timeline-j-a','success','success');
DO $$ BEGIN
 BEGIN
  UPDATE clockgrove.effect_attempts SET disposition='succeeded',outcome_code='ok',ended_at=statement_timestamp() WHERE effect_id='success';
  RAISE EXCEPTION 'success without replay result';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE clockgrove.effect_attempts SET disposition='succeeded',outcome_code='ok',ended_at=statement_timestamp(),result_artifact_id='effect-result',cost_microusd=0 WHERE effect_id='success';
UPDATE clockgrove.effect_intents SET disposition='succeeded',outcome_code='ok',ended_at=(SELECT ended_at FROM clockgrove.effect_attempts WHERE effect_id='success') WHERE effect_id='success';
SET LOCAL ROLE clockgrove_runtime;
SELECT set_config('app.tenant_id','tenant-j-a',true),set_config('app.principal_id','principal-j-a',true),set_config('app.privacy_ceiling','{"version":1,"allowedCategories":["operator_evidence"]}',true);
DO $$ DECLARE q text; BEGIN
 IF (SELECT count(*) FROM clockgrove.effect_intents)<>2 OR (SELECT count(*) FROM clockgrove.effect_attempts)<>2 THEN RAISE EXCEPTION 'effect scope leaked'; END IF;
 IF (SELECT result_artifact_id FROM clockgrove.effect_attempts WHERE effect_id='success') IS DISTINCT FROM 'effect-result' OR (SELECT cost_microusd FROM clockgrove.effect_attempts WHERE effect_id='success') IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'recorded success lost'; END IF;
 IF (SELECT disposition FROM clockgrove.effect_intents WHERE effect_id='effect-a')<>'uncertain' THEN RAISE EXCEPTION 'uncertainty changed'; END IF;
 FOREACH q IN ARRAY ARRAY[
  'INSERT INTO clockgrove.effect_intents SELECT * FROM clockgrove.effect_intents',
  'INSERT INTO clockgrove.effect_attempts SELECT * FROM clockgrove.effect_attempts',
  'UPDATE clockgrove.effect_intents SET outcome_code=''forged''',
  'UPDATE clockgrove.effect_attempts SET cost_microusd=0',
  'DELETE FROM clockgrove.effect_intents','DELETE FROM clockgrove.effect_attempts',
  'TRUNCATE clockgrove.effect_intents CASCADE','TRUNCATE clockgrove.effect_attempts'] LOOP
  BEGIN EXECUTE q; RAISE EXCEPTION 'runtime mutated ledger'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
 PERFORM set_config('app.principal_id','principal-j-b',true);
 IF (SELECT count(*) FROM clockgrove.effect_intents)<>0 OR (SELECT count(*) FROM clockgrove.effect_attempts)<>0 THEN RAISE EXCEPTION 'principal leaked ledger'; END IF;
 PERFORM set_config('app.principal_id','principal-j-a',true);
 PERFORM set_config('app.privacy_ceiling','{"version":1,"allowedCategories":["conversation"]}',true);
 IF (SELECT count(*) FROM clockgrove.effect_intents)<>0 OR (SELECT count(*) FROM clockgrove.effect_attempts)<>0 THEN RAISE EXCEPTION 'ceiling leaked ledger'; END IF;
 PERFORM set_config('app.privacy_ceiling','{"version":1,"allowedCategories":["operator_evidence"]}',true);
 PERFORM set_config('app.tenant_id','tenant-j-b',true);
 IF (SELECT count(*) FROM clockgrove.effect_intents)<>0 OR (SELECT count(*) FROM clockgrove.effect_attempts)<>0 THEN RAISE EXCEPTION 'tenant leaked ledger'; END IF;
END $$;
RESET ROLE;
SELECT 'effect_ledger_ok';
ROLLBACK;
