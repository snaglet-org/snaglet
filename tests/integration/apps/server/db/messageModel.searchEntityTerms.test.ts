/**
 * Messages.updateSearchEntityTerms against the real database: a message whose
 * content has no literal match for an entity term becomes findable by that
 * term once the entity is stored, and is findable by its own content with no
 * enrichment at all. `search_text` is a stored generated column over
 * `content || ' ' || search_entity_terms`, which the read side queries directly.
 * The entity list here is canned; the darwin-only NLTagger round trip is in
 * tests/unit/apps/server/services/nlp/nlpHelperReal.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Messages, Threads, Users } from '@snaglet/db';

const PREFIX = 'msg-searchtext-test';
const THREAD_ID = `thread-${PREFIX}`;
const MESSAGE_ID = `message-${PREFIX}`;
// Deliberately contains no "Acme"/"Corp" substring — the whole point is that
// the entity term below is not a literal substring of the content.
const CONTENT = 'met with the vendor yesterday about the renewal';
const ENTITY = 'Acme Corp';

/** The exact read-side expression ftsSearchNodes.ts uses for message search. */
async function matchesKeyword(term: string): Promise<boolean> {
  const { rows } = await getDb().query(
    `SELECT 1 FROM public.messages
      WHERE id = $1
        AND search_text @@ plainto_tsquery('english', $2)`,
    [MESSAGE_ID, term]
  );
  return rows.length > 0;
}

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM public.messages WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id = $1 OR id = $2`, [THREAD_ID, MESSAGE_ID]);
}

describe('Messages.updateSearchEntityTerms — entity terms become searchable', () => {
  beforeAll(async () => {
    await cleanup();
    await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
    const user = await Users.getOrCreateLocalUser();
    await Messages.create({
      id: MESSAGE_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: CONTENT,
      agentId: null,
      userId: user.id,
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  it('before enrichment, the entity term does not match (not a content substring)', async () => {
    await expect(matchesKeyword('Acme')).resolves.toBe(false);
  });

  it('before enrichment, a real content word already matches via the generated vector', async () => {
    await expect(matchesKeyword('vendor')).resolves.toBe(true);
  });

  it('after enrichment, the entity term matches', async () => {
    await Messages.updateSearchEntityTerms(MESSAGE_ID, [ENTITY]);
    await expect(matchesKeyword('Acme')).resolves.toBe(true);
    await expect(matchesKeyword('Corp')).resolves.toBe(true);
  });

  it('after enrichment, the original content is still searchable (entities are appended, not replacing content)', async () => {
    await expect(matchesKeyword('vendor')).resolves.toBe(true);
    await expect(matchesKeyword('renewal')).resolves.toBe(true);
  });

  it('search_text is a populated tsvector, not left NULL', async () => {
    const { rows } = await getDb().query<{ search_text: string | null }>(
      `SELECT search_text::text AS search_text FROM public.messages WHERE id = $1`,
      [MESSAGE_ID]
    );
    expect(rows[0]?.search_text).not.toBeNull();
  });
});
