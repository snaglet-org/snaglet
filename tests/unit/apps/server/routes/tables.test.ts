/**
 * /api/tables route contract with the service mocked: origin and project
 * filter validation, detail passthrough and 404 mapping, create body
 * validation (an optional project home included) before the service runs and
 * project refusals passed through, 201 on create vs 200 on an idempotent
 * replay, rename and placement (project link and manual order) body
 * validation plus 400/403/409 passthrough, and Snaglet item reference search
 * parsing ahead of the `/:id` routes.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import type {
  CreateTableRequest,
  TableCatalogEntry,
  TableDetailResponse,
  TableReferenceSearchResponse,
  UpdateTablePlacementRequest,
} from '@snaglet/shared/types';

const listTables =
  jest.fn<(filter: { origin?: string; projectId?: string }) => Promise<TableCatalogEntry[]>>();
const getTableDetail = jest.fn<(id: string) => Promise<TableDetailResponse>>();
const createTable =
  jest.fn<(input: CreateTableRequest) => Promise<{ table: TableCatalogEntry; created: boolean }>>();

const renameTable =
  jest.fn<
    (id: string, input: { name: string; expectedName: string }) => Promise<TableCatalogEntry>
  >();
const updateTablePlacement =
  jest.fn<(id: string, placement: UpdateTablePlacementRequest) => Promise<TableCatalogEntry>>();
const assertTablePlacement =
  jest.fn<(id: string, placement: UpdateTablePlacementRequest) => Promise<TableCatalogEntry>>();

jest.mock('@server/domains/tables/tableCatalog', () => ({
  listTables: (filter: { origin?: string; projectId?: string }) => listTables(filter),
  getTableDetail: (id: string) => getTableDetail(id),
  createTable: (input: CreateTableRequest) => createTable(input),
  renameTable: (id: string, input: { name: string; expectedName: string }) =>
    renameTable(id, input),
  updateTablePlacement: (id: string, placement: UpdateTablePlacementRequest) =>
    updateTablePlacement(id, placement),
  assertTablePlacement: (id: string, placement: UpdateTablePlacementRequest) =>
    assertTablePlacement(id, placement),
}));

const searchReferences = jest.fn<(query: unknown) => Promise<TableReferenceSearchResponse>>();
jest.mock('@snaglet/db/tables/table_references', () => ({
  TableReferences: { search: (query: unknown) => searchReferences(query) },
}));

import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const ENTRY: TableCatalogEntry = {
  id: TABLE_ID,
  name: 'Test Table',
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/tables', tablesRouter);
  app.use(errorHandler);
  return app;
}

describe('/api/tables routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists tables, passing a validated origin filter', async () => {
    listTables.mockResolvedValue([ENTRY]);
    const all = await request(makeApp()).get('/api/tables');
    expect(all.status).toBe(200);
    expect(all.body.data).toEqual({ tables: [ENTRY] });
    expect(listTables).toHaveBeenLastCalledWith({ origin: undefined, projectId: undefined });

    const custom = await request(makeApp()).get('/api/tables?origin=custom');
    expect(custom.status).toBe(200);
    expect(listTables).toHaveBeenLastCalledWith({ origin: 'custom', projectId: undefined });
  });

  it('passes a project filter through: a project id, or none for workspace-wide tables', async () => {
    listTables.mockResolvedValue([ENTRY]);
    const inProject = await request(makeApp()).get(`/api/tables?projectId=${PROJECT_ID}`);
    expect(inProject.status).toBe(200);
    expect(listTables).toHaveBeenLastCalledWith({ origin: undefined, projectId: PROJECT_ID });

    const unlinked = await request(makeApp()).get('/api/tables?origin=custom&projectId=none');
    expect(unlinked.status).toBe(200);
    expect(listTables).toHaveBeenLastCalledWith({ origin: 'custom', projectId: 'none' });

    // `none` is matched after trimming, in any case.
    const shouted = await request(makeApp()).get('/api/tables?projectId=%20NONE%20');
    expect(shouted.status).toBe(200);
    expect(listTables).toHaveBeenLastCalledWith({ origin: undefined, projectId: 'none' });

    for (const query of ['projectId=', 'projectId=a&projectId=b', 'projectId=a%00b']) {
      const response = await request(makeApp()).get(`/api/tables?${query}`);
      expect({ query, status: response.status }).toEqual({ query, status: 400 });
    }
    expect(listTables).toHaveBeenCalledTimes(3);
  });

  it('400s an unknown or repeated origin filter without calling the service', async () => {
    for (const query of ['origin=external', 'origin=builtin&origin=custom']) {
      const response = await request(makeApp()).get(`/api/tables?${query}`);
      expect({ query, status: response.status }).toEqual({ query, status: 400 });
    }
    expect(listTables).not.toHaveBeenCalled();
  });

  it('returns table detail and maps a missing table to 404', async () => {
    const detail: TableDetailResponse = {
      table: ENTRY,
      columns: [{ name: 'id', dataType: 'uuid', nullable: false, managed: true }],
      rowCount: 0,
    };
    getTableDetail.mockResolvedValueOnce(detail);
    const found = await request(makeApp()).get(`/api/tables/${TABLE_ID}`);
    expect(found.status).toBe(200);
    expect(found.body.data).toEqual(detail);
    expect(getTableDetail).toHaveBeenCalledWith(TABLE_ID);

    getTableDetail.mockRejectedValueOnce(
      new AppError('Table not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND)
    );
    const missing = await request(makeApp()).get('/api/tables/table-1111111111111-zzzzzzzzz');
    expect(missing.status).toBe(404);
  });

  it('creates with 201, trims the name, and replays with 200', async () => {
    createTable.mockResolvedValueOnce({ table: ENTRY, created: true });
    const created = await request(makeApp())
      .post('/api/tables')
      .send({ id: TABLE_ID, name: '  Test Table  ' });
    expect(created.status).toBe(201);
    expect(created.body.data).toEqual({ table: ENTRY });
    expect(createTable).toHaveBeenCalledWith({ id: TABLE_ID, name: 'Test Table' });

    createTable.mockResolvedValueOnce({ table: ENTRY, created: false });
    const replay = await request(makeApp())
      .post('/api/tables')
      .send({ id: TABLE_ID, name: 'Test Table' });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual({ table: ENTRY });
  });

  it('400s malformed bodies before the service runs', async () => {
    const bodies: unknown[] = [
      [],
      { name: 'Test Table' },
      { id: 'table-builtin-docs', name: 'Test Table' },
      { id: 'not-a-table-id', name: 'Test Table' },
      { id: TABLE_ID },
      { id: TABLE_ID, name: '' },
      { id: TABLE_ID, name: 'x'.repeat(64) },
      { id: TABLE_ID, name: 'Tab\tName' },
    ];
    for (const body of bodies) {
      const response = await request(makeApp())
        .post('/api/tables')
        .send(body as object);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    expect(createTable).not.toHaveBeenCalled();
  });

  it('creates in a project with a trimmed projectId, or workspace-wide with null', async () => {
    const linked: TableCatalogEntry = { ...ENTRY, projectId: PROJECT_ID, sortOrder: 2 };
    createTable.mockResolvedValueOnce({ table: linked, created: true });
    const created = await request(makeApp())
      .post('/api/tables')
      .send({ id: TABLE_ID, name: 'Test Table', projectId: ` ${PROJECT_ID} ` });
    expect(created.status).toBe(201);
    expect(created.body.data).toEqual({ table: linked });
    expect(createTable).toHaveBeenLastCalledWith({
      id: TABLE_ID,
      name: 'Test Table',
      projectId: PROJECT_ID,
    });

    createTable.mockResolvedValueOnce({ table: ENTRY, created: true });
    const unlinked = await request(makeApp())
      .post('/api/tables')
      .send({ id: TABLE_ID, name: 'Test Table', projectId: null });
    expect(unlinked.status).toBe(201);
    expect(createTable).toHaveBeenLastCalledWith({
      id: TABLE_ID,
      name: 'Test Table',
      projectId: null,
    });
  });

  it('400s a malformed projectId before the service runs', async () => {
    for (const projectId of [3, '', '   ', 'none', ' None ', `${PROJECT_ID}\u0007`, {}]) {
      const response = await request(makeApp())
        .post('/api/tables')
        .send({ id: TABLE_ID, name: 'Test Table', projectId });
      expect({ projectId, status: response.status }).toEqual({ projectId, status: 400 });
    }
    const none = await request(makeApp())
      .post('/api/tables')
      .send({ id: TABLE_ID, name: 'Test Table', projectId: 'none' });
    expect(JSON.stringify(none.body)).toContain('or null (none is the list filter)');
    expect(createTable).not.toHaveBeenCalled();
  });

  it('passes the service refusal of a project target through', async () => {
    createTable.mockRejectedValueOnce(
      new AppError(`Project ${PROJECT_ID} not found`, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND)
    );
    const missing = await request(makeApp())
      .post('/api/tables')
      .send({ id: TABLE_ID, name: 'Test Table', projectId: PROJECT_ID });
    expect(missing.status).toBe(404);

    createTable.mockRejectedValueOnce(
      new AppError(
        `${PROJECT_ID} is not a project`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      )
    );
    const folder = await request(makeApp())
      .post('/api/tables')
      .send({ id: TABLE_ID, name: 'Test Table', projectId: PROJECT_ID });
    expect(folder.status).toBe(400);
    expect(JSON.stringify(folder.body)).toContain('is not a project');
  });

  it('passes service conflicts through as 409', async () => {
    createTable.mockRejectedValueOnce(
      new AppError('A table named "Test Table" already exists', ErrorCode.CONFLICT, 409)
    );
    const response = await request(makeApp())
      .post('/api/tables')
      .send({ id: TABLE_ID, name: 'Test Table' });
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain('already exists');
  });

  it('renames with 200, trimming both names before the service runs', async () => {
    renameTable.mockResolvedValueOnce({ ...ENTRY, name: 'Renamed Table' });
    const response = await request(makeApp())
      .patch(`/api/tables/${TABLE_ID}`)
      .send({ name: '  Renamed Table ', expectedName: ' Test Table ' });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ table: { ...ENTRY, name: 'Renamed Table' } });
    expect(renameTable).toHaveBeenCalledWith(TABLE_ID, {
      name: 'Renamed Table',
      expectedName: 'Test Table',
    });
  });

  it('400s malformed rename bodies without calling the service', async () => {
    for (const body of [
      [],
      {},
      { name: 'Only Name' },
      { expectedName: 'Old' },
      { name: 3, expectedName: 'Old' },
      { name: 'New', expectedName: 'Old', extra: true },
    ]) {
      const response = await request(makeApp())
        .patch(`/api/tables/${TABLE_ID}`)
        .send(body as object);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    expect(renameTable).not.toHaveBeenCalled();
    expect(updateTablePlacement).not.toHaveBeenCalled();
  });

  it('links and unlinks a project with { projectId }, no concurrency token needed', async () => {
    updateTablePlacement.mockResolvedValueOnce({ ...ENTRY, projectId: PROJECT_ID });
    const linked = await request(makeApp())
      .patch(`/api/tables/${TABLE_ID}`)
      .send({ projectId: ` ${PROJECT_ID} ` });
    expect(linked.status).toBe(200);
    expect(linked.body.data).toEqual({ table: { ...ENTRY, projectId: PROJECT_ID } });
    expect(updateTablePlacement).toHaveBeenLastCalledWith(TABLE_ID, { projectId: PROJECT_ID });

    updateTablePlacement.mockResolvedValueOnce(ENTRY);
    const unlinked = await request(makeApp())
      .patch(`/api/tables/${TABLE_ID}`)
      .send({ projectId: null });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.data).toEqual({ table: ENTRY });
    expect(updateTablePlacement).toHaveBeenLastCalledWith(TABLE_ID, { projectId: null });
    expect(renameTable).not.toHaveBeenCalled();
    // A lone placement needs no separate pre-check: the service checks as it writes.
    expect(assertTablePlacement).not.toHaveBeenCalled();
  });

  it('reorders with { sortOrder }, alone or with a projectId', async () => {
    updateTablePlacement.mockResolvedValueOnce({ ...ENTRY, sortOrder: 2 });
    const reordered = await request(makeApp())
      .patch(`/api/tables/${TABLE_ID}`)
      .send({ sortOrder: 2 });
    expect(reordered.status).toBe(200);
    expect(reordered.body.data).toEqual({ table: { ...ENTRY, sortOrder: 2 } });
    expect(updateTablePlacement).toHaveBeenLastCalledWith(TABLE_ID, { sortOrder: 2 });

    updateTablePlacement.mockResolvedValueOnce({ ...ENTRY, projectId: PROJECT_ID, sortOrder: 0 });
    const placed = await request(makeApp())
      .patch(`/api/tables/${TABLE_ID}`)
      .send({ projectId: PROJECT_ID, sortOrder: 0 });
    expect(placed.status).toBe(200);
    expect(updateTablePlacement).toHaveBeenLastCalledWith(TABLE_ID, {
      projectId: PROJECT_ID,
      sortOrder: 0,
    });
    expect(assertTablePlacement).not.toHaveBeenCalled();
  });

  it('400s a malformed sortOrder without calling the service', async () => {
    for (const sortOrder of [-1, 1.5, '2', null, true, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await request(makeApp())
        .patch(`/api/tables/${TABLE_ID}`)
        .send({ sortOrder });
      expect({ sortOrder, status: response.status }).toEqual({ sortOrder, status: 400 });
      expect(JSON.stringify(response.body)).toContain('sortOrder must be a non-negative integer');
    }
    expect(updateTablePlacement).not.toHaveBeenCalled();
  });

  it('passes the built-in order refusal through', async () => {
    updateTablePlacement.mockRejectedValueOnce(
      new AppError(
        'Docs is a Snaglet table; Snaglet tables keep their built-in order',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      )
    );
    const builtin = await request(makeApp())
      .patch('/api/tables/table-builtin-docs')
      .send({ sortOrder: 1 });
    expect(builtin.status).toBe(400);
    expect(JSON.stringify(builtin.body)).toContain('keep their built-in order');
  });

  it('checks the placement, then renames, then places, when one body carries both', async () => {
    assertTablePlacement.mockResolvedValueOnce(ENTRY);
    renameTable.mockResolvedValueOnce({ ...ENTRY, name: 'Renamed' });
    updateTablePlacement.mockResolvedValueOnce({
      ...ENTRY,
      name: 'Renamed',
      projectId: PROJECT_ID,
    });
    const response = await request(makeApp())
      .patch(`/api/tables/${TABLE_ID}`)
      .send({ name: 'Renamed', expectedName: 'Test Table', projectId: ` ${PROJECT_ID} ` });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      table: { ...ENTRY, name: 'Renamed', projectId: PROJECT_ID },
    });
    expect(assertTablePlacement).toHaveBeenCalledWith(TABLE_ID, { projectId: PROJECT_ID });
    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0] ?? 0;
    expect(order(assertTablePlacement)).toBeLessThan(order(renameTable));
    expect(order(renameTable)).toBeLessThan(order(updateTablePlacement));

    assertTablePlacement.mockResolvedValueOnce(ENTRY);
    renameTable.mockRejectedValueOnce(
      new AppError('This table was renamed to "Other"', ErrorCode.CONFLICT, 409)
    );
    const stale = await request(makeApp())
      .patch(`/api/tables/${TABLE_ID}`)
      .send({ name: 'Renamed', expectedName: 'Gone', projectId: PROJECT_ID });
    expect(stale.status).toBe(409);
    expect(updateTablePlacement).toHaveBeenCalledTimes(1);
  });

  it('refuses a rename plus a bad link before the rename runs, so the name is unchanged', async () => {
    for (const [refusal, status] of [
      [new AppError(`Project ${PROJECT_ID} not found`, ErrorCode.NOT_FOUND, 404), 404],
      [new AppError(`${PROJECT_ID} is not a project`, ErrorCode.VALIDATION_ERROR, 400), 400],
      [
        new AppError('Test Table is archived. Restore it to move it.', ErrorCode.CONFLICT, 409),
        409,
      ],
    ] as const) {
      assertTablePlacement.mockRejectedValueOnce(refusal);
      const response = await request(makeApp())
        .patch(`/api/tables/${TABLE_ID}`)
        .send({ name: 'Renamed', expectedName: 'Test Table', projectId: PROJECT_ID });
      expect({ message: refusal.message, status: response.status }).toEqual({
        message: refusal.message,
        status,
      });
      expect(JSON.stringify(response.body)).toContain(refusal.message);
    }
    expect(assertTablePlacement).toHaveBeenCalledTimes(3);
    expect(renameTable).not.toHaveBeenCalled();
    expect(updateTablePlacement).not.toHaveBeenCalled();
  });

  it('400s malformed project links and passes the service refusals through', async () => {
    for (const body of [
      { projectId: 3 },
      { projectId: '' },
      { projectId: '   ' },
      // The list filter's value is not a body value: say null.
      { projectId: 'none' },
      { projectId: ' None ' },
      { projectId: `${PROJECT_ID}\u0007` },
      { projectId: PROJECT_ID, extra: true },
      { projectId: PROJECT_ID, name: 'Only Name' },
    ]) {
      const response = await request(makeApp())
        .patch(`/api/tables/${TABLE_ID}`)
        .send(body as object);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    const none = await request(makeApp())
      .patch(`/api/tables/${TABLE_ID}`)
      .send({ projectId: 'none' });
    expect(JSON.stringify(none.body)).toContain('or null (none is the list filter)');
    expect(updateTablePlacement).not.toHaveBeenCalled();
    expect(assertTablePlacement).not.toHaveBeenCalled();

    updateTablePlacement.mockRejectedValueOnce(
      new AppError('Docs is a Snaglet table', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST)
    );
    const builtin = await request(makeApp())
      .patch('/api/tables/table-builtin-docs')
      .send({ projectId: PROJECT_ID });
    expect(builtin.status).toBe(400);

    updateTablePlacement.mockRejectedValueOnce(
      new AppError(`Project ${PROJECT_ID} not found`, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND)
    );
    const missing = await request(makeApp())
      .patch(`/api/tables/${TABLE_ID}`)
      .send({ projectId: PROJECT_ID });
    expect(missing.status).toBe(404);
  });

  it('passes built-in refusals and stale-rename conflicts through', async () => {
    renameTable.mockRejectedValueOnce(
      new AppError('Snaglet tables cannot be renamed', ErrorCode.FORBIDDEN, HTTP_STATUS.FORBIDDEN)
    );
    const refused = await request(makeApp())
      .patch('/api/tables/table-builtin-docs')
      .send({ name: 'My Docs', expectedName: 'Docs' });
    expect(refused.status).toBe(403);

    renameTable.mockRejectedValueOnce(
      new AppError('This table was renamed to "Other"', ErrorCode.CONFLICT, 409, true, {
        table: { ...ENTRY, name: 'Other' },
      })
    );
    const stale = await request(makeApp())
      .patch(`/api/tables/${TABLE_ID}`)
      .send({ name: 'Mine', expectedName: 'Test Table' });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain('Other');
  });

  it('searches Snaglet items by kind before any /:id route, parsing the query', async () => {
    const body: TableReferenceSearchResponse = {
      results: [{ id: 'doc-1111111111111-aaaaaaaaa', title: 'Launch brief', context: null }],
      hasMore: false,
    };
    searchReferences.mockResolvedValueOnce(body);
    const found = await request(makeApp())
      .get('/api/tables/references/search')
      .query({ kind: 'doc', q: ' brief ', limit: '5', offset: '0', exclude: 'doc-1,doc-2' });
    expect(found.status).toBe(200);
    expect(found.body.data).toEqual(body);
    expect(searchReferences).toHaveBeenCalledWith({
      kind: 'doc',
      q: ' brief ',
      limit: 5,
      offset: 0,
      exclude: ['doc-1', 'doc-2'],
    });
    expect(getTableDetail).not.toHaveBeenCalled();
  });

  it('400s an unknown kind or a malformed page before searching', async () => {
    const unknown = await request(makeApp())
      .get('/api/tables/references/search')
      .query({ kind: 'credential' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toBe(
      'kind must be one of doc, project, container, thread, image, agent, member.'
    );
    const page = await request(makeApp())
      .get('/api/tables/references/search')
      .query({ kind: 'agent', limit: 'ten' });
    expect(page.status).toBe(400);
    expect(searchReferences).not.toHaveBeenCalled();
  });
});
