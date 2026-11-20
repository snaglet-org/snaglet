/**
 * `snaglet_workspace_reader` — the login role `database_query` runs agent SQL as.
 *
 * It reads the workspace (every table in `user_tables`, plus the `public` tables
 * classified in {@link WORKSPACE_READER_POLICY}) and nothing else. The rule for
 * `public` is default-deny:
 *
 * - `read`    — SELECT on the whole table, except any column whose name looks
 *               like a secret ({@link SECRET_COLUMN_NAME}); such a column is
 *               left out and reported, so a careless migration fails closed.
 * - `columns` — SELECT on the listed `visible` columns only. Columns in neither
 *               list (added later) stay hidden and are reported.
 * - `deny`    — nothing.
 * - anything unlisted (a new migration's table, a table or view created at
 *   runtime) — nothing, reported as unclassified. Views and other non-table
 *   relations are never granted: a view reads with its owner's privileges.
 *
 * Grants are rebuilt from scratch in one transaction on every provisioning
 * (at boot, after migrations), so the database always matches this file. A
 * migration that adds a `public` table must add it here; the integration suite
 * fails while any migrated relation or column is unclassified.
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

export const WORKSPACE_READER_ROLE = 'snaglet_workspace_reader';

/** Loopback pg_hba entry the workspace reader needs on the Windows TCP transport. */
export const WORKSPACE_READER_HBA_ENTRY = readerHbaEntry(WORKSPACE_READER_ROLE);

/** Unqualified names resolve to workspace tables first, then custom Database tables. */
export const WORKSPACE_READER_SEARCH_PATH = `public, ${CUSTOM_TABLES_SCHEMA}`;

/** Two per Snaglet process, with room for a second process on a shared cluster. */
export const WORKSPACE_READER_CONNECTION_LIMIT = 4;

/** Extensions whose (pure) functions and operators the reader may call. */
const READABLE_EXTENSIONS = ['vector', 'pg_trgm'] as const;

export type WorkspaceReaderAccess =
  | { readonly access: 'read' }
  | {
      readonly access: 'columns';
      readonly visible: readonly string[];
      readonly hidden: readonly string[];
      readonly reason: string;
    }
  | { readonly access: 'deny'; readonly reason: string };

const READ: WorkspaceReaderAccess = { access: 'read' };

/**
 * Column names treated as secrets inside a `read` table. Anchored at the end
 * so references (`credential_id`) and counters (`input_tokens`) stay visible.
 */
export const SECRET_COLUMN_NAME =
  /(?:^|_)(?:secrets?|passwords?|passwd|passphrase|api_?keys?|private_?keys?|signing_?keys?|(?:access|refresh|id|auth|bearer|session)_?tokens?|token|credentials?|key_hash|password_hash|encrypted|ciphertext|salt|signature)$/;

/** Every `public` relation Snaglet's migrations create, and what the reader may see of it. */
export const WORKSPACE_READER_POLICY: Readonly<Record<string, WorkspaceReaderAccess>> = {
  _migrations: READ,
  agent_activity_log: READ,
  agent_skill_assignments: READ,
  agents: READ,
  automations: READ,
  calendar_events: READ,
  calendars: READ,
  containers: READ,
  doc_edit_state: READ,
  doc_snapshots: READ,
  docs: READ,
  embeddings: READ,
  feature_flags: READ,
  file_embeddings: READ,
  files: READ,
  hook_registrations: READ,
  skill_registry: READ,
  hook_runs: READ,
  images: READ,
  links: READ,
  members: READ,
  memories: READ,
  messages: READ,
  models: READ,
  nodes: READ,
  notifications: READ,
  placement_events: READ,
  provider_auth_types: READ,
  providers: READ,
  reminder_deliveries: READ,
  reminder_settings: READ,
  runs: READ,
  schedule_runs: READ,
  schedules: READ,
  settings: READ,
  subagents: READ,
  table_catalog: READ,
  table_entry_embeddings: READ,
  table_entry_occurrences: READ,
  table_entry_repeats: READ,
  table_fields: READ,
  table_history: READ,
  table_semantic_search: READ,
  thread_notification_settings: READ,
  thread_participants: READ,
  thread_summaries: READ,
  threads: READ,
  tools: READ,

  mcp_servers: {
    access: 'columns',
    visible: [
      'id',
      'provider_id',
      'name',
      'transport',
      'command',
      'scope',
      'enabled',
      'autoload',
      'requires_confirmation',
      'source',
      'created_at',
      'updated_at',
    ],
    hidden: ['args', 'url', 'headers', 'env'],
    reason: 'connection args, URL, headers and env can carry literal tokens',
  },
  users: {
    access: 'columns',
    visible: [
      'id',
      'email',
      'name',
      'picture',
      'auth_provider',
      'created_at',
      'updated_at',
      'active',
    ],
    hidden: ['auth_provider_id'],
    reason: 'the linked OAuth account identifier',
  },

  user_provider_credentials: {
    access: 'deny',
    reason: 'encrypted provider API keys and OAuth tokens',
  },
  provider_fallback_credentials: {
    access: 'deny',
    reason: 'the provider credential fallback chain',
  },
  mcp_api_keys: { access: 'deny', reason: 'MCP API key hashes' },
  socket_sessions: { access: 'deny', reason: 'live socket session ids' },
};

/** What the reader can never see, for tool text and error hints. */
export function hiddenWorkspaceObjects(): { tables: string[]; columns: string[] } {
  const tables: string[] = [];
  const columns: string[] = [];
  for (const [table, policy] of Object.entries(WORKSPACE_READER_POLICY)) {
    if (policy.access === 'deny') tables.push(table);
    if (policy.access === 'columns') columns.push(...policy.hidden.map((c) => `${table}.${c}`));
  }
  return { tables: tables.sort(), columns: columns.sort() };
}

/** Standard double-quote identifier quoting, for catalog names of any shape. */
function quoteIdentifier(name: string): string {
  if (name.length === 0 || name.includes('\0')) throw new Error('Invalid identifier');
  return `"${name.replace(/"/g, '""')}"`;
}

interface PublicRelation {
  name: string;
  kind: string;
  invoker?: boolean;
  columns: string[];
}

const PUBLIC_RELATIONS_SQL = `
  SELECT c.relname::text AS name,
         c.relkind::text AS kind,
         COALESCE(c.reloptions @> ARRAY['security_invoker=true'], false) AS invoker,
         COALESCE(
           array_agg(a.attname::text ORDER BY a.attnum)
             FILTER (WHERE a.attnum > 0 AND NOT a.attisdropped),
           '{}'
         ) AS columns
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
     )
   GROUP BY c.relname, c.relkind, c.reloptions
   ORDER BY c.relname`;

/** The columns of `relation` the reader may SELECT, and the ones it is refused. */
function visibleColumns(relation: PublicRelation): {
  visible: string[] | 'all';
  withheld: string[];
} {
  const policy = WORKSPACE_READER_POLICY[relation.name];
  if (!policy || policy.access === 'deny' || (relation.kind !== 'r' && relation.kind !== 'p')) {
    return { visible: [], withheld: [] };
  }
  if (policy.access === 'read') {
    const withheld = relation.columns.filter((column) => SECRET_COLUMN_NAME.test(column));
    if (withheld.length === 0) return { visible: 'all', withheld };
    return { visible: relation.columns.filter((c) => !withheld.includes(c)), withheld };
  }
  const visible = relation.columns.filter((column) => policy.visible.includes(column));
  const withheld = relation.columns.filter(
    (column) => !policy.visible.includes(column) && !policy.hidden.includes(column)
  );
  return { visible, withheld };
}

export interface WorkspaceReaderProvisioningOptions {
  /** The LOGIN password; it travels as a bound parameter, never as SQL text. */
  password: string;
  /** Database to grant CONNECT and workspace reads on. */
  database: string;
  /** Managed clusters only; see {@link revokePublicDefaults}. */
  revokePublic: boolean;
}

export interface WorkspaceReaderProvisioningReport {
  /** `public` relations hidden because the policy does not name them (or they are not tables). */
  unclassified: string[];
  /** `table.column` pairs hidden because no policy entry says they are safe. */
  withheldColumns: string[];
  /** Policy entries naming a table this database does not have. */
  missing: string[];
}

/**
 * Create or refresh {@link WORKSPACE_READER_ROLE} and rebuild its grants from
 * {@link WORKSPACE_READER_POLICY}. Idempotent; runs in one transaction, so a
 * concurrent reader query sees either the old or the new grants, never a mix.
 * Runs as the connected user, which must be able to create roles (the managed
 * cluster's `snaglet` superuser). Nothing here touches user data.
 */
export async function provisionWorkspaceReaderRole(
  db: ProvisioningQueryable,
  options: WorkspaceReaderProvisioningOptions
): Promise<WorkspaceReaderProvisioningReport> {
  if (!options.password) throw new Error('workspace reader password must not be empty');
  const role = quoteSqlIdentifier(WORKSPACE_READER_ROLE, 'role name');
  return withConcurrentCatalogRetry(() =>
    db.transaction(async (tx) => {
      await ensureReaderLoginRole(tx, {
        role: WORKSPACE_READER_ROLE,
        password: options.password,
        database: options.database,
        connectionLimit: WORKSPACE_READER_CONNECTION_LIMIT,
        settings: [
          'default_transaction_read_only = on',
          "statement_timeout = '5s'",
          "lock_timeout = '1s'",
          "idle_in_transaction_session_timeout = '10s'",
          `search_path = ${WORKSPACE_READER_SEARCH_PATH}`,
        ],
      });
      if (options.revokePublic) await revokePublicDefaults(tx, options.database);

      // Reset everything this role could hold in `public`, then grant from the
      // policy. Revoking a table privilege also revokes its column privileges.
      await tx.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${role}`);
      await tx.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
      await tx.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
      await tx.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);

      const hasTablesSchema = await tx.query<{ present: boolean }>(
        'SELECT to_regnamespace($1) IS NOT NULL AS present',
        [CUSTOM_TABLES_SCHEMA]
      );
      if (hasTablesSchema.rows[0]?.present) {
        const tablesSchema = quoteSqlIdentifier(CUSTOM_TABLES_SCHEMA, 'schema name');
        await tx.query(`GRANT USAGE ON SCHEMA ${tablesSchema} TO ${role}`);
        await tx.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${tablesSchema} TO ${role}`);
        await tx.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${tablesSchema} GRANT SELECT ON TABLES TO ${role}`
        );
      }

      const report: WorkspaceReaderProvisioningReport = {
        unclassified: [],
        withheldColumns: [],
        missing: [],
      };
      const relations = (await tx.query<PublicRelation>(PUBLIC_RELATIONS_SQL)).rows;
      const present = new Set(relations.map((relation) => relation.name));
      for (const relation of relations) {
        const policy = WORKSPACE_READER_POLICY[relation.name];
        if (!policy || (relation.kind !== 'r' && relation.kind !== 'p')) {
          report.unclassified.push(relation.name);
          continue;
        }
        const { visible, withheld } = visibleColumns(relation);
        report.withheldColumns.push(...withheld.map((column) => `${relation.name}.${column}`));
        const table = `public.${quoteIdentifier(relation.name)}`;
        if (visible === 'all') {
          await tx.query(`GRANT SELECT ON ${table} TO ${role}`);
        } else if (visible.length > 0) {
          await tx.query(
            `GRANT SELECT (${visible.map(quoteIdentifier).join(', ')}) ON ${table} TO ${role}`
          );
        }
      }
      report.missing = Object.keys(WORKSPACE_READER_POLICY).filter((name) => !present.has(name));

      // Managed clusters revoke PUBLIC EXECUTE on `public` functions, which
      // includes pgvector's and pg_trgm's operators; give those pure functions back.
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
             WHERE e.extname IN (${READABLE_EXTENSIONS.map((name) => `'${name}'`).join(', ')})
          LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${WORKSPACE_READER_ROLE}', fn);
          END LOOP;
        END
      $snaglet$`
      );
      return report;
    })
  );
}

/** Minimal query surface of a reader connection. */
export interface ReaderSessionQueryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic default mirrors DbClient.query
  query<T = any>(sql: string, params?: ReadonlyArray<unknown>): Promise<{ rows: T[] }>;
}

/** Server-side file, program and admin functions no reader or writer may execute. */
export const FORBIDDEN_FUNCTIONS = [
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'pg_ls_logdir',
  'pg_ls_waldir',
  'pg_ls_tmpdir',
  'pg_ls_archive_statusdir',
  'pg_ls_logicalsnapdir',
  'pg_ls_logicalmapdir',
  'pg_ls_replslotdir',
  'pg_current_logfile',
  'lo_import',
  'lo_export',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_promote',
  'pg_switch_wal',
  'pg_create_restore_point',
  'pg_backup_start',
  'pg_backup_stop',
];

/**
 * Refuse a reader session that could escape its sandbox: a superuser or
 * otherwise elevated role, a member of any other role (it could `SET ROLE`
 * into it), an owner of or writer to any workspace relation, or a role that
 * may execute server-side file/program functions. Runs on the reader
 * connection itself, so it checks exactly the credentials Snaglet will use —
 * including an operator-supplied reader URL.
 */
export async function assertReaderSessionRestricted(
  reader: ReaderSessionQueryable,
  label: string
): Promise<void> {
  const { rows } = await reader.query<{
    role: string;
    elevated: boolean;
    memberships: string[];
    writable: string[];
    functions: string[];
  }>(
    `SELECT r.rolname::text AS role,
            (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication) AS elevated,
            ARRAY(
              SELECT g.rolname::text FROM pg_catalog.pg_roles g
               WHERE g.oid <> r.oid AND pg_catalog.pg_has_role(r.oid, g.oid, 'MEMBER')
               ORDER BY 1
            ) AS memberships,
            ARRAY(
              SELECT (n.nspname || '.' || c.relname)::text
                FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname IN ('public', '${CUSTOM_TABLES_SCHEMA}')
                 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                 AND (c.relowner = r.oid
                      OR pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE'))
               ORDER BY 1 LIMIT 5
            ) AS writable,
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
  if (session.writable.length > 0) {
    problems.push(`it owns or may write ${session.writable.join(', ')}`);
  }
  if (session.functions.length > 0) {
    problems.push(`it may execute ${session.functions.join(', ')}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `${label}: refusing reader role ${session.role}: ${problems.join('; ')}. ` +
        'A reader must be a plain LOGIN role that is a member of nothing.'
    );
  }
}

/**
 * {@link assertReaderSessionRestricted}, plus: the session may SELECT nothing
 * in `public` beyond {@link WORKSPACE_READER_POLICY} — no denied table, hidden
 * or unclassified column, or unlisted relation.
 */
export async function assertWorkspaceReaderRestricted(
  reader: ReaderSessionQueryable
): Promise<void> {
  const label = 'workspace reader';
  await assertReaderSessionRestricted(reader, label);
  const { rows } = await reader.query<{
    name: string;
    kind: string;
    invoker: boolean;
    columns: string[];
  }>(
    `SELECT c.relname::text AS name,
            c.relkind::text AS kind,
         COALESCE(c.reloptions @> ARRAY['security_invoker=true'], false) AS invoker,
            array_agg(a.attname::text ORDER BY a.attnum) AS columns
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND pg_catalog.has_column_privilege(session_user, c.oid, a.attnum, 'SELECT')
      GROUP BY c.relname, c.relkind, c.reloptions`
  );
  const exposed: string[] = [];
  for (const relation of rows) {
    const { visible } = visibleColumns(relation);
    if (visible === 'all') continue;
    const beyond = relation.columns.filter((column) => !visible.includes(column));
    exposed.push(...beyond.map((column) => `${relation.name}.${column}`));
  }
  if (exposed.length > 0) {
    const shown = exposed.slice(0, 10).join(', ');
    throw new Error(
      `${label}: refusing a reader that can SELECT hidden workspace data (${shown}` +
        `${exposed.length > 10 ? `, +${exposed.length - 10} more` : ''}).`
    );
  }
}
