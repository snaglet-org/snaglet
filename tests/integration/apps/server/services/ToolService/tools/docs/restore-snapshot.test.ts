/**
 * restore_snapshot — created_by attribution on the pre-restore safety
 * snapshot, against the real database. `ToolHandlerContext` sets `agentId`
 * (camelCase), and the safety snapshot's `created_by` comes from it, or from
 * the ambient actor (see the sibling snapshot_doc test for the primary path).
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Docs } from '@snaglet/db';
import { runWithActor } from '@server/realtime/actorContext';
import type { ToolHandlerContext, ToolHandlerRichResult } from '@server/services/ToolService/types';
import restoreSnapshot from '@server/services/ToolService/handlers/docs/history/restore';

const PREFIX = 'restore-snap-test';

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.doc_snapshots WHERE doc_id LIKE 'doc-${PREFIX}-%'`);
  await pool.query(`DELETE FROM public.docs WHERE id LIKE 'doc-${PREFIX}-%'`);
  await pool.query(`DELETE FROM public.nodes WHERE id LIKE 'doc-${PREFIX}-%'`);
}

interface RestoreResult {
  success: true;
  safety_snapshot_id?: string;
}

async function callRestoreSnapshot(
  input: Record<string, unknown>,
  context?: ToolHandlerContext
): Promise<RestoreResult> {
  const result = (await restoreSnapshot(input, {}, context)) as ToolHandlerRichResult;
  return result.rawContent as RestoreResult;
}

/** Insert a target snapshot directly (bypassing snapshot_doc) to restore from. */
async function insertOldSnapshot(docId: string, content: string): Promise<string> {
  const id = `snap-${PREFIX}-${Math.random().toString(36).slice(2, 8)}`;
  await getDb().query(
    `INSERT INTO doc_snapshots (id, doc_id, content, content_bytes, label, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, docId, content, Buffer.byteLength(content, 'utf8'), 'old', 'seed', null]
  );
  return id;
}

async function createdByOf(snapshotId: string): Promise<string | null> {
  const row = (
    await getDb().query<{ created_by: string | null }>(
      `SELECT created_by FROM doc_snapshots WHERE id = $1`,
      [snapshotId]
    )
  ).rows[0];
  return row?.created_by ?? null;
}

describe('restore_snapshot — safety-snapshot created_by attribution', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('populates the safety snapshot created_by from ctx.agentId', async () => {
    const doc = await Docs.create({
      id: `doc-${PREFIX}-1`,
      title: 't1',
      content: 'current content',
    });
    const oldSnapId = await insertOldSnapshot(doc.id, 'older content');

    const out = await callRestoreSnapshot(
      { snapshot_id: oldSnapId },
      { agentId: 'agent-restore-test-1' }
    );
    expect(out.success).toBe(true);
    expect(out.safety_snapshot_id).toBeTruthy();

    expect(await createdByOf(out.safety_snapshot_id!)).toBe('agent-restore-test-1');
  });

  it('falls back to the ambient actor when no agentId is in context', async () => {
    const doc = await Docs.create({
      id: `doc-${PREFIX}-2`,
      title: 't2',
      content: 'current content 2',
    });
    const oldSnapId = await insertOldSnapshot(doc.id, 'older content 2');

    const out = await runWithActor(
      { actorKind: 'user', actorId: 'user-restore-test-1', actorName: 'Test User' },
      () => callRestoreSnapshot({ snapshot_id: oldSnapId }, undefined)
    );
    expect(out.success).toBe(true);
    expect(out.safety_snapshot_id).toBeTruthy();

    expect(await createdByOf(out.safety_snapshot_id!)).toBe('user-restore-test-1');
  });

  it('leaves the safety snapshot created_by null when neither an agentId nor an ambient actor is present', async () => {
    const doc = await Docs.create({
      id: `doc-${PREFIX}-3`,
      title: 't3',
      content: 'current content 3',
    });
    const oldSnapId = await insertOldSnapshot(doc.id, 'older content 3');

    const out = await callRestoreSnapshot({ snapshot_id: oldSnapId }, undefined);
    expect(out.success).toBe(true);
    expect(out.safety_snapshot_id).toBeTruthy();

    expect(await createdByOf(out.safety_snapshot_id!)).toBeNull();
  });
});
