/**
 * POST /api/docs/:id/snapshots/:snapshotId/restore writes a new body, so it
 * must announce it the way a PATCH body edit does: open editors listen for
 * `doc.saved`, and the doc:edit hook carries the pre-restore safety copy.
 * Database access is real; the emitters are spied.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Docs, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';

const mockEmitDocBodySaved = jest.fn();
jest.mock('@server/realtime/surfaces/tree', () => ({
  ...jest.requireActual<object>('@server/realtime/surfaces/tree'),
  emitDocBodySaved: (...args: unknown[]) => mockEmitDocBodySaved(...args),
}));
const mockHookEmit = jest.fn();
jest.mock('@server/services/HookService', () => ({
  hooks: { emit: (...args: unknown[]) => mockHookEmit(...args) },
}));
const mockSyncContentRefLinks = jest.fn();
jest.mock('@server/services/contentRefs', () => ({
  syncContentRefLinks: (...args: unknown[]) => mockSyncContentRefLinks(...args),
}));
jest.mock('@server/services/embedding/docSettleReembed', () => ({
  stampDocEdit: jest.fn(async () => undefined),
}));

import docsRouter from '@server/domains/docs/docs.routes';

const DOC = 'doc-1111111111111-aaaaaaaaa';
const SNAPSHOT = 'snap-restore-test-version-1';
const LIVE = 'Current body of the test doc.';
const HISTORICAL = 'Earlier body of the test doc.';

const app = express();
app.use(express.json());
app.use('/api/docs', docsRouter);
app.use(errorHandler);

async function cleanup(): Promise<void> {
  await getDb().query('DELETE FROM public.doc_snapshots WHERE doc_id = $1', [DOC]);
  await getDb().query('DELETE FROM public.nodes WHERE id = $1', [DOC]);
}

describe('POST /api/docs/:id/snapshots/:snapshotId/restore', () => {
  beforeAll(async () => {
    await cleanup();
    await Docs.create({ id: DOC, title: 'Restore test doc', content: LIVE });
    await getDb().query(
      `INSERT INTO public.doc_snapshots (id, doc_id, content, content_bytes, label, reason)
       VALUES ($1, $2, $3, octet_length($3), 'Version 1', 'manual')`,
      [SNAPSHOT, DOC, HISTORICAL]
    );
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(cleanup);

  it('restores the body and announces it like a body edit', async () => {
    const res = await request(app)
      .post(`/api/docs/${DOC}/snapshots/${SNAPSHOT}/restore`)
      .expect(200);

    expect(res.body.data.doc.content).toBe(HISTORICAL);
    expect((await Docs.findById(DOC))?.content).toBe(HISTORICAL);

    const { rows } = await getDb().query<{ id: string; content: string }>(
      `SELECT id, content FROM public.doc_snapshots WHERE doc_id = $1 AND reason = 'pre-restore'`,
      [DOC]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe(LIVE);

    expect(mockEmitDocBodySaved).toHaveBeenCalledTimes(1);
    // No actor is bound here, so the restore is unattributed: no editor id.
    expect(mockEmitDocBodySaved).toHaveBeenCalledWith(DOC, HISTORICAL, expect.any(String), null);
    expect(mockSyncContentRefLinks).toHaveBeenCalledWith(DOC, HISTORICAL);
    expect(mockHookEmit).toHaveBeenCalledWith(
      'doc:edit',
      expect.objectContaining({
        id: DOC,
        charsDelta: HISTORICAL.length - LIVE.length,
        backupSnapshotId: rows[0]?.id,
      })
    );
  });

  it('404s for a snapshot of another doc and announces nothing', async () => {
    await request(app).post(`/api/docs/${DOC}/snapshots/snap-missing/restore`).expect(404);
    expect(mockEmitDocBodySaved).not.toHaveBeenCalled();
    expect(mockHookEmit).not.toHaveBeenCalled();
  });
});
