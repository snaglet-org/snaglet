/**
 * The link-triple floor on a fresh database:
 *
 * - every triple linkTypeMatrix.ts allows passes the SQL validator (the SQL
 *   side may be broader, never narrower);
 * - a doc may reference a chat message, so saving a doc whose body holds a
 *   `[label](message-…)` chip lands its `references` backlink, while
 *   (thread, references, message) stays invalid.
 */
import { describe, expect, it } from '@jest/globals';
import type { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { LINK_TYPE_MATRIX } from '../../../../packages/db/tables/links/linkTypeMatrix';
import { createFreshDatabase } from '../../../support/freshDatabase';

const THREAD = 'thread-1111111111111-aaaaaaaaa';
const MESSAGE = 'message-1111111111111-aaaaaaaaa';
const DOC = 'doc-1111111111111-aaaaaaaaa';

async function isValid(
  db: PostgresAdapter,
  source: string,
  relation: string,
  target: string
): Promise<boolean> {
  const { rows } = await db.query<{ valid: boolean }>(
    'SELECT public.link_triple_is_valid($1, $2, $3) AS valid',
    [source, relation, target]
  );
  return rows[0]?.valid === true;
}

/** A thread holding one message and an empty doc, on the node spine. */
async function seedNodes(db: PostgresAdapter): Promise<void> {
  await db.query(
    `INSERT INTO public.nodes (id, type) VALUES
       ($1, 'thread'), ($2, 'message'), ($3, 'doc')`,
    [THREAD, MESSAGE, DOC]
  );
  await db.query(`INSERT INTO public.threads (id, title) VALUES ($1, 'Test thread')`, [THREAD]);
  await db.query(
    `INSERT INTO public.messages (id, thread_id, role, content) VALUES ($1, $2, 'user', 'Hello')`,
    [MESSAGE, THREAD]
  );
  await db.query(`INSERT INTO public.docs (id, title, content) VALUES ($1, 'Test doc', '')`, [DOC]);
}

describe('link triples schema', () => {
  it('admits every triple linkTypeMatrix.ts allows', async () => {
    const { db, close } = await createFreshDatabase('link_triples_matrix');
    try {
      const rejected: string[] = [];
      for (const [relation, sources] of Object.entries(LINK_TYPE_MATRIX)) {
        for (const [source, targets] of Object.entries(sources)) {
          for (const targetType of targets) {
            if (!(await isValid(db, source, relation, targetType))) {
              rejected.push(`${source}|${relation}|${targetType}`);
            }
          }
        }
      }
      expect(rejected).toEqual([]);
    } finally {
      await close();
    }
  }, 120_000);

  it('lets a doc reference a message, never a thread', async () => {
    const { db, close } = await createFreshDatabase('link_triples_message');
    try {
      expect(await isValid(db, 'doc', 'references', 'message')).toBe(true);
      expect(await isValid(db, 'thread', 'references', 'message')).toBe(false);

      await seedNodes(db);
      // Saving a doc that cites the message lands its backlink.
      await db.query('UPDATE public.docs SET content = $2 WHERE id = $1', [
        DOC,
        `See [the message](${MESSAGE}).`,
      ]);
      expect(
        (
          await db.query(
            `SELECT 1 FROM public.links
              WHERE source_id = $1 AND target_id = $2 AND relation = 'references'`,
            [DOC, MESSAGE]
          )
        ).rows
      ).toHaveLength(1);
      // A thread may not cite it.
      await expect(
        db.query(
          `INSERT INTO public.links (id, source_id, target_id, relation)
           VALUES ('link-2222222222222-bbbbbbbbb', $1, $2, 'references')`,
          [THREAD, MESSAGE]
        )
      ).rejects.toThrow(/invalid link triple: \(thread, references, message\)/);
    } finally {
      await close();
    }
  }, 120_000);
});
