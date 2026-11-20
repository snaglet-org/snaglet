/**
 * Shared provisioning for the non-superuser LOGIN roles that run agent SQL
 * (`snaglet_tables_reader` for `table_read`, `snaglet_workspace_reader` for
 * `database_query`). Each role is the session user of its own pool and a member
 * of nothing, so `SET ROLE` / `set_config('role', …)` cannot climb back to the
 * app user: PostgreSQL checks role membership against the session user.
 */

/**
 * The schema that holds user-created (custom) Database tables. Built-in tables
 * live in `public`. The single source of truth for that name: the readers, the
 * writer, the table catalog and the SQL that addresses custom tables all use it.
 */
export const CUSTOM_TABLES_SCHEMA = 'user_tables';

/** Minimal query surface provisioning needs (a DbClient or a transaction). */
export interface ProvisioningQueryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic default mirrors DbClient.query
  query<T = any>(sql: string, params?: ReadonlyArray<unknown>): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: ProvisioningQueryable) => Promise<T>): Promise<T>;
}

export function quoteSqlIdentifier(name: string, label: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Invalid ${label}: ${name}`);
  return `"${name}"`;
}

export interface ReaderLoginRoleOptions {
  role: string;
  /** The LOGIN password; it travels as a bound parameter, never as SQL text. */
  password: string;
  /** Database the role may CONNECT to (and nothing else on it by default). */
  database: string;
  connectionLimit: number;
  /** Role-level defaults, e.g. `statement_timeout = '5s'`. */
  settings: readonly string[];
}

/**
 * Create or refresh a bounded reader LOGIN role inside `tx`: non-superuser,
 * NOINHERIT, no CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS, the given role
 * defaults, and CONNECT (only) on `database`. Idempotent and safe to run
 * concurrently from several Snaglet processes; the password is reset every time so
 * the role always matches the credential file Snaglet holds.
 */
export async function ensureReaderLoginRole(
  tx: ProvisioningQueryable,
  options: ReaderLoginRoleOptions
): Promise<void> {
  if (!options.password) throw new Error(`${options.role} password must not be empty`);
  if (!Number.isInteger(options.connectionLimit) || options.connectionLimit < 1) {
    throw new Error(`Invalid connection limit for ${options.role}`);
  }
  const role = quoteSqlIdentifier(options.role, 'role name');
  const database = quoteSqlIdentifier(options.database, 'database name');
  // DDL cannot bind parameters; the password crosses into SQL only through a
  // transaction-local GUC, read back inside the DO block.
  await tx.query("SELECT set_config('snaglet.reader_password', $1, true)", [options.password]);
  await tx.query(`DO $snaglet$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${options.role}') THEN
        BEGIN
          EXECUTE 'CREATE ROLE ${role} NOLOGIN';
        EXCEPTION WHEN duplicate_object OR unique_violation THEN
          NULL; -- another session created it first (unique_violation if it was still committing)
        END;
      END IF;
      EXECUTE format(
        'ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${options.connectionLimit} PASSWORD %L',
        current_setting('snaglet.reader_password', true)
      );
    END
  $snaglet$`);
  await tx.query("SELECT set_config('snaglet.reader_password', '', true)");
  for (const setting of options.settings) {
    await tx.query(`ALTER ROLE ${role} SET ${setting}`);
  }
  await tx.query(`REVOKE ALL ON DATABASE ${database} FROM ${role}`);
  await tx.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
}

/**
 * Managed clusters only: strip PUBLIC's default EXECUTE on `public` functions
 * and TEMP on the database, so a SECURITY DEFINER function or a temp object
 * can never widen a reader. Never run on an operator-owned server, where other
 * roles may rely on those defaults.
 */
export async function revokePublicDefaults(
  tx: ProvisioningQueryable,
  databaseName: string
): Promise<void> {
  const database = quoteSqlIdentifier(databaseName, 'database name');
  await tx.query('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC');
  // Global on purpose: a per-schema default only adds to the built-in global
  // default, so it cannot take PUBLIC's EXECUTE away. This covers every
  // function the connected role creates later, in any schema.
  await tx.query('ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
  await tx.query(`REVOKE TEMP ON DATABASE ${database} FROM PUBLIC`);
}

function isConcurrentCatalogUpdate(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === '40001' || code === '40P01' || code === '23505') return true;
  return typeof message === 'string' && /tuple concurrently (updated|deleted)/.test(message);
}

/**
 * Run a provisioning transaction, retrying when another session updated the
 * same shared catalog row (a role is cluster-wide, so two Snaglet processes — or
 * two test databases — provisioning at once collide on `pg_authid`).
 */
export async function withConcurrentCatalogRetry<T>(fn: () => Promise<T>): Promise<T> {
  const attempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (attempt >= attempts || !isConcurrentCatalogUpdate(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.random() * 50));
    }
  }
}

/** Loopback pg_hba entry a reader role needs on the Windows TCP transport. */
export function readerHbaEntry(role: string): string {
  quoteSqlIdentifier(role, 'role name');
  return `host all ${role} 127.0.0.1/32 scram-sha-256`;
}
