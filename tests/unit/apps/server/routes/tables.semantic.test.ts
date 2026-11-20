/**
 * /api/tables search-by-meaning routes with the service mocked: the overview
 * (every active custom table, on or off) is a literal segment ahead of `/:id`,
 * the per-table status and backfill validate the id first, and the switch
 * passes `enabled` and `confirm` (only when sent) through, with the service's
 * 400 for a table over the cap passed back.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppError } from '@snaglet/shared/utils';
import {
  ErrorCode,
  HTTP_STATUS,
  type SemanticStatus,
  type SemanticTableRow,
} from '@snaglet/shared/types';

const listSemanticTables = jest.fn<() => Promise<SemanticTableRow[]>>();
const getSemanticStatus = jest.fn<(id: string) => Promise<SemanticStatus>>();
const setSemanticSearch =
  jest.fn<
    (id: string, input: { enabled: boolean; confirm?: boolean }) => Promise<SemanticStatus>
  >();
const backfillSemanticTable = jest.fn<(id: string) => Promise<SemanticStatus>>();

jest.mock('@server/services/tableSemantic/TableSemanticService', () => ({
  listSemanticTables: () => listSemanticTables(),
  getSemanticStatus: (id: string) => getSemanticStatus(id),
  setSemanticSearch: (id: string, input: { enabled: boolean; confirm?: boolean }) =>
    setSemanticSearch(id, input),
  backfillSemanticTable: (id: string) => backfillSemanticTable(id),
}));

import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const ESTIMATE = { rows: 12, bytes: 52_800, label: '~52 KB' };
const STATUS: SemanticStatus = {
  tableId: TABLE_ID,
  tableName: 'notes',
  enabled: true,
  rows: 12,
  rowsCapped: false,
  rowCap: 10_000,
  needsConfirmation: false,
  indexed: 4,
  state: 'indexing',
  estimate: ESTIMATE,
  cardFields: ['name'],
  excludedByName: [],
  warning: 'best-effort',
};
const ROW: SemanticTableRow = {
  tableId: TABLE_ID,
  tableName: 'notes',
  projectName: null,
  enabled: false,
  rows: 12,
  rowsCapped: false,
  needsConfirmation: false,
  indexed: 0,
  state: 'off',
  estimate: ESTIMATE,
};

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/tables', tablesRouter);
  app.use(errorHandler);
  return app;
}

describe('/api/tables search by meaning routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serves the overview of every table, on or off, ahead of the /:id routes', async () => {
    listSemanticTables.mockResolvedValue([ROW]);
    const response = await request(makeApp()).get('/api/tables/semantic-search');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ tables: [ROW] });
    expect(getSemanticStatus).not.toHaveBeenCalled();
  });

  it("reads one table's status, refusing a malformed id before the service", async () => {
    getSemanticStatus.mockResolvedValue(STATUS);
    const found = await request(makeApp()).get(`/api/tables/${TABLE_ID}/semantic-search`);
    expect(found.status).toBe(200);
    expect(found.body.data).toEqual(STATUS);
    expect(getSemanticStatus).toHaveBeenCalledWith(TABLE_ID);

    const bad = await request(makeApp()).get('/api/tables/not-a-table/semantic-search');
    expect(bad.status).toBe(400);
    expect(getSemanticStatus).toHaveBeenCalledTimes(1);
  });

  it('passes enabled, and confirm only when sent, to the switch', async () => {
    setSemanticSearch.mockResolvedValue(STATUS);
    const off = await request(makeApp())
      .put(`/api/tables/${TABLE_ID}/semantic-search`)
      .send({ enabled: false });
    expect(off.status).toBe(200);
    expect(setSemanticSearch).toHaveBeenLastCalledWith(TABLE_ID, { enabled: false });

    const confirmed = await request(makeApp())
      .put(`/api/tables/${TABLE_ID}/semantic-search`)
      .send({ enabled: true, confirm: true });
    expect(confirmed.status).toBe(200);
    expect(setSemanticSearch).toHaveBeenLastCalledWith(TABLE_ID, { enabled: true, confirm: true });
  });

  it("passes back the service's 400 for a table over the cap without confirm", async () => {
    setSemanticSearch.mockRejectedValueOnce(
      new AppError(
        'notes has 12,000 rows, more than the 10,000 a table may index without confirmation. Indexing it takes ~50 MB. Pass confirm: true to turn it on.',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      )
    );
    const response = await request(makeApp())
      .put(`/api/tables/${TABLE_ID}/semantic-search`)
      .send({ enabled: true });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/confirm: true/);
  });

  it('starts a backfill for a valid id', async () => {
    backfillSemanticTable.mockResolvedValue(STATUS);
    const response = await request(makeApp()).post(
      `/api/tables/${TABLE_ID}/semantic-search/backfill`
    );
    expect(response.status).toBe(200);
    expect(backfillSemanticTable).toHaveBeenCalledWith(TABLE_ID);
  });
});
