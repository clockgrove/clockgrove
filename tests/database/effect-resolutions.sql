BEGIN;
INSERT INTO clockgrove.world_memberships(tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
 VALUES ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-a','resolution-owner','resolution-persona',ARRAY['owner'],'{}','{"version":1,"allowedCategories":["operator_evidence"]}',statement_timestamp());
INSERT INTO clockgrove.timelines(tenant_id,world_id,timeline_id) VALUES ('tenant-j-a','world-j-a','resolution-other');
INSERT INTO clockgrove.worlds(tenant_id,world_id,lifecycle_status) VALUES ('tenant-j-a','resolution-world','ready');
INSERT INTO clockgrove.timelines(tenant_id,world_id,timeline_id) VALUES ('tenant-j-a','resolution-world','resolution-timeline');
INSERT INTO clockgrove.timeline_partitions(tenant_id,world_id,timeline_id,partition_id,space_id) VALUES
 ('tenant-j-a','world-j-a','resolution-other','resolution-other','space-j-a'),
 ('tenant-j-a','resolution-world','resolution-timeline','resolution-world','space-j-a');
INSERT INTO clockgrove.effect_intents(tenant_id,world_id,timeline_id,space_id,effect_id,idempotency_key,actor_id,principal_id,call_id,capability_id,grant_id,policy_version,arguments_hash,reserved_microusd)
 SELECT tenant_id,world_id,timeline_id,space_id,'resolution-attack','resolution-attack','fixture-actor',principal_id,'resolution-attack','fixture-write','grant','policy',repeat('a',64),0 FROM (VALUES
 ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-a'),
 ('tenant-j-a','world-j-a','resolution-other','space-j-a','principal-j-a'),
 ('tenant-j-a','resolution-world','resolution-timeline','space-j-a','principal-j-a'),
 ('tenant-j-b','world-j-b','timeline-j-b','space-j-b','principal-j-b')) v(tenant_id,world_id,timeline_id,space_id,principal_id);
UPDATE clockgrove.effect_intents SET disposition='started' WHERE effect_id='resolution-attack';
INSERT INTO clockgrove.effect_attempts(tenant_id,world_id,timeline_id,effect_id,attempt_id)
 SELECT tenant_id,world_id,timeline_id,effect_id,'resolution-attempt' FROM clockgrove.effect_intents WHERE effect_id='resolution-attack';
UPDATE clockgrove.effect_attempts SET disposition='uncertain',outcome_code='reply_lost',ended_at=clock_timestamp() WHERE effect_id='resolution-attack';
UPDATE clockgrove.effect_intents i SET disposition='uncertain',outcome_code=a.outcome_code,ended_at=a.ended_at
 FROM clockgrove.effect_attempts a WHERE i.effect_id='resolution-attack' AND a.tenant_id=i.tenant_id AND a.world_id=i.world_id AND a.timeline_id=i.timeline_id AND a.effect_id=i.effect_id;
DO $$ DECLARE q text; BEGIN
 FOREACH q IN ARRAY ARRAY[
  'INSERT INTO clockgrove.effect_resolutions SELECT tenant_id,world_id,timeline_id,effect_id,''foreign-space'',attempt_id,''principal-j-a'',''done'',clock_timestamp() FROM clockgrove.effect_attempts WHERE effect_id=''resolution-attack'' AND tenant_id=''tenant-j-a''',
  'INSERT INTO clockgrove.effect_resolutions SELECT tenant_id,world_id,timeline_id,effect_id,''space-j-a'',''foreign-attempt'',''principal-j-a'',''done'',clock_timestamp() FROM clockgrove.effect_attempts WHERE effect_id=''resolution-attack'' AND tenant_id=''tenant-j-a'''] LOOP
  BEGIN EXECUTE q; RAISE EXCEPTION 'resolution scope bypassed'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 END LOOP;
END $$;
INSERT INTO clockgrove.effect_resolutions(tenant_id,world_id,timeline_id,effect_id,space_id,attempt_id,resolved_by,disposition,resolved_at)
 SELECT i.tenant_id,i.world_id,i.timeline_id,i.effect_id,i.space_id,a.attempt_id,i.principal_id,'done','2000-01-01'::timestamptz
 FROM clockgrove.effect_intents i JOIN clockgrove.effect_attempts a USING(tenant_id,world_id,timeline_id,effect_id) WHERE i.effect_id='resolution-attack';
DO $$ DECLARE q text; BEGIN
 IF EXISTS (SELECT 1 FROM clockgrove.effect_resolutions WHERE resolved_at<'2020-01-01') THEN RAISE EXCEPTION 'caller supplied attribution time'; END IF;
 FOREACH q IN ARRAY ARRAY['UPDATE clockgrove.effect_resolutions SET disposition=''failed''','DELETE FROM clockgrove.effect_resolutions','TRUNCATE clockgrove.effect_resolutions'] LOOP
  BEGIN EXECUTE q; RAISE EXCEPTION 'resolution mutated'; EXCEPTION WHEN SQLSTATE 'CG006' THEN NULL; END;
 END LOOP;
END $$;
SET LOCAL ROLE clockgrove_runtime;
SELECT set_config('app.tenant_id','tenant-j-a',true),set_config('app.principal_id','principal-j-a',true),
 set_config('app.privacy_ceiling','{"version":1,"allowedCategories":["operator_evidence"]}',true);
DO $$ DECLARE q text; BEGIN
 IF (SELECT count(*) FROM clockgrove.effect_resolutions WHERE effect_id='resolution-attack')<>1 THEN RAISE EXCEPTION 'resolution world/timeline scope leaked'; END IF;
 FOREACH q IN ARRAY ARRAY['INSERT INTO clockgrove.effect_resolutions SELECT * FROM clockgrove.effect_resolutions','UPDATE clockgrove.effect_resolutions SET disposition=''failed''','DELETE FROM clockgrove.effect_resolutions','TRUNCATE clockgrove.effect_resolutions'] LOOP
  BEGIN EXECUTE q; RAISE EXCEPTION 'runtime mutated resolutions'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
 PERFORM set_config('app.principal_id','principal-j-b',true);
 IF (SELECT count(*) FROM clockgrove.effect_resolutions)<>0 THEN RAISE EXCEPTION 'resolution principal leaked'; END IF;
 PERFORM set_config('app.principal_id','principal-j-a',true);
 PERFORM set_config('app.privacy_ceiling','{"version":1,"allowedCategories":["conversation"]}',true);
 IF (SELECT count(*) FROM clockgrove.effect_resolutions)<>0 THEN RAISE EXCEPTION 'resolution privacy leaked'; END IF;
 PERFORM set_config('app.privacy_ceiling','{"version":1,"allowedCategories":["operator_evidence"]}',true);
 PERFORM set_config('app.tenant_id','tenant-j-b',true);
 IF (SELECT count(*) FROM clockgrove.effect_resolutions)<>0 THEN RAISE EXCEPTION 'resolution tenant leaked'; END IF;
END $$;
RESET ROLE;
SELECT 'effect_resolutions_ok';
ROLLBACK;
