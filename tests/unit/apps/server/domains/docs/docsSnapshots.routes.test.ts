/**
 * Doc version history routes — the count on the Versions button and
 * "Clear all versions".
 *
 * The list route caps its page at 200 rows but must report the true
 * total, and the clear route must remove exactly one doc's history and
 * nothing else. Both are asserted against a tiny in-memory
 * `doc_snapshots` table behind the mocked `getDb()` facade so the tests
 * can see what each statement actually did, not just that it ran.
 */

import request from 'supertest';
import express from 'express';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

interface SnapshotRow {
  id: string;
  doc_id: string;
  content: string;
  label: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

/** In-memory doc_snapshots. Reset per test. */
let table: SnapshotRow[] = [];
/** Every SQL statement the routes issued, in order. */
let issued: Array<{ sql: string; params: unknown[] }> = [];

const docsFindById = jest.fn();
const docsUpdate = jest.fn();
const docsDelete = jest.fn();

/**
 * Minimal SQL dispatcher: recognizes the statements the snapshot routes
 * issue and applies them to `table`. Anything else throws so a new query
 * shape can't silently pass.
 */
const query = jest.fn(async (sql: string, params: unknown[] = []) => {
  issued.push({ sql, params });
  const docId = String(params[0]);
  if (/SELECT COUNT\(\*\)/i.test(sql)) {
    return { rows: [{ total: table.filter((r) => r.doc_id === docId).length }], rowCount: 1 };
  }
  if (/^\s*SELECT id, label, reason, created_by, created_at/i.test(sql)) {
    const rows = table
      .filter((r) => r.doc_id === docId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 200)
      .map(({ id, label, reason, created_by, created_at, content }) => ({
        id,
        label,
        reason,
        created_by,
        created_at,
        content_bytes: String(Buffer.byteLength(content, 'utf8')),
      }));
    return { rows, rowCount: rows.length };
  }
  if (/^\s*DELETE FROM doc_snapshots\s+WHERE doc_id = \$1\s+RETURNING id/i.test(sql)) {
    const gone = table.filter((r) => r.doc_id === docId).map(({ id }) => ({ id }));
    table = table.filter((r) => r.doc_id !== docId);
    return { rows: gone, rowCount: gone.length };
  }
  throw new Error(`unexpected SQL in test: ${sql}`);
});

jest.mock('@snaglet/db', () => ({
  Docs: {
    findById: (...a: unknown[]) => docsFindById(...a),
    update: (...a: unknown[]) => docsUpdate(...a),
    delete: (...a: unknown[]) => docsDelete(...a),
  },
  Containers: { findById: jest.fn() },
  getDb: () => ({ query }),
}));
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: jest.fn(),
  emitTreeNodeUpdated: jest.fn(),
  emitTreeNodeDeleted: jest.fn(),
  emitDocBodySaved: jest.fn(),
  snapshotFromDoc: jest.fn(),
}));
jest.mock('@server/realtime/actorContext', () => ({ getCurrentActor: () => null }));
jest.mock('@server/services/HookService', () => ({ hooks: { emit: jest.fn() } }));
jest.mock('@server/services/contentRefs', () => ({ syncContentRefLinks: jest.fn() }));
jest.mock('@server/services/embedding/docSettleReembed', () => ({ stampDocEdit: jest.fn() }));
jest.mock('@server/services/embedding/embedDoc', () => ({ embedDocNow: jest.fn() }));
jest.mock('@server/domains/docs/docImport', () => ({ convertFileToDoc: jest.fn() }));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import docsRouter from '@server/domains/docs/docs.routes';
import { errorHandler } from '@server/middleware/errorHandler';

const DOC_A = 'doc-1111111111111-aaaaaaaaa';
const DOC_B = 'doc-2222222222222-bbbbbbbbb';

const docRow = (id: string) => ({
  id,
  containerId: null,
  title: 'Test doc',
  content: '# live body',
  dueAt: null,
  assignedTo: null,
  priority: null,
  createdBy: null,
  lastEditedBy: null,
  sortOrder: 0,
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: '2026-07-01T12:00:00.000Z',
});

function seed(docId: string, n: number): void {
  for (let i = 0; i < n; i += 1) {
    table.push({
      id: `snap-${docId}-${String(i).padStart(4, '0')}`,
      doc_id: docId,
      content: `version ${i}`,
      label: null,
      reason: 'manual',
      created_by: null,
      created_at: new Date(Date.UTC(2026, 6, 1, 0, 0, i)).toISOString(),
    });
  }
}

const app = express().use(express.json()).use('/api/docs', docsRouter).use(errorHandler);

beforeEach(() => {
  jest.clearAllMocks();
  table = [];
  issued = [];
  docsFindById.mockImplementation(async (id: unknown) =>
    id === DOC_A || id === DOC_B ? docRow(String(id)) : null
  );
});

describe('GET /api/docs/:id/snapshots — count is the true total', () => {
  it('reports every snapshot in `count` while the list stays capped at 200', async () => {
    seed(DOC_A, 250);

    const res = await request(app).get(`/api/docs/${DOC_A}/snapshots`);

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(250);
    expect(res.body.data.snapshots).toHaveLength(200);
    // Newest-first: the last-seeded row leads the page.
    expect(res.body.data.snapshots[0].id).toBe(`snap-${DOC_A}-0249`);
    expect(typeof res.body.data.count).toBe('number');
  });

  it('counts only the requested doc', async () => {
    seed(DOC_A, 3);
    seed(DOC_B, 5);

    const res = await request(app).get(`/api/docs/${DOC_A}/snapshots`);

    expect(res.body.data.count).toBe(3);
    expect(res.body.data.snapshots).toHaveLength(3);
  });

  it('is 0 (not missing) for a doc with no history', async () => {
    const res = await request(app).get(`/api/docs/${DOC_A}/snapshots`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ doc_id: DOC_A, count: 0, snapshots: [] });
  });

  it('coerces a bigint-as-string COUNT into a number', async () => {
    // node-postgres returns COUNT(*) as a string unless cast; the route
    // must not leak "3" onto the wire even if the cast is ever dropped.
    query.mockImplementationOnce(async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      return { rows: [], rowCount: 0 };
    });
    query.mockImplementationOnce(async () => ({ rows: [{ total: '3' }], rowCount: 1 }));

    const res = await request(app).get(`/api/docs/${DOC_A}/snapshots`);

    expect(res.body.data.count).toBe(3);
  });
});

describe('DELETE /api/docs/:id/snapshots — clear all versions', () => {
  it('removes every snapshot of the doc and reports how many went', async () => {
    seed(DOC_A, 4);

    const res = await request(app).delete(`/api/docs/${DOC_A}/snapshots`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true, doc_id: DOC_A, deleted_count: 4 });
    expect(table.filter((r) => r.doc_id === DOC_A)).toHaveLength(0);

    const list = await request(app).get(`/api/docs/${DOC_A}/snapshots`);
    expect(list.body.data.count).toBe(0);
  });

  it('is scoped to one doc — another doc keeps its whole history', async () => {
    seed(DOC_A, 3);
    seed(DOC_B, 2);

    const res = await request(app).delete(`/api/docs/${DOC_A}/snapshots`);

    expect(res.body.data.deleted_count).toBe(3);
    expect(table.filter((r) => r.doc_id === DOC_B)).toHaveLength(2);
    // The statement itself carries the scope — one DELETE, parameterized
    // by doc_id, never a bare `DELETE FROM doc_snapshots`.
    const deletes = issued.filter((q) => /DELETE FROM doc_snapshots/i.test(q.sql));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.sql).toMatch(/WHERE doc_id = \$1/);
    expect(deletes[0]!.params).toEqual([DOC_A]);
  });

  it('never touches the live doc', async () => {
    seed(DOC_A, 2);

    await request(app).delete(`/api/docs/${DOC_A}/snapshots`);

    expect(docsUpdate).not.toHaveBeenCalled();
    expect(docsDelete).not.toHaveBeenCalled();
    // Only the doc existence check reads the doc; every SQL statement
    // issued is against doc_snapshots.
    expect(docsFindById).toHaveBeenCalledWith(DOC_A);
    expect(issued.every((q) => /doc_snapshots/.test(q.sql))).toBe(true);
    expect(issued.some((q) => /\bdocs\b/.test(q.sql))).toBe(false);
  });

  it('succeeds with deleted_count 0 on an empty history — and again on repeat', async () => {
    const first = await request(app).delete(`/api/docs/${DOC_A}/snapshots`);
    const second = await request(app).delete(`/api/docs/${DOC_A}/snapshots`);

    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ deleted: true, doc_id: DOC_A, deleted_count: 0 });
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ deleted: true, doc_id: DOC_A, deleted_count: 0 });
  });

  it('404s for a missing doc without issuing a DELETE', async () => {
    seed(DOC_A, 1);

    const res = await request(app).delete('/api/docs/doc-0000000000000-missing00/snapshots');

    expect(res.status).toBe(404);
    expect(issued.filter((q) => /DELETE/i.test(q.sql))).toHaveLength(0);
    expect(table).toHaveLength(1);
  });

  it('does not shadow the single-snapshot delete route', async () => {
    // `DELETE /:id/snapshots/:snapshotId` must still resolve to the
    // one-row route, not the clear-all handler.
    seed(DOC_A, 2);
    query.mockImplementationOnce(async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      return { rows: [{ id: params[0] }], rowCount: 1 };
    });

    const res = await request(app).delete(`/api/docs/${DOC_A}/snapshots/snap-${DOC_A}-0000`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true, id: `snap-${DOC_A}-0000`, doc_id: DOC_A });
    expect(issued[0]!.params).toEqual([`snap-${DOC_A}-0000`, DOC_A]);
  });
});
