BEGIN;
INSERT INTO clockgrove.world_memberships(tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
 VALUES ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-a','approval-owner','approval-persona',ARRAY['owner'],'{}','{"version":1,"allowedCategories":["operator_evidence"]}',statement_timestamp());
INSERT INTO clockgrove.timelines(tenant_id,world_id,timeline_id,kind) VALUES
 ('tenant-j-a','world-j-a','approval-other','live'),('tenant-j-a','world-j-a','approval-preview','branch');
INSERT INTO clockgrove.worlds(tenant_id,world_id,lifecycle_status) VALUES ('tenant-j-a','approval-world','ready');
INSERT INTO clockgrove.timelines(tenant_id,world_id,timeline_id) VALUES ('tenant-j-a','approval-world','approval-world-timeline');
INSERT INTO clockgrove.timeline_partitions(tenant_id,world_id,timeline_id,partition_id,space_id) VALUES
 ('tenant-j-a','world-j-a','approval-other','approval-other','space-j-a'),
 ('tenant-j-a','world-j-a','approval-preview','approval-preview','space-j-a'),
 ('tenant-j-a','approval-world','approval-world-timeline','approval-world','space-j-a');
INSERT INTO clockgrove.effect_approvals(tenant_id,world_id,timeline_id,space_id,approval_id,effect_id,principal_id,approver_principal_id,arguments_hash,effect_hash,expires_at)
 VALUES ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','attack','effect','principal-j-a','principal-j-a',repeat('a',64),repeat('b',64),clock_timestamp()),
 ('tenant-j-a','world-j-a','approval-other','space-j-a','attack','effect','principal-j-a','principal-j-a',repeat('a',64),repeat('b',64),clock_timestamp()),
 ('tenant-j-a','world-j-a','approval-preview','space-j-a','preview','effect','principal-j-a','principal-j-a',repeat('a',64),repeat('b',64),clock_timestamp()),
 ('tenant-j-a','approval-world','approval-world-timeline','space-j-a','attack','effect','principal-j-a','principal-j-a',repeat('a',64),repeat('b',64),clock_timestamp()),
 ('tenant-j-b','world-j-b','timeline-j-b','space-j-b','attack','effect','principal-j-b','principal-j-b',repeat('a',64),repeat('b',64),clock_timestamp());
DO $$ DECLARE q text; BEGIN
 FOREACH q IN ARRAY ARRAY[
  'UPDATE clockgrove.effect_approvals SET arguments_hash=repeat(''c'',64) WHERE approval_id=''attack''',
  'UPDATE clockgrove.effect_approvals SET expires_at=expires_at+interval ''1 second'' WHERE approval_id=''attack''',
  'UPDATE clockgrove.effect_approvals SET state=''approved'' WHERE approval_id=''attack''',
  'UPDATE clockgrove.effect_approvals SET state=''approved'',decided_by=''principal-j-b'' WHERE approval_id=''attack''',
  'UPDATE clockgrove.effect_approvals SET state=''consumed'',consumed_by=''principal-j-a'' WHERE approval_id=''attack''',
  'UPDATE clockgrove.effect_approvals SET state=''expired'' WHERE approval_id=''attack'''] LOOP
  BEGIN EXECUTE q; RAISE EXCEPTION 'approval invariant bypassed';
  EXCEPTION WHEN invalid_parameter_value OR check_violation THEN NULL; END;
 END LOOP;
 BEGIN
  UPDATE clockgrove.effect_approvals SET state='approved',decided_by='principal-j-a' WHERE approval_id='preview';
  RAISE EXCEPTION 'preview authorized effect';
 EXCEPTION WHEN SQLSTATE 'CG012' THEN NULL; END;
END $$;
UPDATE clockgrove.effect_approvals SET state='approved',decided_by=approver_principal_id WHERE approval_id='attack';
DO $$ DECLARE q text; BEGIN
 FOREACH q IN ARRAY ARRAY[
  'UPDATE clockgrove.effect_approvals SET state=''revoked'' WHERE approval_id=''attack''',
  'UPDATE clockgrove.effect_approvals SET state=''consumed'' WHERE approval_id=''attack''',
  'UPDATE clockgrove.effect_approvals SET state=''revoked'',revoked_by=''principal-j-a'',decided_by=''principal-j-b'' WHERE approval_id=''attack'''] LOOP
  BEGIN EXECUTE q; RAISE EXCEPTION 'approval attribution bypassed';
  EXCEPTION WHEN invalid_parameter_value OR check_violation THEN NULL; END;
 END LOOP;
END $$;
SET LOCAL ROLE clockgrove_runtime;
SELECT set_config('app.tenant_id','tenant-j-a',true),set_config('app.principal_id','principal-j-a',true),
 set_config('app.privacy_ceiling','{"version":1,"allowedCategories":["operator_evidence"]}',true);
DO $$ DECLARE q text; BEGIN
 IF (SELECT count(*) FROM clockgrove.effect_approvals WHERE approval_id='attack')<>1 THEN RAISE EXCEPTION 'approval scope leaked'; END IF;
 FOREACH q IN ARRAY ARRAY[
  'INSERT INTO clockgrove.effect_approvals SELECT * FROM clockgrove.effect_approvals',
  'UPDATE clockgrove.effect_approvals SET state=''approved'',decided_by=''principal-j-a''',
  'DELETE FROM clockgrove.effect_approvals','TRUNCATE clockgrove.effect_approvals'] LOOP
  BEGIN EXECUTE q; RAISE EXCEPTION 'runtime mutated approvals'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
 PERFORM set_config('app.principal_id','principal-j-b',true);
 IF (SELECT count(*) FROM clockgrove.effect_approvals)<>0 THEN RAISE EXCEPTION 'approval principal leaked'; END IF;
 PERFORM set_config('app.principal_id','principal-j-a',true);
 PERFORM set_config('app.privacy_ceiling','{"version":1,"allowedCategories":["conversation"]}',true);
 IF (SELECT count(*) FROM clockgrove.effect_approvals)<>0 THEN RAISE EXCEPTION 'approval privacy leaked'; END IF;
 PERFORM set_config('app.privacy_ceiling','{"version":1,"allowedCategories":["operator_evidence"]}',true);
 PERFORM set_config('app.tenant_id','tenant-j-b',true);
 IF (SELECT count(*) FROM clockgrove.effect_approvals)<>0 THEN RAISE EXCEPTION 'approval tenant leaked'; END IF;
END $$;
RESET ROLE;
SELECT 'effect_approvals_ok';
ROLLBACK;
