/**
 * A doc chip to a node a doc may not reference (a discussion, a file) or to a
 * node that does not exist never breaks link sync: the doc saves through the
 * doc-link trigger, `rebuild_doc_inline_links` and `Links.replaceOutgoing`
 * (the content-ref sync path) all skip such targets and still link the
 * allowed ones. Database access is real.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Docs, Links, getDb } from '@snaglet/db';

const DOC = 'doc-1111111111111-aaaaaaaaa';
const OTHER_DOC = 'doc-2222222222222-bbbbbbbbb';
const DISCUSSION = 'discussion-1111111111111-aaaaaaaaa';
const FILE = 'file-1111111111111-aaaaaaaaa';
const MISSING = 'doc-0000000000000-missing00';

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [
    [DOC, OTHER_DOC, DISCUSSION, FILE],
  ]);
}

async function linkedTargets(): Promise<string[]> {
  const { rows } = await getDb().query<{ target_id: string }>(
    `SELECT target_id FROM public.links
      WHERE source_id = $1 AND relation = 'references'
      ORDER BY target_id`,
    [DOC]
  );
  return rows.map((row) => row.target_id);
}

describe('doc links skip targets a doc may not reference', () => {
  beforeAll(async () => {
    await cleanup();
    await getDb().query(
      `INSERT INTO public.nodes (id, type) VALUES ($1, 'discussion'), ($2, 'file')`,
      [DISCUSSION, FILE]
    );
    await Docs.create({ id: OTHER_DOC, title: 'Other doc' });
  });
  afterAll(cleanup);

  it('saves a doc that cites a discussion, a file and a missing node', async () => {
    await Docs.create({
      id: DOC,
      title: 'Test doc',
      content: `[a doc](${OTHER_DOC}), [a discussion](${DISCUSSION}), [a file](${FILE}), [gone](${MISSING})`,
    });
    expect(await linkedTargets()).toEqual([OTHER_DOC]);
  });

  it('replaceOutgoing links the allowed targets and skips the rest', async () => {
    await expect(
      Links.replaceOutgoing(DOC, 'references', [DISCUSSION, MISSING, FILE, OTHER_DOC])
    ).resolves.toBeUndefined();
    expect(await linkedTargets()).toEqual([OTHER_DOC]);
  });

  it('rebuild_doc_inline_links relinks the allowed targets from the body and skips the rest', async () => {
    await getDb().query('DELETE FROM public.links WHERE source_id = $1', [DOC]);
    await getDb().query('SELECT public.rebuild_doc_inline_links($1)', [DOC]);
    expect(await linkedTargets()).toEqual([OTHER_DOC]);
  });
});
