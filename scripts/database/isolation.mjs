// Shared effective catalog verification; no credentials or provider calls.
export const databaseIsolationQuery = `
      WITH RECURSIVE effective AS (
        SELECT oid AS role_oid, oid AS inherited FROM pg_roles WHERE rolname IN ('clockgrove_runtime', 'clockgrove_support', 'clockgrove_backup', 'clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader')
        UNION
        SELECT effective.role_oid, membership.roleid FROM effective JOIN pg_auth_members membership ON membership.member = effective.inherited
      ) SELECT
        current_user = 'clockgrove_migrator' AS migration_identity,
        (SELECT count(*) = 7 FROM pg_roles WHERE rolname IN ('clockgrove_migrator', 'clockgrove_runtime', 'clockgrove_support', 'clockgrove_backup', 'clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader')) AS declared_roles,
        NOT EXISTS (SELECT 1 FROM effective JOIN pg_roles role ON role.oid = effective.inherited WHERE role.rolsuper OR role.rolbypassrls OR role.rolcreatedb OR role.rolcreaterole OR role.rolname IN ('clockgrove_migrator', 'neon_superuser')) AS effective_isolation,
        NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('clockgrove_runtime', 'clockgrove_support', 'clockgrove_backup', 'clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader') AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole)) AS direct_isolation,
        NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'clockgrove' AND has_schema_privilege('clockgrove_runtime', oid, 'CREATE')) AS no_runtime_schema_create,
        NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'clockgrove' AND c.relkind = 'r' AND c.relname != 'schema_migrations' AND c.relname != 'migration_backfill_checkpoints' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)) AS forced_rls,
        NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('clockgrove', 'clockgrove_auth', 'clockgrove_management') AND c.relkind = 'r' AND (has_table_privilege('clockgrove_support', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege('clockgrove_backup', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) AS support_backup_read_only,
        NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles owner ON owner.oid = c.relowner WHERE n.nspname IN ('clockgrove', 'clockgrove_auth', 'clockgrove_management') AND owner.rolname != 'clockgrove_migrator') AS migration_ownership,
        (SELECT count(*) = 3 FROM pg_namespace WHERE nspname IN ('clockgrove', 'clockgrove_auth', 'clockgrove_management') AND nspowner = 'clockgrove_migrator'::regrole) AS migration_schema_ownership,
        NOT EXISTS (
          SELECT 1 FROM effective JOIN pg_roles role ON role.oid = effective.role_oid CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE role.rolname IN ('clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader')
            AND n.nspname IN ('clockgrove', 'clockgrove_auth', 'clockgrove_management') AND c.relkind IN ('r', 'S')
            AND (CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(effective.inherited, c.oid, 'USAGE,SELECT,UPDATE')
              ELSE has_table_privilege(effective.inherited, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END)
        ) AS readers_cannot_write,
        NOT EXISTS (
          SELECT 1 FROM effective JOIN pg_roles role ON role.oid = effective.role_oid CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE role.rolname IN ('clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader')
            AND n.nspname IN ('clockgrove', 'clockgrove_auth', 'clockgrove_management') AND c.relkind = 'r'
            AND has_table_privilege(effective.inherited, c.oid, 'SELECT')
            AND NOT ((role.rolname = 'clockgrove_auth_verifier' AND n.nspname = 'clockgrove_auth' AND c.relname IN ('user', 'session'))
              OR (role.rolname = 'clockgrove_management_reader' AND n.nspname = 'clockgrove_management' AND c.relname IN ('principals', 'identity_links', 'workspace_memberships'))
              OR (role.rolname = 'clockgrove_world_reader' AND n.nspname = 'clockgrove' AND c.relname = 'world_memberships'))
        ) AS readers_scoped_select,
        NOT EXISTS (SELECT 1 FROM effective JOIN pg_roles role ON role.oid = effective.role_oid CROSS JOIN pg_namespace n
          WHERE role.rolname IN ('clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader')
          AND n.nspname IN ('clockgrove', 'clockgrove_auth', 'clockgrove_management', 'public')
          AND has_schema_privilege(effective.inherited, n.oid, 'CREATE')) AS readers_cannot_create,
        NOT EXISTS (SELECT 1 FROM effective JOIN pg_roles role ON role.oid = effective.role_oid WHERE role.rolname IN ('clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader')
          AND has_function_privilege(effective.inherited, 'clockgrove.execute_journal(bytea,jsonb,text)', 'EXECUTE')) AS readers_cannot_execute_journal,
        (SELECT count(*) = 3 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'clockgrove_management' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity) AS management_forced_rls,
        has_table_privilege('clockgrove_auth_verifier', 'clockgrove_auth.session', 'SELECT') AND has_table_privilege('clockgrove_auth_verifier', 'clockgrove_auth.user', 'SELECT') AS auth_verification_read,
        has_table_privilege('clockgrove_management_reader', 'clockgrove_management.identity_links', 'SELECT') AND has_table_privilege('clockgrove_management_reader', 'clockgrove_management.principals', 'SELECT') AND has_table_privilege('clockgrove_management_reader', 'clockgrove_management.workspace_memberships', 'SELECT') AS management_read,
        has_table_privilege('clockgrove_world_reader', 'clockgrove.world_memberships', 'SELECT') AS world_authorization_read`;
