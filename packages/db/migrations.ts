import type { DbClient } from './adapters/types';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isCliEntry } from './db-dirname';
import { guardScriptTarget } from './runtime/script-target';
import { closeDatabase, getDbClient } from './db';
import { migrationFiles, resolveMigrationsDir } from './migration-files';
import { userTimeZone } from '@snaglet/shared/utils';
import { DEFAULT_CALENDAR_TITLE } from '@snaglet/shared/types';

// Resolved lazily on first use, not at import time: the staged/bundled package
// layout (e.g. the export smoke test's node_modules of compiled dist) has no
// SQL assets beside the module, so an eager resolveMigrationsDir() would throw
// on import.
let migrationsDirCache: string | null = null;
function migrationsDir(): string {
  migrationsDirCache ??= resolveMigrationsDir();
  return migrationsDirCache;
}

// Forward-only migrations, one numbered SQL file each: `NNNN_name.sql`, applied
// in lexical order. The ledger records what has run; a table that only exists
// after the baseline distinguishes an already-provisioned database from a fresh
// one. The ledger is intentionally separate from any other migration table that
// may share the database.
const LEDGER = 'public._migrations';
const SCHEMA_SENTINEL = 'public.nodes';
const MIGRATION_LOCK_KEY = 'snaglet_migrations';

interface AdvisoryLockClient extends DbClient {
  withAdvisoryLock<T>(key: string, fn: (session: DbClient) => Promise<T>): Promise<T>;
}

function supportsAdvisoryLocks(db: DbClient): db is AdvisoryLockClient {
  return (
    'withAdvisoryLock' in db &&
    typeof (db as Partial<AdvisoryLockClient>).withAdvisoryLock === 'function'
  );
}

async function withMigrationLock<T>(
  db: DbClient,
  fn: (session: DbClient) => Promise<T>
): Promise<T> {
  if (supportsAdvisoryLocks(db)) return db.withAdvisoryLock(MIGRATION_LOCK_KEY, fn);
  return fn(db);
}

async function ensureLedger(db: DbClient): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function appliedNames(db: DbClient): Promise<Set<string>> {
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM ${LEDGER}`);
  return new Set(rows.map((row) => row.name));
}

async function markApplied(db: DbClient, name: string): Promise<void> {
  await db.query(`INSERT INTO ${LEDGER} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
}

async function schemaExists(db: DbClient): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [SCHEMA_SENTINEL]
  );
  return rows[0]?.present ?? false;
}

async function pendingFiles(db: DbClient): Promise<string[]> {
  const applied = await appliedNames(db);
  return migrationFiles().filter((name) => !applied.has(name));
}

async function applyFile(db: DbClient, name: string): Promise<void> {
  // Each file and its ledger entry commit together. In particular, enum
  // additions still commit before the next file can use the new value.
  const sql = readFileSync(join(migrationsDir(), name), 'utf-8');
  await db.transaction(async (tx) => {
    await tx.exec(sql);
    await markApplied(tx, name);
  });
}

/**
 * Pending migration files without writing anything: unlike
 * {@link pendingMigrationCount} it never creates the ledger. A database with no
 * ledger reports every bundled file as pending. Used by `migrate --dry-run`.
 */
export async function pendingMigrationsReadOnly(db: DbClient): Promise<string[]> {
  const { rows } = await db.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [LEDGER]
  );
  if (rows[0]?.present !== true) return migrationFiles();
  return pendingFiles(db);
}

/** Number of migrations not yet recorded in the ledger. */
export async function pendingMigrationCount(db: DbClient): Promise<number> {
  await ensureLedger(db);
  return (await pendingFiles(db)).length;
}

/**
 * Re-run specific bundled migration files by name, without touching the
 * ledger (they are already recorded as applied).
 *
 * Used by a full ("clean slate") database reset: that wipe clears every data
 * table except `_migrations`, so the normal fresh-DB bootstrap never fires
 * again on restart and nothing re-seeds the builtin catalog. Only pass names
 * of files that are safe to replay (i.e. idempotent `ON CONFLICT ... DO
 * NOTHING` / `DO UPDATE` seed scripts) — this does not check idempotency for
 * you. See {@link SEED_REPLAY_FILES} for the vetted list and what excludes a
 * file from it.
 */
export async function reapplySeedFiles(db: DbClient, names: string[]): Promise<void> {
  for (const name of names) {
    await db.exec(readFileSync(join(migrationsDir(), name), 'utf-8'));
  }
}

/**
 * Seed files (under `migrations/seeds/`) that are safe to replay verbatim via
 * {@link reapplySeedFiles} against an already-provisioned database. Order
 * matters: later files' `ON CONFLICT ... DO UPDATE` clauses supersede rows
 * seeded by earlier files. Callers must also run
 * {@link reapplyProviderCatalogSeed} before this list (it seeds the
 * `providers` rows the later files reference) and
 * {@link reapplyLocalModelSeeds} after it — see `DatabaseBackupService.doReset`.
 *
 * The same seed content is in `0001_init.sql`'s built-in rows section, so a
 * fresh install and a reset catalog agree. Once `0001_init.sql` is released it
 * is frozen, so a later change to catalog rows lands in a new numbered
 * migration (fresh and existing databases) and in the seeds file (resets and
 * healing) together.
 *
 * A file qualifies for this list only if all of the following hold against
 * the current schema:
 *   - every statement is an `INSERT ... ON CONFLICT DO NOTHING` (or
 *     `DO UPDATE SET`) seed row, or an UPDATE confined to the builtin rows
 *     it seeds, with no unconditional DELETE/UPDATE/TRUNCATE of unrelated data
 *     and no DDL (the schema belongs to the numbered migrations)
 *   - the file contains no explicit `BEGIN`/`COMMIT`. `reapplySeedFiles` runs
 *     each file inside the caller's own transaction (see
 *     `DatabaseBackupService.doReset`), and PostgreSQL treats a nested
 *     `COMMIT` as a real commit, which would break the atomicity of the reset
 *   - every column it inserts into still exists, and every row it inserts
 *     has not been deleted or superseded by a later migration (this can
 *     drift after the file is added). Verify with
 *     `psql -d snaglet -c '\d public.<table>'` before adding a file here.
 */
export const SEED_REPLAY_FILES: readonly string[] = [
  // snaglet-local runtime provider card (its reranker row is in local-models.sql).
  'seeds/provider-snaglet-local.sql',
  // DeepSeek provider card and auth type.
  'seeds/provider-deepseek.sql',
  // Permanent "ghost" system agent + member. A clean-slate reset wipes the
  // agents/members rows (data), so replay them so ghost always exists to
  // inherit attribution. Its undeletable trigger lives in the schema.
  'seeds/ghost-agent.sql',
  // xAI/Grok provider card + auth type.
  'seeds/provider-xai.sql',
  // Apple on-device provider + auth type + fixed models row (keyless local
  // runtime; ON CONFLICT ... DO NOTHING, so replays are no-ops).
  'seeds/provider-apple-on-device.sql',
  // The cloud provider model catalogs (anthropic, openai, codex, copilot,
  // google, mistral, together, xai, deepseek) — model lists and, load-bearing,
  // their context windows: a model with no catalog row budgets against
  // DEFAULT_CONTEXT_WINDOW (8192). Last in this list because every provider
  // card its rows FK into must already exist. Strict insert-if-absent
  // (`ON CONFLICT DO NOTHING`, no target, no UPDATE anywhere in the file), so
  // replaying it can never reactivate a model the user removed — see the
  // no-resurrect contract at the top of the seed file.
  'seeds/provider-models.sql',
  // Built-in Database table catalog rows (`table-builtin-*`). Upserts builtin
  // rows only; custom rows and their `user_tables` physical tables are never
  // touched. No FKs, so its position is free.
  'seeds/table-catalog.sql',
];

/**
 * Replay `seeds/provider-catalog.sql` — the base provider catalog + auth
 * types — for use by a full ("clean slate") reset and by
 * {@link ensureBuiltinCatalog}, before {@link reapplySeedFiles}: rows in that
 * list reference these providers, which must already exist.
 */
export async function reapplyProviderCatalogSeed(db: DbClient): Promise<void> {
  await reapplySeedFiles(db, ['seeds/provider-catalog.sql']);
}

/**
 * Replay `seeds/local-models.sql` — the local-onnx embedder + MiniLM-L6
 * reranker rows and their catalog retirements — for use by a full ("clean
 * slate") reset and by {@link ensureBuiltinCatalog}, after
 * {@link reapplySeedFiles}'s list (it deactivates rows those files seed).
 */
export async function reapplyLocalModelSeeds(db: DbClient): Promise<void> {
  await reapplySeedFiles(db, ['seeds/local-models.sql']);
}

/** Total row count across the builtin-catalog tables. */
async function catalogRowCount(db: DbClient): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT
       (SELECT COUNT(*) FROM public.providers) +
       (SELECT COUNT(*) FROM public.models) +
       (SELECT COUNT(*) FROM public.mcp_servers) +
       (SELECT COUNT(*) FROM public.table_catalog WHERE origin = 'builtin') AS n`
  );
  return Number(rows[0].n);
}

/**
 * Boot invariant: make sure the builtin catalog (providers, models,
 * mcp_servers, builtin table_catalog rows) is present.
 *
 * `doReset('all')` reseeds the catalog after a clean-slate wipe, but a row
 * can also go missing out of band, and the migration ledger never re-runs the
 * fresh-DB seed path to repair it. Call this once per boot, after migrations
 * are up to date and before any service that resolves catalog rows. The seed
 * steps are idempotent, so an intact catalog is a no-op.
 *
 * Skips (warns, returns false) when migrations are pending: the seeds assume
 * the current schema. Returns true only when a row was restored.
 *
 * Does not open its own transaction: `db` may already be transaction-scoped
 * (e.g. a rollback-only test), and nested transactions are rejected. Each
 * step is idempotent, so a process dying mid-sequence is safe to retry.
 */
export async function ensureBuiltinCatalog(db: DbClient): Promise<boolean> {
  const pending = await pendingMigrationCount(db);
  if (pending > 0) {
    console.warn(
      `[db] Skipping builtin catalog check — ${pending} pending migration(s); run \`pnpm db:migrate\` first`
    );
    return false;
  }

  const before = await catalogRowCount(db);
  await reapplyProviderCatalogSeed(db);
  await reapplySeedFiles(db, [...SEED_REPLAY_FILES]);
  await reapplyLocalModelSeeds(db);
  const after = await catalogRowCount(db);

  const restored = after - before;
  if (restored > 0) {
    console.log(`[db] Builtin catalog check — restored ${restored} missing row(s)`);
  } else {
    console.log('[db] Builtin catalog check — catalog intact (no-op)');
  }
  return restored > 0;
}

/**
 * Provision the database on boot.
 *
 * A fresh database has its migrations applied in order. A database that already
 * carries the schema but no ledger (provisioned before this ledger existed) is
 * adopted — the current migrations are recorded as applied without re-running
 * their DDL. An already-managed database is left untouched; new migrations are
 * surfaced by `pendingMigrationCount()` and applied by `pnpm db:migrate`.
 *
 * Returns true only when a fresh database was provisioned.
 */
async function bootstrapIfFreshUnlocked(db: DbClient): Promise<boolean> {
  await ensureLedger(db);

  const applied = await appliedNames(db);
  if (applied.size > 0) return false;

  const files = migrationFiles();
  if (files.length === 0) return false;

  if (await schemaExists(db)) {
    for (const name of files) await markApplied(db, name);
    return false;
  }

  console.log(`[db] Fresh database — applying ${files.length} migration(s)...`);
  for (const name of files) await applyFile(db, name);
  // Fresh-schema only: never replay on boot, upgrades, adoption or catalog heal.
  const requestedTimeZone = userTimeZone();
  const { rows: timeZones } = await db.query('SELECT name FROM pg_timezone_names WHERE name = $1', [
    requestedTimeZone,
  ]);
  await db.query(
    'INSERT INTO public.calendars(title, time_zone, is_default, sort_order) VALUES ($1, $2, true, 0)',
    [DEFAULT_CALENDAR_TITLE, timeZones.length ? requestedTimeZone : 'UTC']
  );
  // Marks this database as a new install: the server seeds the starter
  // content once from this state (apps/server/src/services/onboarding).
  // A database that predates it never has the row, so it is never seeded.
  await db.query(
    `INSERT INTO public.settings(category, key, value) VALUES ('onboarding', 'seed', $1::jsonb)
     ON CONFLICT (category, key) DO NOTHING`,
    [JSON.stringify({ status: 'pending' })]
  );
  console.log('[db] Schema provisioned');
  return true;
}

export async function bootstrapIfFresh(db: DbClient): Promise<boolean> {
  return withMigrationLock(db, bootstrapIfFreshUnlocked);
}

/** Apply every migration not yet recorded. Driven by `pnpm db:migrate`. */
export interface ApplyPendingMigrationsOptions {
  beforeApply?: (pending: readonly string[]) => Promise<void>;
  /** Runs still holding the migration lock, only once every migration succeeded. */
  afterApply?: () => Promise<void>;
  rejectUnknownMigrations?: boolean;
}

async function applyPendingMigrationsUnlocked(
  db: DbClient,
  options: ApplyPendingMigrationsOptions
): Promise<void> {
  await ensureLedger(db);
  const pending = await pendingFiles(db);
  if (options.rejectUnknownMigrations) {
    const known = new Set(migrationFiles());
    const unknown = [...(await appliedNames(db))].filter((name) => !known.has(name));
    if (unknown.length > 0)
      throw new Error(
        `[db] This database contains migrations from a newer or different Snaglet build (${unknown.join(', ')}). Install the matching or newer Snaglet version; refusing schema downgrade.`
      );
  }
  if (pending.length > 0) await options.beforeApply?.(pending);
  if (pending.length === 0) {
    console.log('[db] No pending migrations');
    return;
  }

  console.log(`[db] Applying ${pending.length} migration(s)...`);
  for (const name of pending) {
    try {
      await applyFile(db, name);
      console.log(`  ✓ ${name}`);
    } catch (error) {
      console.error(`  ✗ ${name}`);
      throw error;
    }
  }
}

export async function applyPendingMigrations(
  db: DbClient,
  options: ApplyPendingMigrationsOptions = {}
): Promise<void> {
  await withMigrationLock(db, async (session) => {
    await applyPendingMigrationsUnlocked(session, options);
    await options.afterApply?.();
  });
}

/** Create the next numbered migration file and return its path. */
export async function createMigration(name: string): Promise<string> {
  const files = migrationFiles();
  const lastNumber = files.length ? parseInt(files[files.length - 1].slice(0, 4), 10) : 0;
  const prefix = String(lastNumber + 1).padStart(4, '0');
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  const filepath = join(migrationsDir(), `${prefix}_${slug}.sql`);
  writeFileSync(filepath, `-- ${name}\n`);
  return filepath;
}

// `pnpm db:migrate` runs this file directly to apply pending migrations. The
// target guard runs first, before anything connects. isCliEntry is
// structural: inside the server bundle the entry is server.mjs, so the packaged
// server never reaches this block (it migrates via initializeDatabase), and no
// env var (SNAGLET_BUNDLED included) can skip the guard from a checkout.
if (isCliEntry(import.meta.url, 'migrations')) {
  void (async () => {
    const target = guardScriptTarget('migrate');
    if (!target) return; // refused: exit code 2, nothing opened
    let exitCode = 0;
    try {
      const db = await getDbClient();
      const pending = await pendingMigrationsReadOnly(db);
      console.error(`[db] pending : ${pending.length > 0 ? pending.join(', ') : 'none'}`);
      if (!target.dryRun) await applyPendingMigrations(db);
    } catch (error: unknown) {
      console.error(error);
      exitCode = 1;
    }
    try {
      await closeDatabase();
    } catch (error: unknown) {
      console.error('Failed to close database:', error);
      exitCode = 1;
    }
    process.exitCode = exitCode;
  })();
}
