/**
 * Named-project scope on the palette route: whether a project name in the
 * query requested a scope, whether it resolved, and what happens when it did
 * not. A scope that silently fails to apply looks like success (results from
 * the wrong project), so every failure asserts both that no search ran and
 * that the response says why. Row-level filtering is covered against a real
 * database in tests/integration/apps/server/search/namedProjectScope.test.ts;
 * here the point is that the resolved project id reaches every lane.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

const paletteSearch = jest.fn();
const dbQuery = jest.fn();
const searchProjectFilesystem = jest.fn();
const searchProjectFilesystemByProjectId = jest.fn();
const searchFileNodes = jest.fn();

jest.mock('@server/services/search/paletteSearch.js', () => ({
  paletteSearch: (...args: unknown[]) => paletteSearch(...args),
}));
jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (...args: unknown[]) => dbQuery(...args) }),
}));
jest.mock('@server/services/search/filesystemSearch.js', () => ({
  searchProjectFilesystem: (...args: unknown[]) => searchProjectFilesystem(...args),
  searchProjectFilesystemByProjectId: (...args: unknown[]) =>
    searchProjectFilesystemByProjectId(...args),
}));
jest.mock('@server/services/search/fileNodeSearch.js', () => ({
  resolveFileNodeByPath: jest.fn(),
  searchFileNodes: (...args: unknown[]) => searchFileNodes(...args),
}));

import paletteSearchRoutes from '@server/routes/palette-search';
import { errorHandler } from '@server/middleware/errorHandler';

const BASE_RESULT = {
  byKind: { doc: [{ node_id: 'doc-1', kind: 'doc', score: 1, channels: ['fts'], payload: {} }] },
  channelsUsed: ['fts'],
  semanticStatus: 'ready',
  semanticStatusReason: null,
  coverage: {},
};

/**
 * The projects the fake workspace contains. Two share a name (differing only in
 * case) so ambiguity is reachable, and none is named after this repository —
 * the feature must not be tuned to one workspace's vocabulary.
 */
const PROJECTS = [
  { id: 'container-ledger', name: 'Ledger' },
  { id: 'container-payments', name: 'Payments Platform' },
  { id: 'container-vega-1', name: 'Vega' },
  { id: 'container-vega-2', name: 'vega' },
  { id: 'container-in-orbit', name: 'progress in Orbit' },
];

let app: Express;

beforeEach(() => {
  jest.clearAllMocks();
  paletteSearch.mockResolvedValue(structuredClone(BASE_RESULT));
  searchProjectFilesystem.mockResolvedValue([]);
  searchProjectFilesystemByProjectId.mockResolvedValue([]);
  searchFileNodes.mockResolvedValue([]);
  // Stands in for the exact-name lookup: `lower(btrim(name)) = ANY($1)`.
  dbQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
    const wanted = new Set((params?.[0] as string[]) ?? []);
    return { rows: PROJECTS.filter((p) => wanted.has(p.name.toLowerCase())) };
  });
  app = express();
  app.use(express.json());
  app.use('/api/search/palette', paletteSearchRoutes);
  app.use(errorHandler);
});

const search = (body: Record<string, unknown>) =>
  request(app).post('/api/search/palette').send(body);

const lastSearchInput = () => paletteSearch.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe('a resolved name becomes a real, strict scope', () => {
  it('scopes to the project and drops the phrase from the search term', async () => {
    const res = await search({ query: 'rotation policy in "Payments Platform"' });

    expect(res.status).toBe(200);
    expect(lastSearchInput()).toMatchObject({
      query: 'rotation policy',
      scope: { project_id: 'container-payments' },
    });
  });

  it('reports the scope it applied, by name and by id', async () => {
    const res = await search({ query: 'rotation policy in "Payments Platform"' });

    expect(res.body.data.executionPlan).toMatchObject({
      query: 'rotation policy',
      scopePolicy: 'strict',
      scopeSource: 'named_project',
      scopeLabel: 'Payments Platform',
      scopeId: 'container-payments',
    });
    expect(res.body.data.executionPlan.scopeError).toBeUndefined();
  });

  it('works unquoted when the trailing name is a real project', async () => {
    await search({ query: 'rotation policy in Ledger' });

    expect(lastSearchInput()).toMatchObject({
      query: 'rotation policy',
      scope: { project_id: 'container-ledger' },
    });
  });

  it('matches a name case-insensitively', async () => {
    await search({ query: 'rotation policy in "payments platform"' });

    expect(lastSearchInput()).toMatchObject({ scope: { project_id: 'container-payments' } });
  });

  it('prefers the rightmost reading, then falls back to a longer name', async () => {
    // "progress in Orbit" is a project here, and "Orbit" is not — so the
    // rightmost split misses and the longer one wins.
    await search({ query: 'notes in progress in Orbit' });

    expect(lastSearchInput()).toMatchObject({
      query: 'notes',
      scope: { project_id: 'container-in-orbit' },
    });
  });
});

describe('an unresolvable unquoted phrase is just English', () => {
  it('searches "notes in progress" verbatim and stays neutral', async () => {
    const res = await search({ query: 'notes in progress' });

    expect(lastSearchInput()).toMatchObject({ query: 'notes in progress', scope: undefined });
    expect(res.body.data.executionPlan).toMatchObject({
      query: 'notes in progress',
      scopePolicy: 'neutral',
    });
    expect(res.body.data.executionPlan.scopeError).toBeUndefined();
  });

  it('does not error — the words were never a request', async () => {
    const res = await search({ query: 'items stuck in review' });

    expect(res.status).toBe(200);
    expect(res.body.data.byKind.doc).toHaveLength(1);
  });

  it('never touches the database when there is no phrase to resolve', async () => {
    // The palette calls this on every keystroke; a lookup per character for
    // queries that cannot contain a scope is pure cost.
    await search({ query: 'rotation policy' });

    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('an unresolvable quoted phrase is an error, not a wider search', () => {
  it('returns no results and says the project does not exist', async () => {
    const res = await search({ query: 'rotation policy in "Nonexistent Project"' });

    expect(res.status).toBe(200);
    expect(res.body.data.executionPlan).toMatchObject({
      scopePolicy: 'strict',
      scopeError: { code: 'not_found', name: 'Nonexistent Project' },
    });
    expect(res.body.data.executionPlan.scopeError.message).toMatch(/no project named/i);
  });

  it('runs no search at all, so nothing out of scope can be returned', async () => {
    const res = await search({ query: 'rotation policy in "Nonexistent Project"' });

    expect(paletteSearch).not.toHaveBeenCalled();
    expect(searchProjectFilesystem).not.toHaveBeenCalled();
    expect(searchProjectFilesystemByProjectId).not.toHaveBeenCalled();
    expect(searchFileNodes).not.toHaveBeenCalled();
    expect(res.body.data.byKind).toEqual({});
    expect(res.body.data.files).toEqual([]);
    expect(res.body.data.filesystem).toEqual([]);
  });
});

describe('an ambiguous name is refused rather than guessed', () => {
  it('names the competing projects instead of picking one', async () => {
    const res = await search({ query: 'rotation policy in "Vega"' });

    expect(res.body.data.executionPlan.scopeError).toMatchObject({
      code: 'ambiguous',
      name: 'Vega',
    });
    expect(res.body.data.executionPlan.scopeError.matches.sort()).toEqual(['Vega', 'vega']);
    expect(paletteSearch).not.toHaveBeenCalled();
  });

  it('is ambiguous unquoted too — the risk is identical either way', async () => {
    const res = await search({ query: 'rotation policy in Vega' });

    expect(res.body.data.executionPlan.scopeError).toMatchObject({ code: 'ambiguous' });
    expect(paletteSearch).not.toHaveBeenCalled();
  });
});

describe('two scopes at once is a conflict, never a precedence rule', () => {
  it('refuses a body projectId that disagrees with the typed name', async () => {
    const res = await search({
      query: 'rotation policy in "Ledger"',
      projectId: 'container-payments',
    });

    expect(res.body.data.executionPlan.scopeError).toMatchObject({ code: 'conflict' });
    expect(paletteSearch).not.toHaveBeenCalled();
  });

  it('refuses a disagreeing containerId the same way', async () => {
    const res = await search({
      query: 'rotation policy in "Ledger"',
      containerId: 'container-somewhere-else',
    });

    expect(res.body.data.executionPlan.scopeError).toMatchObject({ code: 'conflict' });
    expect(paletteSearch).not.toHaveBeenCalled();
  });

  it('allows naming the project you are already scoped to', async () => {
    // Agreement is not a conflict — the user restated the scope they had.
    await search({ query: 'rotation policy in "Ledger"', projectId: 'container-ledger' });

    expect(lastSearchInput()).toMatchObject({ scope: { project_id: 'container-ledger' } });
  });

  it('leaves a body-only scope exactly as it was', async () => {
    const res = await search({ query: 'rotation policy', projectId: 'container-payments' });

    expect(lastSearchInput()).toMatchObject({ scope: { project_id: 'container-payments' } });
    expect(res.body.data.executionPlan).toMatchObject({
      scopePolicy: 'strict',
      scopeSource: 'explicit',
    });
    // An id-scoped caller already knows the name it asked for.
    expect(res.body.data.executionPlan.scopeLabel).toBeUndefined();
  });
});

describe('the scope reaches every lane, including files', () => {
  it('points the filesystem walk at the named project, not the caller thread', async () => {
    await search({ query: 'rotation policy in "Ledger"', threadId: 'thread-elsewhere' });

    expect(searchProjectFilesystemByProjectId).toHaveBeenCalledWith(
      'container-ledger',
      'rotation policy',
      null
    );
    expect(searchProjectFilesystem).not.toHaveBeenCalled();
  });

  it('restricts embedded file-node search to the named project', async () => {
    await search({ query: 'rotation policy in "Ledger"' });

    expect(searchFileNodes).toHaveBeenCalledWith('rotation policy', expect.any(Number), {
      projectId: 'container-ledger',
    });
  });

  it('keeps the file lanes running — a scoped search still searches files', async () => {
    // Skipping them would answer "find X in project Y" without ever looking at
    // project Y's files.
    searchProjectFilesystemByProjectId.mockResolvedValue([
      { type: 'filesystem', filesystemKind: 'file', name: 'a.ts', path: '/p/a.ts', score: 1 },
    ]);

    const res = await search({ query: 'rotation policy in "Ledger"' });

    expect(res.body.data.filesystem).toHaveLength(1);
  });

  it('still uses the caller thread when no project was named', async () => {
    await search({ query: 'rotation policy', threadId: 'thread-1' });

    expect(searchProjectFilesystem).toHaveBeenCalledWith('thread-1', 'rotation policy', null);
    expect(searchProjectFilesystemByProjectId).not.toHaveBeenCalled();
  });
});

describe('named scope composes with the filters that already existed', () => {
  it('keeps a kind prefix and applies the scope', async () => {
    await search({ query: 'doc:draft spec in "Ledger"' });

    expect(lastSearchInput()).toMatchObject({
      query: 'draft spec',
      kinds: ['doc'],
      scope: { project_id: 'container-ledger' },
    });
  });

  it.each(['keyword', 'semantic', 'hybrid'])('applies on the %s tier', async (mode) => {
    await search({ query: 'rotation policy in "Ledger"', mode });

    expect(lastSearchInput()).toMatchObject({
      mode,
      query: 'rotation policy',
      scope: { project_id: 'container-ledger' },
    });
  });

  it('narrows to the kinds the scoping SQL can actually filter', async () => {
    // Project scope is only expressible for container/doc/thread/message; a
    // kind without a scoped query would otherwise come back unfiltered.
    await search({ query: 'rotation policy in "Ledger"' });

    const kinds = lastSearchInput().kinds as string[];
    expect(kinds.sort()).toEqual(['container', 'doc', 'message', 'thread']);
  });
});
