/**
 * snapshot_doc — created_by attribution, against the real database.
 * `created_by` comes from the context's `agentId` (camelCase, as
 * `ToolHandlerContext` sets it), or from the ambient actor.
 *
 * `doc_snapshots.created_by` is a non-FK TEXT column (unlike docs/containers'
 * created_by, which is FK -> members(id) and resolved via
 * resolveActorMemberId), so these tests assert the raw id lands verbatim.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Docs } from '@snaglet/db';
import { runWithActor } from '@server/realtime/actorContext';
import type { ToolHandlerContext, ToolHandlerRichResult } from '@server/services/ToolService/types';
import snapshotDoc from '@server/services/ToolService/handlers/docs/history/snapshot';

const PREFIX = 'snap-doc-test';

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.doc_snapshots WHERE doc_id LIKE 'doc-${PREFIX}-%'`);
  await pool.query(`DELETE FROM public.docs WHERE id LIKE 'doc-${PREFIX}-%'`);
  await pool.query(`DELETE FROM public.nodes WHERE id LIKE 'doc-${PREFIX}-%'`);
}

interface SnapshotDocResult {
  success: true;
  snapshot_id: string;
}

async function callSnapshotDoc(
  input: Record<string, unknown>,
  context?: ToolHandlerContext
): Promise<SnapshotDocResult> {
  const result = (await snapshotDoc(input, {}, context)) as ToolHandlerRichResult;
  return result.rawContent as SnapshotDocResult;
}

describe('snapshot_doc — created_by attribution', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('populates created_by from ctx.agentId', async () => {
    const doc = await Docs.create({ id: `doc-${PREFIX}-1`, title: 't1', content: 'hello world' });

    const out = await callSnapshotDoc({ doc_id: doc.id }, { agentId: 'agent-snap-test-1' });
    expect(out.success).toBe(true);

    const row = (
      await getDb().query<{ created_by: string | null }>(
        `SELECT created_by FROM doc_snapshots WHERE id = $1`,
        [out.snapshot_id]
      )
    ).rows[0];
    expect(row.created_by).toBe('agent-snap-test-1');
  });

  it('falls back to the ambient actor when no agentId is in context', async () => {
    const doc = await Docs.create({ id: `doc-${PREFIX}-2`, title: 't2', content: 'hello again' });

    const out = await runWithActor(
      { actorKind: 'user', actorId: 'user-snap-test-1', actorName: 'Test User' },
      () => callSnapshotDoc({ doc_id: doc.id }, undefined)
    );
    expect(out.success).toBe(true);

    const row = (
      await getDb().query<{ created_by: string | null }>(
        `SELECT created_by FROM doc_snapshots WHERE id = $1`,
        [out.snapshot_id]
      )
    ).rows[0];
    expect(row.created_by).toBe('user-snap-test-1');
  });

  it('leaves created_by null when neither an agentId nor an ambient actor is present', async () => {
    const doc = await Docs.create({ id: `doc-${PREFIX}-3`, title: 't3', content: 'no actor' });

    const out = await callSnapshotDoc({ doc_id: doc.id }, undefined);
    expect(out.success).toBe(true);

    const row = (
      await getDb().query<{ created_by: string | null }>(
        `SELECT created_by FROM doc_snapshots WHERE id = $1`,
        [out.snapshot_id]
      )
    ).rows[0];
    expect(row.created_by).toBeNull();
  });
});
