import { createHash, randomUUID } from 'crypto';
import { mkdir, readdir, readFile, writeFile, stat, unlink, rename } from 'fs/promises';
import path from 'path';
import {
  getDb,
  getDbClient,
  transaction,
  getBackupAdapter,
  resolveDatabaseMode,
} from '@snaglet/db/db';
import type { BackupArtifactFormat, BackupEngine } from '@snaglet/db/adapters';
import {
  pendingMigrationCount,
  reapplySeedFiles,
  reapplyProviderCatalogSeed,
  reapplyLocalModelSeeds,
  SEED_REPLAY_FILES,
} from '@snaglet/db/migrations';
import { resolveDbHome } from '@snaglet/db/runtime/snaglet-home';
import {
  preMigrationCheckpointDir,
  summarizePreMigrationCheckpoints,
  type CheckpointSummary,
} from '@snaglet/db/runtime/postgres/pre-migration-checkpoints';
import { PRE_UPDATE_SNAPSHOT_RETENTION } from '@snaglet/shared/constants/backups';
import { formatBytes, getErrorMessage, isoNow, safeJsonParse } from '@snaglet/shared/utils';
import { expandHomePath } from '@snaglet/shared/utils/paths';
import { logger } from '@server/config/logger';
import { SNAGLET_BACKUPS_DIR } from '@server/services/snagletHome';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { renewWorkspaceId } from '@server/services/workspaceId';

/**
 * DatabaseBackupService — snapshot / restore / clean-slate for the Snaglet Postgres
 * database, driven from the Settings → Database UI.
 *
 *  - Snapshot: `pg_dump -Fc` of the whole DB to ~/.snaglet/backups/<id>.dump plus a
 *    JSON manifest sidecar.
 *  - Restore: load into a scratch database, validate it, then atomically swap
 *    database names while retaining the original until confirmation.
 *  - Reset (clean slate): selective wipe that keeps the schema and preserves
 *    config rows (user/providers/credentials/models/settings) while deleting
 *    all workspace content. Always recoverable from a snapshot.
 *
 * Mirrors EmbeddingReembedService: a single in-memory job at a time + a status
 * getter the route polls. Only one destructive/backup op runs at once.
 */

/** Tables whose rows survive a content-only reset (infrastructure + history). */
const PRESERVE_TABLES: ReadonlySet<string> = new Set([
  'users',
  'mcp_servers',
  'providers',
  'provider_auth_types',
  'provider_fallback_credentials',
  'user_provider_credentials',
  'models',
  'settings',
  // Product switches such as hub_home (the Home pane); config, not content.
  'feature_flags',
  '_migrations',
  'table_catalog',
  'table_fields',
  'table_history',
  'table_entry_repeats',
  'table_entry_occurrences',
]);

/**
 * Never wiped, even on a full ('all') reset. Table and field catalogs (and the table undo
 * history, which holds deleted tables and fields) stay with the
 * migration ledger because the reset only reaches `public`: custom tables live
 * in `user_tables` and survive, so their catalog rows must survive with them
 * (builtin rows are re-healed by seed replay either way).
 */
const ALWAYS_PRESERVE: ReadonlySet<string> = new Set([
  '_migrations',
  'table_catalog',
  'table_fields',
  'table_history',
  // Per-row repeat rules and the occurrence log belong to the user_tables rows
  // that survive the reset, so they survive with them.
  'table_entry_repeats',
  'table_entry_occurrences',
]);

// SNAGLET_BACKUPS_DIR is `~`-expanded (dotenv delivers `~/...` literally); the
// default already derives from the strictly validated SNAGLET_HOME.
const ENV_BACKUPS_DIR = process.env.SNAGLET_BACKUPS_DIR?.trim();
const BACKUPS_DIR = ENV_BACKUPS_DIR ? expandHomePath(ENV_BACKUPS_DIR) : SNAGLET_BACKUPS_DIR;

export type ResetScope = 'content' | 'all';
export type SnapshotKind = 'manual' | 'pre-reset' | 'pre-restore' | 'pre-migration' | 'auto';
export type DbJobKind = 'snapshot' | 'restore' | 'reset';

export interface SnapshotManifest {
  id: string;
  label: string;
  createdAt: string;
  sizeBytes: number;
  dbName: string;
  kind: SnapshotKind;
  engine: BackupEngine;
  format: BackupArtifactFormat;
  fileName: string;
  legacy: boolean;
  restorable: boolean;
}

export interface DbJobStatus {
  running: boolean;
  jobId: string | null;
  kind: DbJobKind | null;
  /** Human-readable current phase, e.g. "Creating snapshot…". */
  phase: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** True after a restore/reset — server caches are stale, recommend restart. */
  requiresRestart: boolean;
  /** Last snapshot id produced by this job (manual snapshot or pre-op backup). */
  lastSnapshotId: string | null;
}

const INITIAL_STATUS: DbJobStatus = {
  running: false,
  jobId: null,
  kind: null,
  phase: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  requiresRestart: false,
  lastSnapshotId: null,
};

let status: DbJobStatus = { ...INITIAL_STATUS };

function cloneStatus(input: DbJobStatus): DbJobStatus {
  return { ...input };
}

export function isDbJobRunning(): boolean {
  return status.running;
}

export function getDbJobStatus(): DbJobStatus {
  return cloneStatus(status);
}

async function ensureBackupsDir(): Promise<void> {
  await mkdir(BACKUPS_DIR, { recursive: true });
}

function defaultArtifactFileName(id: string, format: BackupArtifactFormat): string {
  return format === 'plain-gzip' ? `${id}.sql.gz` : `${id}.dump`;
}

function manifestPathFor(id: string): string {
  return path.join(BACKUPS_DIR, `${id}.json`);
}

function artifactPathFor(manifest: Pick<SnapshotManifest, 'fileName'>): string {
  if (path.basename(manifest.fileName) !== manifest.fileName) {
    throw new Error(`Invalid snapshot artifact filename: ${manifest.fileName}`);
  }
  return path.join(BACKUPS_DIR, manifest.fileName);
}

function normalizeManifest(input: Partial<SnapshotManifest>): SnapshotManifest | null {
  if (
    typeof input.id !== 'string' ||
    typeof input.label !== 'string' ||
    typeof input.createdAt !== 'string' ||
    typeof input.kind !== 'string'
  ) {
    return null;
  }
  const engine: BackupEngine = input.engine === 'postgres' ? 'postgres' : 'legacy-embedded';
  const format: BackupArtifactFormat =
    input.format === 'custom' || input.format === 'plain-gzip' ? input.format : 'legacy-embedded';
  const fileName =
    typeof input.fileName === 'string' && path.basename(input.fileName) === input.fileName
      ? input.fileName
      : defaultArtifactFileName(input.id, format);
  const legacy = engine === 'legacy-embedded' || format === 'legacy-embedded';
  return {
    id: input.id,
    label: input.label,
    createdAt: input.createdAt,
    sizeBytes: typeof input.sizeBytes === 'number' ? input.sizeBytes : 0,
    dbName: typeof input.dbName === 'string' ? input.dbName : legacy ? 'embedded' : 'snaglet',
    kind: input.kind as SnapshotKind,
    engine,
    format,
    fileName,
    legacy,
    restorable: !legacy,
  };
}

async function loadSnapshotManifest(id: string): Promise<SnapshotManifest> {
  const raw = await readFile(manifestPathFor(id), 'utf8').catch(() => null);
  // A corrupt manifest degrades to the same not-found path as a missing one.
  const parsed = raw ? safeJsonParse<Partial<SnapshotManifest> | null>(raw, null) : null;
  const manifest = parsed ? normalizeManifest(parsed) : null;
  if (!manifest || manifest.id !== id) throw new Error(`Snapshot not found: ${id}`);
  return manifest;
}

/** Filesystem-safe stamp derived from an ISO timestamp. */
function stampFrom(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

function defaultLabel(iso: string): string {
  return `Snapshot ${iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`;
}

/** Snapshot ids are app-generated; anything else could reach outside BACKUPS_DIR. */
const SNAPSHOT_ID = /^[A-Za-z0-9._-]+$/;

interface ManifestEntry {
  manifest: SnapshotManifest;
  /** The manifest's own file name in BACKUPS_DIR. */
  file: string;
}

export async function listSnapshots(): Promise<SnapshotManifest[]> {
  return (await readManifestEntries()).map((entry) => entry.manifest);
}

async function readManifestEntries(): Promise<ManifestEntry[]> {
  await ensureBackupsDir();
  const entries = await readdir(BACKUPS_DIR);
  const manifests: ManifestEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(path.join(BACKUPS_DIR, name), 'utf8');
      const parsed = normalizeManifest(JSON.parse(raw) as Partial<SnapshotManifest>);
      if (!parsed) continue;
      // Keep size fresh from disk in case the manifest was written before flush.
      try {
        const st = await stat(artifactPathFor(parsed));
        parsed.sizeBytes = st.size;
      } catch {
        // dump missing — skip orphaned manifest
        continue;
      }
      manifests.push({ manifest: parsed, file: name });
    } catch (err) {
      logger.warn('[db-backup] skipping unreadable manifest', {
        name,
        error: getErrorMessage(err),
      });
    }
  }
  manifests.sort((a, b) => (a.manifest.createdAt < b.manifest.createdAt ? 1 : -1));
  return manifests;
}

export async function readSnapshotArtifact(id: string): Promise<{
  buffer: Buffer;
  fileName: string;
  contentType: string;
}> {
  if (!SNAPSHOT_ID.test(id)) throw new Error(`Invalid snapshot id: ${id}`);
  const manifest = await loadSnapshotManifest(id);
  return {
    buffer: await readFile(artifactPathFor(manifest)),
    fileName: manifest.fileName,
    contentType: manifest.format === 'plain-gzip' ? 'application/gzip' : 'application/octet-stream',
  };
}

export async function deleteSnapshot(id: string): Promise<void> {
  // Guard against path traversal — ids are app-generated.
  if (!SNAPSHOT_ID.test(id)) {
    throw new Error(`Invalid snapshot id: ${id}`);
  }
  let manifest: SnapshotManifest | null = null;
  try {
    manifest = await loadSnapshotManifest(id);
  } catch {
    // Unknown/old metadata is treated as legacy and retained, never unlinked.
  }
  if (!manifest || manifest.legacy) {
    const suffix = `.legacy-retained-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    for (const target of [
      manifest ? artifactPathFor(manifest) : path.join(BACKUPS_DIR, `${id}.dump`),
      manifestPathFor(id),
    ]) {
      await rename(target, `${target}${suffix}`).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    logger.info('[db-backup] legacy embedded snapshot parked instead of deleted', { id });
    return;
  }
  await unlink(artifactPathFor(manifest)).catch((err) => {
    logger.warn(`[db-backup] failed to delete snapshot artifact: ${getErrorMessage(err)}`, { id });
  });
  await unlink(manifestPathFor(id)).catch((err) => {
    logger.warn(`[db-backup] failed to delete snapshot manifest: ${getErrorMessage(err)}`, { id });
  });
}

// Dump/restore routes through the active BackupAdapter. This service owns
// manifests, retention, and job state; the adapter owns engine commands and
// the PostgreSQL validate-before-swap protocol.
async function doSnapshot(
  label: string | undefined,
  kind: SnapshotKind,
  requestedFormat: Exclude<BackupArtifactFormat, 'legacy-embedded'> = 'custom'
): Promise<SnapshotManifest> {
  await ensureBackupsDir();
  const adapter = await getBackupAdapter();
  const format: BackupArtifactFormat = requestedFormat;
  const dbName =
    (
      await (
        await getDbClient()
      ).query<{ database: string }>('SELECT current_database() AS database')
    ).rows[0]?.database ?? 'snaglet';
  const createdAt = isoNow();
  const id = `snaglet-${dbName}-${stampFrom(createdAt)}-${randomUUID().slice(0, 8)}`;
  const fileName = defaultArtifactFileName(id, format);
  const dumpPath = path.join(BACKUPS_DIR, fileName);

  const buffer = await adapter.dump({ format });
  await writeFile(dumpPath, buffer);

  // Integrity gate: verify the bytes on disk match what the
  // adapter produced — a truncated/partial dump discovered at restore time
  // is the worst possible moment.
  const written = await readFile(dumpPath);
  const wantHash = createHash('sha256').update(buffer).digest('hex');
  const gotHash = createHash('sha256').update(written).digest('hex');
  if (buffer.byteLength === 0 || gotHash !== wantHash) {
    await unlink(dumpPath).catch((err) => {
      logger.warn(`[db-backup] failed to remove corrupt dump: ${getErrorMessage(err)}`, {
        dumpPath,
      });
    });
    throw new Error(
      `snapshot integrity check failed (${buffer.byteLength} bytes, sha256 ${wantHash.slice(0, 12)}… vs ${gotHash.slice(0, 12)}…)`
    );
  }

  const st = await stat(dumpPath);
  const manifest: SnapshotManifest = {
    id,
    label: label?.trim() || defaultLabel(createdAt),
    createdAt,
    sizeBytes: st.size,
    dbName,
    kind,
    engine: 'postgres',
    format,
    fileName,
    legacy: false,
    restorable: true,
  };
  await writeFile(manifestPathFor(id), JSON.stringify(manifest, null, 2), 'utf8');
  logger.info('[db-backup] snapshot created', { id, sizeBytes: manifest.sizeBytes, kind });
  return manifest;
}

async function doRestore(id: string): Promise<void> {
  const manifest = await loadSnapshotManifest(id);
  if (manifest.legacy || !manifest.restorable) {
    throw new Error(
      'Legacy embedded snapshots are retained but cannot be restored by this release'
    );
  }
  const dumpPath = artifactPathFor(manifest);
  await stat(dumpPath); // throws if missing
  const buffer = await readFile(dumpPath);

  // PostgreSQL restore validates a scratch database before quiescing the live
  // pool and swapping database names. Surface failures directly; the adapter
  // either reconnects the restored database or rolls back to the parked one.
  const adapter = await getBackupAdapter();
  if (adapter.engine !== 'postgres') {
    throw new Error('PostgreSQL snapshots can only be restored into PostgreSQL');
  }
  await adapter.restore(buffer, { format: manifest.format });

  logger.info('[db-backup] restore complete', { id, engine: manifest.engine });
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface PreservedFk {
  table_name: string;
  column_name: string;
  foreign_table_name: string;
  is_nullable: string;
}

async function doReset(scope: ResetScope): Promise<void> {
  // The catalog reads (information_schema lookups) don't
  // need transactional scope and stay on the pool; only the destructive
  // section runs through `transaction()`, which routes through the active
  // DbClient adapter.
  const pool = getDb();
  const { rows: tableRows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  const allTables = tableRows.map((r) => r.table_name);
  const preserve = scope === 'all' ? ALWAYS_PRESERVE : PRESERVE_TABLES;
  const contentTables = allTables.filter((t) => !preserve.has(t));
  const contentSet = new Set(contentTables);

  // Single-column FKs from a preserved table into a content table — these
  // would dangle once content is wiped, so we NULL them first. (Composite
  // FKs don't exist in this schema; the single-column join is sufficient.)
  const { rows: fkRows } = await pool.query<PreservedFk>(
    `SELECT tc.table_name,
            kcu.column_name,
            ccu.table_name AS foreign_table_name,
            col.is_nullable
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     JOIN information_schema.columns col
       ON col.table_schema = tc.table_schema
      AND col.table_name = tc.table_name
      AND col.column_name = kcu.column_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`
  );
  const preservedToContent = fkRows.filter(
    (r) => preserve.has(r.table_name) && contentSet.has(r.foreign_table_name)
  );
  const blocking = preservedToContent.filter((r) => r.is_nullable !== 'YES');
  if (blocking.length > 0) {
    throw new Error(
      `Cannot preserve config: NOT NULL foreign key(s) reference content tables: ${blocking
        .map((r) => `${r.table_name}.${r.column_name} -> ${r.foreign_table_name}`)
        .join(', ')}`
    );
  }

  await transaction(async (client) => {
    // Disable the 23 row triggers + FK enforcement for this session so the
    // wipe is fast and doesn't fire archive/cascade logic. (Requires the
    // connection role to be a superuser/owner — true for local dev.)
    await client.query('SET LOCAL session_replication_role = replica');

    for (const fk of preservedToContent) {
      await client.query(
        `UPDATE public.${quoteIdent(fk.table_name)} SET ${quoteIdent(fk.column_name)} = NULL
         WHERE ${quoteIdent(fk.column_name)} IS NOT NULL`
      );
    }
    for (const table of contentTables) {
      await client.query(`DELETE FROM public.${quoteIdent(table)}`);
    }

    await client.query('SET LOCAL session_replication_role = origin');

    // A full ('all') reset wipes the builtin catalog too (providers, models,
    // mcp_servers, ...) since only `_migrations` survives — and because the
    // migration ledger is untouched, the normal boot-time migration runner
    // sees a non-fresh DB and never re-applies any seed inserts. Without this,
    // "clean slate" would leave the workspace with no LLM providers, no MCP
    // servers (playwright/notion/github), and — critically — no `models`
    // rows at all: the local embedder, reranker, and query extractor
    // pipelines resolve their models by row, and `embeddings.model_id` FKs
    // into `models`, so a zero-row catalog silently kills local retrieval.
    //
    // Three functions, run in order — see each one's doc comment in
    // packages/db/migrations.ts:
    //   1. reapplyProviderCatalogSeed — seeds/provider-catalog.sql; must run
    //      before the mcp-servers seed below, which resolves providers.id by
    //      FK lookup.
    //   2. reapplySeedFiles(SEED_REPLAY_FILES) — the replayable seed files
    //      under packages/db/migrations/seeds/.
    //   3. reapplyLocalModelSeeds — seeds/local-models.sql (the local
    //      embedder + L6 reranker rows and their catalog retirements).
    if (scope === 'all') {
      await reapplyProviderCatalogSeed(client);
      await reapplySeedFiles(client, [...SEED_REPLAY_FILES]);
      await reapplyLocalModelSeeds(client);
    }
  });

  // Tools are workspace nodes, so both reset scopes delete their database
  // rows. Startup normally syncs the filesystem-backed builtin registry, but
  // a reset happens while the server is already running. Re-sync here so the
  // clean database is usable immediately and does not depend on a restart to
  // recover its builtin tools.
  await toolRegistry.load();
  const toolSync = await toolRegistry.syncToDatabase();
  if (toolSync.errors.length > 0) {
    throw new Error(`Failed to reseed builtin tools: ${toolSync.errors.join('; ')}`);
  }

  logger.info('[db-backup] reset complete', { scope, wiped: contentTables.length });
}

function beginJob(kind: DbJobKind): string {
  if (status.running) {
    throw new Error('A database job is already running');
  }
  const jobId = randomUUID();
  status = {
    running: true,
    jobId,
    kind,
    phase: null,
    startedAt: isoNow(),
    finishedAt: null,
    error: null,
    requiresRestart: false,
    lastSnapshotId: null,
  };
  return jobId;
}

function setPhase(jobId: string, phase: string): void {
  if (status.jobId === jobId) status.phase = phase;
}

function finishJob(jobId: string, patch: Partial<DbJobStatus>): void {
  if (status.jobId !== jobId) return;
  status = {
    ...status,
    ...patch,
    running: false,
    phase: null,
    finishedAt: isoNow(),
  };
}

export function startSnapshot(
  label?: string,
  format: Exclude<BackupArtifactFormat, 'legacy-embedded'> = 'custom'
): DbJobStatus {
  const jobId = beginJob('snapshot');
  void (async () => {
    try {
      setPhase(
        jobId,
        format === 'plain-gzip' ? 'Creating portable SQL export…' : 'Creating snapshot…'
      );
      const manifest = await doSnapshot(label, 'manual', format);
      finishJob(jobId, { lastSnapshotId: manifest.id });
    } catch (err) {
      finishJob(jobId, { error: getErrorMessage(err, 'Snapshot failed') });
      logger.error('[db-backup] snapshot job failed', { error: getErrorMessage(err) });
    }
  })();
  return cloneStatus(status);
}

/**
 * A reset or restore replaced the workspace content, so it gets a new id and
 * windows stop restoring panes saved for the old content. The content change
 * already happened, so a failure here is logged and the job still succeeds;
 * the windows then keep their layouts.
 */
async function renewWorkspaceIdAfter(kind: 'reset' | 'restore'): Promise<void> {
  try {
    await renewWorkspaceId();
  } catch (err) {
    logger.warn(`[db-backup] could not renew the workspace id after the ${kind}`, {
      error: getErrorMessage(err),
    });
  }
}

export function startReset(opts: { createBackup?: boolean; scope?: ResetScope }): DbJobStatus {
  const createBackup = opts.createBackup !== false;
  const scope: ResetScope = opts.scope === 'all' ? 'all' : 'content';
  const jobId = beginJob('reset');
  void (async () => {
    try {
      let lastSnapshotId: string | null = null;
      if (createBackup) {
        setPhase(jobId, 'Backing up before reset…');
        const manifest = await doSnapshot(undefined, 'pre-reset');
        lastSnapshotId = manifest.id;
      }
      setPhase(jobId, scope === 'all' ? 'Wiping all data…' : 'Wiping workspace content…');
      await doReset(scope);
      await renewWorkspaceIdAfter('reset');
      finishJob(jobId, { lastSnapshotId, requiresRestart: true });
    } catch (err) {
      finishJob(jobId, { error: getErrorMessage(err, 'Reset failed') });
      logger.error('[db-backup] reset job failed', { error: getErrorMessage(err) });
    }
  })();
  return cloneStatus(status);
}

export function startRestore(id: string): DbJobStatus {
  const jobId = beginJob('restore');
  void (async () => {
    try {
      const target = await loadSnapshotManifest(id);
      if (target.legacy || !target.restorable) {
        throw new Error(
          'Legacy embedded snapshots are retained but cannot be restored by this release'
        );
      }
      setPhase(jobId, 'Backing up current state…');
      const pre = await doSnapshot(undefined, 'pre-restore');
      setPhase(jobId, 'Restoring snapshot…');
      await doRestore(id);
      await renewWorkspaceIdAfter('restore');
      finishJob(jobId, { lastSnapshotId: pre.id, requiresRestart: true });
    } catch (err) {
      finishJob(jobId, { error: getErrorMessage(err, 'Restore failed') });
      logger.error('[db-backup] restore job failed', { id, error: getErrorMessage(err) });
    }
  })();
  return cloneStatus(status);
}

export interface SnapshotPruneResult {
  removed: string[];
  bytesFreed: number;
}

/**
 * Whether a snapshot's files are its own to delete: a safe id, the manifest
 * named `<id>.json`, and the dump named for the same id, as doSnapshot writes
 * them. A copied or hand-edited manifest fails and is never pruned.
 */
function isOwnSnapshot({ manifest, file }: ManifestEntry): boolean {
  return (
    SNAPSHOT_ID.test(manifest.id) &&
    file === `${manifest.id}.json` &&
    manifest.fileName === defaultArtifactFileName(manifest.id, manifest.format)
  );
}

/** Retention policy for automatic snapshots:
 *  - 'auto' (historical only — older releases produced these from a daily
 *    timer and on clean shutdown; nothing creates them anymore): one per day
 *    for 7 days, then one per week for 4 weeks; the rest deleted.
 *  - 'pre-migration': the newest PRE_UPDATE_SNAPSHOT_RETENTION kept
 *    unconditionally — they are the rollback lifeline for recent upgrades and
 *    never compete with the daily pool. `justTaken` (this boot's snapshot) is
 *    always kept, and nothing newer than it is removed.
 *  Manual / pre-reset / pre-restore snapshots are never auto-pruned. Run it
 *  only after the boot's migrations succeeded. A snapshot that cannot be
 *  removed is logged and skipped; the next boot retries it. */
export async function pruneAutomaticSnapshots(
  options: { justTaken?: Pick<SnapshotManifest, 'id' | 'createdAt'> | null } = {}
): Promise<SnapshotPruneResult> {
  // One entry per id, from manifests the pruner may delete. A copied manifest
  // file shares its id and must not take a second retention slot; an id that
  // is not its manifest's own name could point outside BACKUPS_DIR.
  const byId = new Map<string, SnapshotManifest>();
  for (const entry of await readManifestEntries()) {
    const m = entry.manifest;
    if (m.legacy || (m.kind !== 'auto' && m.kind !== 'pre-migration')) continue;
    if (!isOwnSnapshot(entry)) {
      logger.warn(`[db-backup] not pruning ${entry.file}: its id does not match its file names`);
      continue;
    }
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  const all = [...byId.values()];
  const newestFirst = (a: SnapshotManifest, b: SnapshotManifest) =>
    a.createdAt < b.createdAt ? 1 : -1;
  const autos = all.filter((m) => !m.legacy && m.kind === 'auto').sort(newestFirst);
  const preMigrations = all
    .filter((m) => !m.legacy && m.kind === 'pre-migration')
    .sort(newestFirst);
  const justTaken = options.justTaken ?? null;

  const keep = new Set<string>();
  for (const m of preMigrations.slice(0, PRE_UPDATE_SNAPSHOT_RETENTION)) keep.add(m.id);
  if (justTaken) {
    keep.add(justTaken.id);
    // A clock change can stamp an older snapshot later; keep it rather than
    // risk deleting anything newer than this boot's snapshot.
    for (const m of preMigrations) if (m.createdAt >= justTaken.createdAt) keep.add(m.id);
  }

  const dailySeen = new Set<string>();
  const weeklySeen = new Set<string>();
  const now = Date.now();
  for (const m of autos) {
    const created = new Date(m.createdAt);
    const ageDays = (now - created.getTime()) / 86_400_000;
    const dayKey = m.createdAt.slice(0, 10);
    if (ageDays <= 7) {
      if (!dailySeen.has(dayKey)) {
        dailySeen.add(dayKey);
        keep.add(m.id);
      }
    } else if (ageDays <= 7 + 28 && weeklySeen.size < 4) {
      const weekKey = `w${Math.floor(created.getTime() / (7 * 86_400_000))}`;
      if (!weeklySeen.has(weekKey)) {
        weeklySeen.add(weekKey);
        keep.add(m.id);
      }
    }
  }
  const result: SnapshotPruneResult = { removed: [], bytesFreed: 0 };
  for (const m of [...autos, ...preMigrations]) {
    if (keep.has(m.id)) continue;
    try {
      // The manifest goes only once the dump is gone, so a dump that could not
      // be removed stays listed and is retried rather than orphaned.
      await unlink(artifactPathFor(m));
      await unlink(manifestPathFor(m.id)).catch((err: unknown) => {
        logger.warn(`[db-backup] failed to delete snapshot manifest: ${getErrorMessage(err)}`, {
          id: m.id,
        });
      });
      result.removed.push(m.id);
      result.bytesFreed += m.sizeBytes;
    } catch (err) {
      logger.warn(`[db-backup] could not prune snapshot ${m.id}: ${getErrorMessage(err)}`);
    }
  }
  if (result.removed.length > 0) {
    logger.info(
      `[db-backup] pruned ${result.removed.length} automatic snapshot(s), freed ` +
        `${formatBytes(result.bytesFreed)}: ${result.removed.join(', ')}`
    );
  }
  return result;
}

/**
 * Whether this boot's `initializeDatabase()` applies pending migrations. Only
 * a Snaglet-owned managed cluster (the packaged app: SNAGLET_PG_OWNED=1) upgrades at
 * boot; source checkouts and external databases leave them pending until an
 * explicit `pnpm db:migrate`. Mirrors the branch in packages/db
 * `initializeDatabase()`.
 */
export function bootAppliesPendingMigrations(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveDatabaseMode(env) === 'managed' && env.SNAGLET_PG_OWNED === '1';
}

export interface PreMigrationBackupOptions {
  /** Whether migrations are about to be applied; defaults to what this boot will do. */
  migrationsWillApply?: boolean;
}

/**
 * Pre-migration safety backup (part of the upgrade path). Call before
 * initializeDatabase(): when that boot is about to apply pending schema
 * migrations, snapshot first so a failed upgrade is recoverable.
 *
 * No snapshot on fresh databases (nothing to lose), when nothing is pending,
 * or when this boot will not apply what is pending — a source checkout keeps
 * migrations pending across dev restarts until `pnpm db:migrate`, so a dump
 * at boot would repeat on every restart without protecting the later migrate.
 * Nothing is pruned here: boot calls pruneAutomaticSnapshots() once
 * initializeDatabase() has succeeded.
 */
export async function preMigrationBackupIfNeeded(
  options: PreMigrationBackupOptions = {}
): Promise<SnapshotManifest | null> {
  const migrationsWillApply = options.migrationsWillApply ?? bootAppliesPendingMigrations();
  const db = await getDbClient();
  // A brand-new PostgreSQL database has every bundled migration "pending" but
  // no user state to protect. Detect that case before pendingMigrationCount()
  // creates the ledger; bootstrapIfFresh() will provision it immediately.
  const { rows: schemaRows } = await db.query<{ schema_sentinel: string | null }>(
    `SELECT to_regclass('public.nodes')::text AS schema_sentinel`
  );
  if (!schemaRows[0]?.schema_sentinel) return null;

  const pending = await pendingMigrationCount(db);
  if (pending === 0) return null;
  if (!migrationsWillApply) {
    logger.info(
      `[db-backup] ${pending} schema migration(s) pending but not applied at boot — ` +
        'no pre-migration snapshot (take one before running `pnpm db:migrate`)'
    );
    return null;
  }
  logger.info('[db-backup] pending schema migrations — taking pre-migration snapshot', {
    pending,
  });
  return doSnapshot(`Before ${pending} migration(s)`, 'pre-migration');
}

/**
 * The packaged app's own pre-update checkpoints (`backups/pre-migration/`,
 * written by the database upgrade, not listed as snapshots): how many there
 * are and their size, for Settings → Backups.
 */
export function getPreUpdateCheckpointSummary(): Promise<CheckpointSummary> {
  return summarizePreMigrationCheckpoints(preMigrationCheckpointDir(resolveDbHome()));
}
