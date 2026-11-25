-- Usage webhooks (0078), with a real row: a webhook is its registrar's alone, and only while the
-- registrar reads the space's usage (the inspect grant and the `operator_evidence` ceiling) and
-- holds `runtime:usage-webhook` (needed to point it at a host), which the world's owner holds by
-- default. Another tenant, a member without the grant, the registrar under a ceiling without
-- operator evidence and another inspector of the same space see, move and forge none; the due
-- listing drops a webhook whose registrar lost the membership, the ceiling, the inspect grant or
-- the webhook authority, and lists it again once restored. An inspector who operates the world but
-- was not given `runtime:usage-webhook` cannot point a webhook anywhere; once the grant is
-- delegated to them, they can.
BEGIN;
INSERT INTO clockgrove.tenant_principals(tenant_id,principal_id) VALUES
 ('tenant-j-a','principal-j-c'),('tenant-j-a','principal-j-d');
INSERT INTO clockgrove.world_memberships(tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
 VALUES
 ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-a','hook-registrar','hook-persona-a',ARRAY['owner'],ARRAY['runtime:world-inspect'],'{"version":1,"allowedCategories":["operator_evidence"]}',statement_timestamp()),
 ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-c','hook-member','hook-persona-c',ARRAY['member'],'{}','{"version":1,"allowedCategories":["operator_evidence"]}',statement_timestamp()),
 ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-d','hook-inspector','hook-persona-d',ARRAY['member'],ARRAY['runtime:world-inspect','runtime:world-operate'],'{"version":1,"allowedCategories":["operator_evidence"]}',statement_timestamp());

-- The owner, given no webhook grant, registers by default through row-level security, sees exactly their row, and it is due.
SET LOCAL ROLE clockgrove_runtime;
SELECT set_config('app.tenant_id','tenant-j-a',true),set_config('app.principal_id','principal-j-a',true),
 set_config('app.privacy_ceiling','{"version":1,"allowedCategories":["operator_evidence"]}',true);
INSERT INTO clockgrove.usage_webhooks(tenant_id,world_id,timeline_id,space_id,principal_id,webhook_id,url)
 VALUES ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-a','hook-a','https://hooks.example/usage');
DO $$ BEGIN
 IF (SELECT string_agg(webhook_id||' '||url,',') FROM clockgrove.usage_webhooks)
    IS DISTINCT FROM 'hook-a https://hooks.example/usage' THEN
  RAISE EXCEPTION 'the registrar did not see exactly their webhook';
 END IF;
 IF (SELECT string_agg(tenant_id||'/'||principal_id||'/'||space_id,',') FROM clockgrove.due_usage_webhooks(10))
    IS DISTINCT FROM 'tenant-j-a/principal-j-a/space-j-a' THEN
  RAISE EXCEPTION 'the registered webhook was not due';
 END IF;
END $$;

-- Each hostile context sees no row, moves none and cannot register one in the registrar's name.
DO $$ DECLARE hostile text[]; affected bigint; BEGIN
 FOREACH hostile SLICE 1 IN ARRAY ARRAY[
  ARRAY['tenant-j-b','principal-j-b','{"version":1,"allowedCategories":["operator_evidence"]}'],
  ARRAY['tenant-j-a','principal-j-c','{"version":1,"allowedCategories":["operator_evidence"]}'],
  ARRAY['tenant-j-a','principal-j-a','{"version":1,"allowedCategories":["conversation"]}'],
  ARRAY['tenant-j-a','principal-j-d','{"version":1,"allowedCategories":["operator_evidence"]}']] LOOP
  PERFORM set_config('app.tenant_id',hostile[1],true),set_config('app.principal_id',hostile[2],true),
   set_config('app.privacy_ceiling',hostile[3],true);
  IF (SELECT count(*) FROM clockgrove.usage_webhooks)<>0 THEN
   RAISE EXCEPTION 'webhook visible to % %', hostile[1], hostile[2];
  END IF;
  UPDATE clockgrove.usage_webhooks SET attempts=99,url='https://evil.example/hook';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'webhook moved by % %', hostile[1], hostile[2]; END IF;
  BEGIN
   INSERT INTO clockgrove.usage_webhooks(tenant_id,world_id,timeline_id,space_id,principal_id,webhook_id,url)
    VALUES ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-a','hook-forged','https://evil.example/hook');
   RAISE EXCEPTION 'webhook forged by % %', hostile[1], hostile[2] USING ERRCODE='XX999';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
 PERFORM set_config('app.tenant_id','tenant-j-a',true),set_config('app.principal_id','principal-j-a',true),
  set_config('app.privacy_ceiling','{"version":1,"allowedCategories":["operator_evidence"]}',true);
 BEGIN
  DELETE FROM clockgrove.usage_webhooks;
  RAISE EXCEPTION 'the runtime deleted a webhook' USING ERRCODE='XX999';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  UPDATE clockgrove.usage_webhooks SET principal_id='principal-j-d';
  RAISE EXCEPTION 'the runtime re-attributed a webhook' USING ERRCODE='XX999';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
-- The inspector reads the usage and operates the world, but without `runtime:usage-webhook` they
-- may not set a URL.
SELECT set_config('app.principal_id','principal-j-d',true);
DO $$ BEGIN
 BEGIN
  INSERT INTO clockgrove.usage_webhooks(tenant_id,world_id,timeline_id,space_id,principal_id,webhook_id,url)
   VALUES ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-d','hook-d','https://hooks.example/d');
  RAISE EXCEPTION 'an operator without the webhook grant set a webhook URL' USING ERRCODE='XX999';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT string_agg(webhook_id||' '||principal_id||' '||url||' '||attempts,',') FROM clockgrove.usage_webhooks)
    IS DISTINCT FROM 'hook-a principal-j-a https://hooks.example/usage 0' THEN
  RAISE EXCEPTION 'a hostile context changed the webhook';
 END IF;
END $$;

-- A registrar who loses the membership, the ceiling, the inspect grant or the webhook authority
-- (no longer the owner, with `runtime:world-operate` in its place; an owner that is an actor) stops:
-- their webhook is not due, and without the membership or the inspect grant they no longer see it.
-- Restored, it is due again.
DO $$ DECLARE change text; restore text; BEGIN
 FOREACH change IN ARRAY ARRAY[
  'revoked_at=statement_timestamp()',
  'privacy_ceiling=''{"version":1,"allowedCategories":["public_scene"]}''',
  'grants=''{}''::text[]',
  'roles=ARRAY[''member''],grants=ARRAY[''runtime:world-inspect'',''runtime:world-operate'']',
  'roles=ARRAY[''owner'',''actor'']'] LOOP
  EXECUTE 'UPDATE clockgrove.world_memberships SET '||change||' WHERE membership_id=''hook-registrar''';
  IF (SELECT count(*) FROM clockgrove.due_usage_webhooks(10))<>0 THEN
   RAISE EXCEPTION 'a webhook stayed due after %', change;
  END IF;
  -- Row-level security reads the installed ceiling, proved above; the membership's is the sweep's.
  IF change LIKE 'revoked_at%' OR change LIKE 'grants=%' THEN
   SET LOCAL ROLE clockgrove_runtime;
   IF (SELECT count(*) FROM clockgrove.usage_webhooks)<>0 THEN
    RAISE EXCEPTION 'the registrar still saw the webhook after %', change;
   END IF;
   RESET ROLE;
  END IF;
  UPDATE clockgrove.world_memberships SET revoked_at=NULL,roles=ARRAY['owner'],
   grants=ARRAY['runtime:world-inspect'],
   privacy_ceiling='{"version":1,"allowedCategories":["operator_evidence"]}'
   WHERE membership_id='hook-registrar';
  IF (SELECT count(*) FROM clockgrove.due_usage_webhooks(10))<>1 THEN
   RAISE EXCEPTION 'a restored webhook was not due after %', change;
  END IF;
 END LOOP;
END $$;
-- The owner delegates `runtime:usage-webhook` to the inspector, who now registers their own.
UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:usage-webhook')
 WHERE membership_id='hook-inspector';
SET LOCAL ROLE clockgrove_runtime;
SELECT set_config('app.principal_id','principal-j-d',true);
INSERT INTO clockgrove.usage_webhooks(tenant_id,world_id,timeline_id,space_id,principal_id,webhook_id,url)
 VALUES ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-d','hook-d','https://hooks.example/d');
DO $$ BEGIN
 IF (SELECT string_agg(webhook_id||' '||url,',') FROM clockgrove.usage_webhooks)
    IS DISTINCT FROM 'hook-d https://hooks.example/d' THEN
  RAISE EXCEPTION 'the delegate did not see exactly their webhook';
 END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT string_agg(principal_id,',' ORDER BY principal_id) FROM clockgrove.due_usage_webhooks(10))
    IS DISTINCT FROM 'principal-j-a,principal-j-d' THEN
  RAISE EXCEPTION 'the delegate''s webhook was not due beside the owner''s';
 END IF;
END $$;
SELECT 'usage_webhooks_ok';
ROLLBACK;
