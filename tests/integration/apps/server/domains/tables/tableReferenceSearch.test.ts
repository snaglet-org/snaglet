/**
 * GET /api/tables/references/search against real PostgreSQL: one allowlisted
 * kind per request, live items only (archived, the ghost agent, replies and
 * plain containers under `project` never appear), title-prefix then contains
 * ranking, paging past excluded ids, and 400s for bad parameters.
 */
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb } from '@snaglet/db';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';
import {
  AGENT_A,
  AGENT_ARCHIVED,
  AGENT_B,
  DOC_A,
  DOC_ARCHIVED,
  DOC_B,
  DOC_TEMPLATE,
  FOLDER,
  IMAGE,
  PROJECT,
  THREAD,
  TITLES,
  cleanReferenceFixtures,
  seedReferenceFixtures,
} from '../../../../../support/tableReferenceFixtures';

const app = express();
app.use(express.json());
app.use('/api/tables', tablesRouter);
app.use(errorHandler);

interface Result {
  id: string;
  title: string;
  context: string | null;
}

async function search(query: Record<string, string>) {
  const response = await request(app).get('/api/tables/references/search').query(query);
  return response;
}

async function ids(query: Record<string, string>): Promise<string[]> {
  const response = await search(query);
  expect(response.status).toBe(200);
  return (response.body.data.results as Result[]).map((result) => result.id);
}

describe('Snaglet item reference search', () => {
  beforeEach(async () => {
    await cleanReferenceFixtures();
    await seedReferenceFixtures();
    // Later updates rank first on an empty query.
    await getDb().query(
      `UPDATE public.nodes SET updated_at = now() - (interval '1 minute' * array_position($1::text[], id))
        WHERE id = ANY($1::text[])`,
      [[DOC_B, DOC_A, DOC_TEMPLATE, DOC_ARCHIVED]]
    );
  });
  afterAll(cleanReferenceFixtures);

  it('returns live items of one kind with titles and context, newest first', async () => {
    const response = await search({ kind: 'doc' });
    expect(response.status).toBe(200);
    const results = (response.body.data.results as Result[]).filter((result) =>
      [DOC_A, DOC_B, DOC_TEMPLATE, DOC_ARCHIVED].includes(result.id)
    );
    expect(results).toEqual([
      { id: DOC_B, title: TITLES[DOC_B], context: TITLES[PROJECT] },
      { id: DOC_A, title: TITLES[DOC_A], context: TITLES[PROJECT] },
      { id: DOC_TEMPLATE, title: TITLES[DOC_TEMPLATE], context: TITLES[PROJECT] },
    ]);
  });

  it('never returns anything outside the kind, archived items or look-alikes', async () => {
    expect(await ids({ kind: 'project', q: 'Test' })).toEqual([PROJECT]);
    expect(await ids({ kind: 'container', q: 'Test' })).toEqual(
      expect.arrayContaining([PROJECT, FOLDER])
    );
    expect(await ids({ kind: 'thread', q: TITLES[THREAD] ?? '' })).toEqual([THREAD]);
    expect(await ids({ kind: 'image', q: TITLES[IMAGE] ?? '' })).toEqual([IMAGE]);
    const agents = await search({ kind: 'agent', q: 'Test Agent' });
    expect(agents.body.data.results).toEqual([
      { id: AGENT_A, title: TITLES[AGENT_A], context: 'Researcher' },
      { id: AGENT_B, title: TITLES[AGENT_B], context: 'Writer' },
    ]);
    expect(await ids({ kind: 'agent', q: 'ghost' })).toEqual([]);
    expect(await ids({ kind: 'agent' })).not.toContain(AGENT_ARCHIVED);
    expect(await ids({ kind: 'doc', q: 'Old brief' })).toEqual([]);
    expect(await ids({ kind: 'doc', q: THREAD })).toEqual([]);
  });

  it('ranks a title prefix before a contained match and matches an exact id', async () => {
    expect(await ids({ kind: 'doc', q: 'brief' })).toEqual([DOC_TEMPLATE, DOC_A]);
    expect(await ids({ kind: 'doc', q: 'BRIEF T' })).toEqual([DOC_TEMPLATE]);
    expect(await ids({ kind: 'doc', q: '%' })).toEqual([]);
    expect(await ids({ kind: 'doc', q: DOC_B })).toEqual([DOC_B]);
  });

  it('pages past excluded ids', async () => {
    const first = await search({ kind: 'doc', q: 'b', limit: '1', exclude: DOC_TEMPLATE });
    expect(first.body.data).toEqual({
      results: [{ id: DOC_B, title: TITLES[DOC_B], context: TITLES[PROJECT] }],
      hasMore: true,
    });
    const next = await search({
      kind: 'doc',
      q: 'b',
      limit: '1',
      offset: '1',
      exclude: DOC_TEMPLATE,
    });
    expect(next.body.data).toEqual({
      results: [{ id: DOC_A, title: TITLES[DOC_A], context: TITLES[PROJECT] }],
      hasMore: false,
    });
  });

  it('refuses unknown kinds and out-of-range parameters with a 400', async () => {
    const unknown = await search({ kind: 'credential' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toContain(
      'doc, project, container, thread, image, agent, member'
    );
    expect((await search({})).status).toBe(400);
    expect((await search({ kind: 'doc', limit: '0' })).status).toBe(400);
    expect((await search({ kind: 'doc', limit: '51' })).status).toBe(400);
    expect((await search({ kind: 'doc', offset: '10001' })).status).toBe(400);
    expect((await search({ kind: 'doc', q: 'x'.repeat(201) })).status).toBe(400);
    expect((await search({ kind: 'doc', exclude: 'not an id!' })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, n) => `doc-${n}`).join(',');
    expect((await search({ kind: 'doc', exclude: tooMany })).status).toBe(400);
  });
});
