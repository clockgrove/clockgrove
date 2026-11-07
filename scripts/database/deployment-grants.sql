-- Controlled migration connection owns this reviewed privilege normalization.
-- Never grant runtime, support or backup the migration/provider operator role.
DO $roles$
DECLARE
  role_name text;
  parent_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['clockgrove_runtime', 'clockgrove_support', 'clockgrove_backup', 'clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader'] LOOP
    FOR parent_name IN
      SELECT parent.rolname
        FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid = membership.member
        JOIN pg_roles parent ON parent.oid = membership.roleid
       WHERE member.rolname = role_name
    LOOP
      EXECUTE format('REVOKE %I FROM %I', parent_name, role_name);
    END LOOP;
    EXECUTE format('ALTER ROLE %I NOCREATEDB NOCREATEROLE NOINHERIT', role_name);
  END LOOP;
END;
$roles$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $database$
BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', current_database());
END;
$database$;
