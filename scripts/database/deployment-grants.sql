-- Reviewed role provisioning and privilege normalization, run by the migration role in one
-- transaction. Neon makes every role created through its API a member of neon_superuser, which
-- reads and writes all data and which a non-superuser cannot revoke, so the restricted roles are
-- created here with SQL instead (https://neon.com/docs/manage/roles). On PostgreSQL 16 and later
-- the creating role administers each role it creates, so later runs can alter them.
-- deployment-roles.mjs prepends the psql variables password_<role key> on standard input, so the
-- passwords never appear in arguments, the environment or logs. A failed check raises
-- "clockgrove role check: <role> <problem>", which the deploy reports by name.
-- Never grant runtime, support, backup or the readers the migration/provider operator role.
DO $preconditions$
DECLARE
  restricted text;
  parents text;
BEGIN
  IF NOT (SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'clockgrove role check: % lacks CREATEROLE', current_user;
  END IF;
  -- An existing restricted role must be one this role created: no role membership, administered
  -- by this role. A Neon API role fails here, by name, before anything changes.
  FOREACH restricted IN ARRAY ARRAY['clockgrove_runtime', 'clockgrove_support', 'clockgrove_backup', 'clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader', 'clockgrove_mcp_secrets'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = restricted);
    SELECT string_agg(parent.rolname, ', ' ORDER BY parent.rolname) INTO parents
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles parent ON parent.oid = membership.roleid
     WHERE member.rolname = restricted;
    IF parents IS NOT NULL THEN
      RAISE EXCEPTION 'clockgrove role check: % is a member of %', restricted, parents;
    END IF;
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AND NOT EXISTS (
      SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid = membership.member
        JOIN pg_roles granted ON granted.oid = membership.roleid
       WHERE granted.rolname = restricted AND member.rolname = current_user AND membership.admin_option
    ) THEN
      RAISE EXCEPTION 'clockgrove role check: % is not administered by %', restricted, current_user;
    END IF;
  END LOOP;
END;
$preconditions$;

SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', restricted)
  FROM unnest(ARRAY['clockgrove_runtime', 'clockgrove_support', 'clockgrove_backup', 'clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader', 'clockgrove_mcp_secrets']) AS restricted
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = restricted)
\gexec

SELECT format('ALTER ROLE %I LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', restricted, generated)
  FROM (VALUES
    ('clockgrove_runtime', :'password_runtime'),
    ('clockgrove_support', :'password_support'),
    ('clockgrove_backup', :'password_backup'),
    ('clockgrove_auth_verifier', :'password_authentication'),
    ('clockgrove_management_reader', :'password_management'),
    ('clockgrove_world_reader', :'password_worldAuthorization')
  ) AS login(restricted, generated)
\gexec

ALTER ROLE clockgrove_mcp_secrets NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD NULL;

-- Every restricted role ends with no role membership and no elevated or unexpected attribute.
DO $postconditions$
DECLARE
  restricted record;
BEGIN
  FOR restricted IN
    SELECT role.rolname,
           role.rolcanlogin <> (role.rolname <> 'clockgrove_mcp_secrets') OR role.rolsuper
             OR role.rolcreatedb OR role.rolcreaterole OR role.rolinherit OR role.rolreplication
             OR role.rolbypassrls AS elevated,
           (SELECT string_agg(parent.rolname, ', ' ORDER BY parent.rolname)
              FROM pg_auth_members membership JOIN pg_roles parent ON parent.oid = membership.roleid
             WHERE membership.member = role.oid) AS parents
      FROM pg_roles role
     WHERE role.rolname IN ('clockgrove_runtime', 'clockgrove_support', 'clockgrove_backup', 'clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader', 'clockgrove_mcp_secrets')
  LOOP
    IF restricted.parents IS NOT NULL THEN
      RAISE EXCEPTION 'clockgrove role check: % is a member of %', restricted.rolname, restricted.parents;
    END IF;
    IF restricted.elevated THEN
      RAISE EXCEPTION 'clockgrove role check: % has an elevated or unexpected attribute', restricted.rolname;
    END IF;
  END LOOP;
END;
$postconditions$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $database$
BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', current_database());
END;
$database$;
