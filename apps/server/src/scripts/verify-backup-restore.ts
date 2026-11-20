/**
 * Real managed-PostgreSQL backup/restore proof. Uses an isolated Snaglet home,
 * exercises the server backup service (manifest + job orchestration), verifies
 * a database rename swap through the stable getDb() facade, and checks the
 * portable plain-SQL gzip export.
 */

export {};

async function main(): Promise<void> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { gunzip } = await import('node:zlib');
  const { promisify } = await import('node:util');

  const scratch = await mkdtemp(join(tmpdir(), 'snaglet-backup-proof-'));
  const snagletHome = join(scratch, 'home');
  process.env.NODE_ENV = 'test';
  process.env.SNAGLET_HOME = snagletHome;
  process.env.SNAGLET_BACKUPS_DIR = join(scratch, 'backups');
  process.env.SNAGLET_DB_MODE = 'managed';

  const { closeDatabase, getDb, initializeDatabase } = await import('@snaglet/db/db');
  const { PostgresRuntime } = await import('@snaglet/db/runtime/postgres/runtime');
  const { Threads } = await import('@snaglet/db/tables/threads');
  const { Messages } = await import('@snaglet/db/tables/messages');
  const { Users } = await import('@snaglet/db/tables/users');
  const { getErrorMessage, vectorLiteral } = await import('@snaglet/shared/utils');
  const backup = await import('../services/DatabaseBackupService');
  const { LOCAL_EMBEDDER_DIMENSIONS, LOCAL_EMBEDDER_MODEL_ID, LOCAL_EMBEDDER_PROVIDER_ID } =
    await import('../services/embedding/embedderModelManifest');

  const runtime = new PostgresRuntime({ snagletHome });
  const waitForJob = async () => {
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const status = backup.getDbJobStatus();
      if (!status.running) return status;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for database backup job');
  };

  try {
    await initializeDatabase();
    const db = getDb();
    const user = await Users.getOrCreateLocalUser();
    const threadId = 'backup-proof-thread';
    await Threads.create({ id: threadId, title: 'Backup proof' });
    const message = await Messages.create({
      threadId,
      role: 'user',
      userId: String(user.id),
      content: 'original backup proof content',
    });
    const model = await db.query<{ id: string }>(
      'SELECT id FROM public.models WHERE provider_id = $1 AND model_id = $2',
      [LOCAL_EMBEDDER_PROVIDER_ID, LOCAL_EMBEDDER_MODEL_ID]
    );
    const modelId = model.rows[0]?.id;
    if (!modelId) {
      throw new Error(
        `Built-in embedding model ${LOCAL_EMBEDDER_PROVIDER_ID}:${LOCAL_EMBEDDER_MODEL_ID} is not seeded`
      );
    }
    const vector = Array.from({ length: LOCAL_EMBEDDER_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0
    );
    await db.query(
      `INSERT INTO public.embeddings
         (id, node_id, model_id, vector, content_hash, chunk_index)
       VALUES ('backup-proof-embedding', $1, $2, $3::vector, 'backup-proof-hash', 0)`,
      [message.id, modelId, vectorLiteral(vector)]
    );

    const countSql = `SELECT
      (SELECT count(*)::int8 FROM public.nodes) AS nodes,
      (SELECT count(*)::int8 FROM public.messages) AS messages,
      (SELECT count(*)::int8 FROM public.embeddings) AS embeddings,
      (SELECT count(*)::int8 FROM public._migrations) AS migrations`;
    const before = (await db.query<Record<string, number>>(countSql)).rows[0]!;

    const ledger = await db.query<{ name: string }>(
      'SELECT name FROM public._migrations ORDER BY name LIMIT 1'
    );
    const borrowedMigration = ledger.rows[0]?.name;
    if (!borrowedMigration) throw new Error('Migration ledger is unexpectedly empty');
    await db.query('DELETE FROM public._migrations WHERE name = $1', [borrowedMigration]);
    // This proof runs without SNAGLET_PG_OWNED, so say explicitly that the pending
    // migration is about to be applied.
    const preMigration = await backup.preMigrationBackupIfNeeded({ migrationsWillApply: true });
    if (!preMigration || preMigration.engine !== 'postgres' || preMigration.format !== 'custom') {
      throw new Error('Managed pre-migration hook did not create a PostgreSQL custom snapshot');
    }
    await db.query(
      'INSERT INTO public._migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [borrowedMigration]
    );

    backup.startSnapshot('Managed roundtrip');
    const snapshotJob = await waitForJob();
    if (snapshotJob.error || !snapshotJob.lastSnapshotId) {
      throw new Error(`Snapshot failed: ${snapshotJob.error ?? 'no artifact id'}`);
    }
    await db.query(`UPDATE public.messages SET content = 'mutated' WHERE id = $1`, [message.id]);
    await db.query(`DELETE FROM public.embeddings WHERE id = 'backup-proof-embedding'`);
    await db.query(`INSERT INTO public.nodes (id, type) VALUES ('backup-proof-extra', 'doc')`);
    await db.query(
      `INSERT INTO public.docs (id, title, content)
       VALUES ('backup-proof-extra', 'Extra', 'must disappear')`
    );

    backup.startRestore(snapshotJob.lastSnapshotId);
    const restoreJob = await waitForJob();
    if (restoreJob.error) throw new Error(`Restore failed: ${restoreJob.error}`);

    const after = (await db.query<Record<string, number>>(countSql)).rows[0]!;
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`Count mismatch: ${JSON.stringify({ before, after })}`);
    }
    const restoredMessage = await db.query<{ content: string }>(
      'SELECT content FROM public.messages WHERE id = $1',
      [message.id]
    );
    if (restoredMessage.rows[0]?.content !== 'original backup proof content') {
      throw new Error('Message content did not restore to the snapshot value');
    }
    const nearest = await db.query<{ id: string }>(
      `SELECT id FROM public.embeddings
        WHERE model_id = $1
        ORDER BY vector <=> $2::vector
        LIMIT 1`,
      [modelId, vectorLiteral(vector)]
    );
    if (nearest.rows[0]?.id !== 'backup-proof-embedding') {
      throw new Error('Restored vector search did not return the seeded embedding');
    }

    backup.startSnapshot('Portable proof', 'plain-gzip');
    const portableJob = await waitForJob();
    if (portableJob.error || !portableJob.lastSnapshotId) {
      throw new Error(`Portable export failed: ${portableJob.error ?? 'no artifact id'}`);
    }
    const portable = await backup.readSnapshotArtifact(portableJob.lastSnapshotId);
    const sql = String(await promisify(gunzip)(portable.buffer));
    if (!sql.includes('PostgreSQL database dump') || !portable.fileName.endsWith('.sql.gz')) {
      throw new Error('Portable export is not a gzip-compressed plain PostgreSQL dump');
    }
    await db.query(
      `UPDATE public.messages SET content = 'mutated after portable export' WHERE id = $1`,
      [message.id]
    );
    backup.startRestore(portableJob.lastSnapshotId);
    const portableRestoreJob = await waitForJob();
    if (portableRestoreJob.error) {
      throw new Error(`Portable SQL restore failed: ${portableRestoreJob.error}`);
    }
    const portableRestoredMessage = await db.query<{ content: string }>(
      'SELECT content FROM public.messages WHERE id = $1',
      [message.id]
    );
    if (portableRestoredMessage.rows[0]?.content !== 'original backup proof content') {
      throw new Error('Portable SQL restore did not restore the exported message content');
    }
    const hnsw = await db.query<{ hnswEfSearch: string }>(
      `SELECT current_setting('hnsw.ef_search') AS "hnswEfSearch"`
    );
    if (hnsw.rows[0]?.hnswEfSearch !== '100') {
      throw new Error(`Restore lost hnsw.ef_search=100 (got ${hnsw.rows[0]?.hnswEfSearch})`);
    }
    const snapshots = await backup.listSnapshots();

    console.log(
      JSON.stringify({
        ok: true,
        counts: after,
        vectorResult: nearest.rows[0].id,
        preMigrationSnapshot: preMigration.id,
        customSnapshot: snapshotJob.lastSnapshotId,
        portableExport: portable.fileName,
        portableRestore: true,
        hnswEfSearch: hnsw.rows[0].hnswEfSearch,
        managedSnapshots: snapshots.length,
      })
    );
  } finally {
    await closeDatabase().catch((error: unknown) =>
      console.error(`Failed to close the verification database: ${getErrorMessage(error)}`)
    );
    await runtime
      .stop('fast')
      .catch((error: unknown) =>
        console.error(`Failed to stop the verification runtime: ${getErrorMessage(error)}`)
      );
    await rm(runtime.socketDir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch(async (error: unknown) => {
  const { getErrorMessage } = await import('@snaglet/shared/utils');
  console.error(error instanceof Error && error.stack ? error.stack : getErrorMessage(error));
  process.exitCode = 1;
});
