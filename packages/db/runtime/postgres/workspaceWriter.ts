/**
 * `snaglet_workspace_writer` — the login role that `database_execute` and
 * `create_view` run agent SQL as.
 *
 * It can do anything to custom Database tables (the `user_tables` schema) and
 * nothing to Snaglet's system tables (everything in `public`). Like
 * {@link WORKSPACE_READER_ROLE} it is the session user of its own
 * two-connection pool, a member of nothing and non-superuser, so `SET ROLE`,
 * `set_config('role', …)`, `SET SESSION AUTHORIZATION` and superuser-only
 * functions all fail inside PostgreSQL itself.
 *
 * Grants, rebuilt idempotently on every provisioning (at boot, after
 * migrations):
 * - `USAGE, CREATE` on `user_tables`; its `search_path` is `user_tables`, so an
 *   unqualified `CREATE VIEW` lands there, never in `public`.
 * - `ALL` on every table and sequence in `user_tables`, plus
 *   `ALTER DEFAULT PRIVILEGES FOR ROLE <app role> IN SCHEMA user_tables GRANT
 *   ALL`, so a table the app creates later is writable at once.
 * - `USAGE` (only) on `public`, for name resolution and the pure extension
 *   functions; no table privilege and no `CREATE` there, so a view over
 *   `agents` fails: its owner (this role) cannot SELECT it.
 *
 * `GRANT ALL` does not include `ALTER`/`DROP`, which PostgreSQL ties to
 * ownership: the role can alter only what it created itself, and the app's
 * catalog tables stay owned by the app.
 */
import {
  CUSTOM_TABLES_SCHEMA,
  ensureReaderLoginRole,
  quoteSqlIdentifier,
  readerHbaEntry,
  revokePublicDefaults,
  withConcurrentCatalogRetry,
  type ProvisioningQueryable,
} from './readerRole';
import { FORBIDDEN_FUNCTIONS, type ReaderSessionQueryable } from './workspaceReader';

export const WORKSPACE_WRITER_ROLE = 'snaglet_workspace_writer';

/** Loopback pg_hba entry the writer needs on the Windows TCP transport. */
export const WORKSPACE_WRITER_HBA_ENTRY = readerHbaEntry(WORKSPACE_WRITER_ROLE);

/**
 * The writer resolves names in the custom schema only, so an unqualified
 * `CREATE VIEW`/`CREATE TABLE` lands there and a bare `agents` does not resolve
 * to the system table. `public` is reachable only by explicit qualification,
 * and the role has no table privilege there anyway.
 */
export const WORKSPACE_WRITER_SEARCH_PATH = CUSTOM_TABLES_SCHEMA;

/** Two per Snaglet process, with room for a second process on a shared cluster. */
const WORKSPACE_WRITER_CONNECTION_LIMIT = 4;

/** Extensions whose (pure) functions and operators the writer may call. */
const WRITABLE_EXTENSIONS = ['vector', 'pg_trgm'] as const;

export interface WorkspaceWriterProvisioningOptions {
  /** The LOGIN password; it travels as a bound parameter, never as SQL text. */
  password: string;
  /** Database to grant CONNECT and custom-schema writes on. */
  database: string;
  /** Managed clusters only; see {@link revokePublicDefaults}. */
  revokePublic: boolean;
}

export interface WorkspaceWriterProvisioningReport {
  /** True when the `user_tables` schema existed and was granted. */
  customSchemaGranted: boolean;
}

/**
 * Create or refresh {@link WORKSPACE_WRITER_ROLE} and rebuild its grants.
 * Idempotent; runs in one transaction, so a concurrent writer statement sees
 * either the old or the new grants, never a mix. Runs as the connected user,
 * which must be able to create roles and owns the custom tables (the managed
 * cluster's `snaglet` superuser). Nothing here touches user data.
 */
export async function provisionWorkspaceWriterRole(
  db: ProvisioningQueryable,
  options: WorkspaceWriterProvisioningOptions
): Promise<WorkspaceWriterProvisioningReport> {
  if (!options.password) throw new Error('workspace writer password must not be empty');
  const role = quoteSqlIdentifier(WORKSPACE_WRITER_ROLE, 'role name');
  const schema = quoteSqlIdentifier(CUSTOM_TABLES_SCHEMA, 'schema name');
  return withConcurrentCatalogRetry(() =>
    db.transaction(async (tx) => {
      await ensureReaderLoginRole(tx, {
        role: WORKSPACE_WRITER_ROLE,
        password: options.password,
        database: options.database,
        connectionLimit: WORKSPACE_WRITER_CONNECTION_LIMIT,
        // Not read-only: this role writes. A larger statement budget than the
        // readers' 5s because DDL and bulk writes (ALTER TABLE rewrites,
        // INSERT … SELECT) legitimately run longer; 30s still bounds a runaway.
        settings: [
          "statement_timeout = '30s'",
          "lock_timeout = '5s'",
          "idle_in_transaction_session_timeout = '15s'",
          `search_path = ${WORKSPACE_WRITER_SEARCH_PATH}`,
        ],
      });
      if (options.revokePublic) await revokePublicDefaults(tx, options.database);

      // Reset everything this role could hold anywhere, then grant only the
      // custom schema. No privilege or CREATE on `public` survives this.
      await tx.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${role}`);
      await tx.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${role}`
      );
      await tx.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
      await tx.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
      await tx.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`);
      await tx.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);

      const hasSchema = await tx.query<{ present: boolean }>(
        `SELECT to_regnamespace('${CUSTOM_TABLES_SCHEMA}') IS NOT NULL AS present`
      );
      const customSchemaGranted = Boolean(hasSchema.rows[0]?.present);
      if (customSchemaGranted) {
        await tx.query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role}`);
        await tx.query(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
        await tx.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
        // Future tables the app (the connected role) creates in user_tables are
        // granted automatically, so a new custom table is writable with no
        // restart. FOR ROLE must name the role that will create them; the app
        // always connects as the current user here (the `snaglet` superuser).
        await tx.query(
          `DO $snaglet$
          DECLARE creator text := current_user;
          BEGIN
            EXECUTE format(
              'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA ${CUSTOM_TABLES_SCHEMA} GRANT ALL ON TABLES TO ${WORKSPACE_WRITER_ROLE}',
              creator
            );
            EXECUTE format(
              'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA ${CUSTOM_TABLES_SCHEMA} GRANT ALL ON SEQUENCES TO ${WORKSPACE_WRITER_ROLE}',
              creator
            );
          END
        $snaglet$`
        );
        // Objects the writer itself creates in user_tables (views from
        // create_view, scratch tables) must stay readable by the agent SQL
        // readers, whose own default privileges only cover what the app
        // creates. A writer-owned view reads with the writer's privileges, so
        // it can never widen a reader past user_tables.
        await tx.query(
          `DO $snaglet$
          DECLARE reader text;
          BEGIN
            FOREACH reader IN ARRAY ARRAY['snaglet_workspace_reader', 'snaglet_tables_reader'] LOOP
              IF to_regrole(reader) IS NOT NULL THEN
                EXECUTE format(
                  'ALTER DEFAULT PRIVILEGES FOR ROLE ${WORKSPACE_WRITER_ROLE} IN SCHEMA ${CUSTOM_TABLES_SCHEMA} GRANT SELECT ON TABLES TO %I',
                  reader
                );
              END IF;
            END LOOP;
          END
        $snaglet$`
        );
      }

      // Managed clusters revoke PUBLIC EXECUTE on `public` functions, which
      // includes pgvector's and pg_trgm's operators; give those pure functions
      // back so a view or write over a custom table can use them.
      await tx.query(
        `DO $snaglet$
        DECLARE fn regprocedure;
        BEGIN
          FOR fn IN
            SELECT p.oid::regprocedure
              FROM pg_catalog.pg_proc p
              JOIN pg_catalog.pg_depend d
                ON d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
              JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
             WHERE e.extname IN (${WRITABLE_EXTENSIONS.map((name) => `'${name}'`).join(', ')})
          LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${WORKSPACE_WRITER_ROLE}', fn);
          END LOOP;
        END
      $snaglet$`
      );
      return { customSchemaGranted };
    })
  );
}

/**
 * Refuse a writer session that could escape its sandbox: a superuser or
 * otherwise elevated role, a member of any other role (it could `SET ROLE`
 * into it), a role that may execute server-side file/program functions, or —
 * the write-side invariant — a role that can reach any `public` relation
 * (read, write, own) or create objects in `public`. Runs on the writer
 * connection itself, so it checks exactly the credentials Snaglet will use,
 * including an operator-supplied `SNAGLET_WORKSPACE_WRITER_URL` role.
 */
export async function assertWorkspaceWriterRestricted(
  writer: ReaderSessionQueryable
): Promise<void> {
  const label = 'workspace writer';
  const { rows } = await writer.query<{
    role: string;
    elevated: boolean;
    can_create_public: boolean;
    memberships: string[];
    public_access: string[];
    functions: string[];
  }>(
    `SELECT r.rolname::text AS role,
            (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication) AS elevated,
            pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create_public,
            ARRAY(
              SELECT g.rolname::text FROM pg_catalog.pg_roles g
               WHERE g.oid <> r.oid AND pg_catalog.pg_has_role(r.oid, g.oid, 'MEMBER')
               ORDER BY 1
            ) AS memberships,
            ARRAY(
              SELECT ('public.' || c.relname)::text
                FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public'
                 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                 AND (c.relowner = r.oid
                      OR pg_catalog.has_table_privilege(
                           r.oid, c.oid,
                           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
               ORDER BY 1 LIMIT 5
            ) AS public_access,
            ARRAY(
              SELECT DISTINCT p.proname::text FROM pg_catalog.pg_proc p
               WHERE p.pronamespace = 'pg_catalog'::regnamespace
                 AND p.proname = ANY($1::text[])
                 AND pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
               ORDER BY 1
            ) AS functions
       FROM pg_catalog.pg_roles r
      WHERE r.rolname = session_user`,
    [FORBIDDEN_FUNCTIONS]
  );
  const session = rows[0];
  if (!session) throw new Error(`${label}: cannot identify the session role`);
  const problems: string[] = [];
  if (session.elevated) problems.push('it is a superuser or holds a role-level privilege');
  if (session.memberships.length > 0) {
    problems.push(`it is a member of ${session.memberships.join(', ')}`);
  }
  if (session.can_create_public) problems.push('it may CREATE in schema public');
  if (session.public_access.length > 0) {
    problems.push(`it can reach public workspace tables (${session.public_access.join(', ')})`);
  }
  if (session.functions.length > 0) {
    problems.push(`it may execute ${session.functions.join(', ')}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `${label}: refusing writer role ${session.role}: ${problems.join('; ')}. ` +
        'A writer must be a plain LOGIN role that reaches only the user_tables schema.'
    );
  }
}
