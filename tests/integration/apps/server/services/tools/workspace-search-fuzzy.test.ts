/**
 * workspace_search keyword fuzzy fallback — end-to-end against the real database.
 *
 * A roughly typed name falls back from keyword FTS to pg_trgm title matching.
 * The queries carry deliberate typos so a hit can only come from the fallback
 * channel, and every query token is a made-up word so it cannot collide with
 * other seed data in the shared template DB.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import searchTool from '@server/services/ToolService/handlers/search/workspaceSearch/workspaceSearch';

const STAMP = Date.now();
const DOC_TITLE = `Zephyrionic Reranker Rollout ${STAMP}`;
const CONTAINER_NAME = `Zephyrionic Swap Folder ${STAMP}`;

let homeId = '';
let subContainerId = '';
let docId = '';

async function call(input: Record<string, unknown>): Promise<string> {
  const out = await (
    searchTool as unknown as (i: unknown, s: unknown, c: unknown) => Promise<unknown>
  )(input, {}, {});
  return typeof out === 'string' ? out : JSON.stringify(out);
}

describe('workspace_search — keyword fuzzy fallback', () => {
  beforeAll(async () => {
    const home = await Containers.create({ name: `Fuzzy Home ${STAMP}` });
    homeId = home.id;
    const sub = await Containers.create({ name: CONTAINER_NAME, parentId: home.id });
    subContainerId = sub.id;
    const doc = await Docs.create({
      title: DOC_TITLE,
      content: 'Structural fuzzy fixture body.',
      containerId: home.id,
    });
    docId = doc.id;
    // Generous timeout: seeding the doc kicks off embedding generation, which is
    // unrelated to the fuzzy query path but can be slow under parallel load.
  }, 30000);

  afterAll(async () => {
    if (homeId) {
      // Deleting the home node cascades the doc + sub-container it owns.
      await getDb()
        .query(`DELETE FROM public.nodes WHERE id = $1 OR container_id = $1`, [homeId])
        .catch((err: unknown) => console.warn('db cleanup failed:', err));
    }
  });

  it('returns a doc by an approximate (typo) title match', async () => {
    const out = await call({ query: 'zephyrionic rernker', mode: 'keyword', kinds: ['doc'] });
    expect(out).toContain(docId);
    expect(out).toContain(DOC_TITLE);
    // Fuzzy is structural — never spins up the code-ish file lane.
    expect(out).not.toContain('file lane');
  });

  it('respects the kinds filter — a container query never returns the doc', async () => {
    const out = await call({
      query: 'zephyrionic swp foldr',
      mode: 'keyword',
      kinds: ['container'],
    });
    expect(out).toContain(subContainerId);
    expect(out).not.toContain(docId);
  });

  it('respects the kinds filter — a doc query never returns the container', async () => {
    const out = await call({ query: 'zephyrionic rernker', mode: 'keyword', kinds: ['doc'] });
    expect(out).toContain(docId);
    expect(out).not.toContain(subContainerId);
  });
});
