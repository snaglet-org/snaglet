/**
 * The doc-link trigger (`sync_doc_links`) and `rebuild_doc_inline_links`
 * count a line link to a doc however its range is written: canonical
 * `#L3-L5`, the way the chip label reads it (`#L3–5`, `#L3-5`), a lowercase
 * `l`, or a dash a markdown parser percent-encoded. The fixtures are the ones
 * `parseLineFragment` is tested on, so the database and the app agree on
 * which links name the doc. Runs on a fresh database provisioned from the
 * baseline.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { parseLineFragment } from '@snaglet/shared/utils/docLineRef';
import { createFreshDatabase, type FreshDatabase } from '../../../support/freshDatabase';
import { LINE_FRAGMENT_FIXTURES, OUT_OF_ORDER_FRAGMENTS } from '../../../support/lineLinkFixtures';

const TARGET = 'doc-1794864925672-y0r38dfw5';

let fresh: FreshDatabase;
let db: PostgresAdapter;

async function createDoc(id: string, content: string): Promise<void> {
  await db.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'doc')`, [id]);
  await db.query(`INSERT INTO public.docs (id, title, content) VALUES ($1, $2, $3)`, [
    id,
    `Doc ${id}`,
    content,
  ]);
}

async function linkedFrom(source: string): Promise<string[]> {
  const { rows } = await db.query<{ target_id: string }>(
    `SELECT target_id FROM public.links
      WHERE source_id = $1 AND relation = 'references'
      ORDER BY target_id`,
    [source]
  );
  return rows.map((row) => row.target_id);
}

/** A distinct, valid doc id per case. */
const sourceId = (index: number) => `doc-17948649256${String(index).padStart(2, '0')}-src${index}`;

const link = (fragment: string) => `See [Getting Started Worksheet › L3–5](${TARGET}#${fragment}).`;

beforeAll(async () => {
  fresh = await createFreshDatabase('doc_line_links');
  db = fresh.db;
  await createDoc(TARGET, '# Worksheet\n\none\ntwo\nthree\nfour\nfive');
});

afterAll(async () => {
  await fresh?.close();
});

describe('doc-link trigger and line-link ranges', () => {
  const cases = LINE_FRAGMENT_FIXTURES.map(({ fragment, lines }, index) => ({
    fragment,
    isRange: lines !== null,
    source: sourceId(index),
  }));

  it.each(cases)(
    'a link to #$fragment links the doc exactly when the app reads it as a range',
    async ({ fragment, isRange, source }) => {
      expect(parseLineFragment(fragment) !== null).toBe(isRange);
      await createDoc(source, link(fragment));
      expect(await linkedFrom(source)).toEqual(isRange ? [TARGET] : []);

      // The repair path reads the body the same way.
      await db.query(`DELETE FROM public.links WHERE source_id = $1`, [source]);
      await db.query(`SELECT public.rebuild_doc_inline_links($1)`, [source]);
      expect(await linkedFrom(source)).toEqual(isRange ? [TARGET] : []);
    }
  );

  it.each(OUT_OF_ORDER_FRAGMENTS.map((fragment, index) => ({ fragment, index })))(
    'a backwards range #$fragment still links the doc it names',
    async ({ fragment, index }) => {
      const source = sourceId(90 + index);
      await createDoc(source, link(fragment));
      expect(await linkedFrom(source)).toEqual([TARGET]);
    }
  );

  it('an edit that rewrites the range keeps the link, and removing it drops the link', async () => {
    const source = sourceId(99);
    await createDoc(source, link('L3-L5'));
    await db.query(`UPDATE public.docs SET content = $2 WHERE id = $1`, [source, link('L3–5')]);
    expect(await linkedFrom(source)).toEqual([TARGET]);
    await db.query(`UPDATE public.docs SET content = 'no links now' WHERE id = $1`, [source]);
    expect(await linkedFrom(source)).toEqual([]);
  });

  it('links a heading link to its doc, and never a link to a heading of the same doc', async () => {
    const self = 'doc-1794864925700-selfindex';
    await createDoc(
      self,
      [
        '# Index',
        '',
        '- [Q1](#h=q1)',
        '- [Q2](#q2)',
        `- [Q3](${self}#h=q3)`,
        `- [Worksheet](${TARGET}#h=worksheet)`,
        '',
        '## Q1',
        '## Q2',
        '## Q3',
      ].join('\n')
    );
    expect(await linkedFrom(self)).toEqual([TARGET]);

    await db.query(`DELETE FROM public.links WHERE source_id = $1`, [self]);
    await db.query(`SELECT public.rebuild_doc_inline_links($1)`, [self]);
    expect(await linkedFrom(self)).toEqual([TARGET]);
  });
});
