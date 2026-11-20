import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import { searchLexicalWorkspace } from '@server/services/ToolService/handlers/search/workspaceSearch/lexical';
import type { SearchableKind } from '@server/services/ToolService/handlers/search/workspaceSearch/types';

const RUN = Date.now();
const TERM = `stablelexical${RUN}`;
let containerId = '';
const docIds: string[] = [];

describe('workspace lexical ordering (real managed PostgreSQL)', () => {
  beforeAll(async () => {
    const container = await Containers.create({ name: `Stable lexical ${RUN}` });
    containerId = container.id;
    const ids = Array.from(
      { length: 12 },
      (_, index) => `doc-lexical-${RUN}-${String(index).padStart(2, '0')}`
    );
    for (const id of [...ids].reverse()) {
      const doc = await Docs.create({
        id,
        title: 'Tied lexical candidate',
        content: `${TERM} identical ranked content`,
        containerId,
      });
      docIds.push(doc.id);
    }
    await getDb().query(
      `UPDATE public.nodes SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ANY($1::text[])`,
      [docIds]
    );
  });

  afterAll(async () => {
    if (!containerId) return;
    await getDb().query(`DELETE FROM public.nodes WHERE id = $1 OR container_id = $1`, [
      containerId,
    ]);
  });

  it('returns tied documents in the same id order across ten repeated searches', async () => {
    const expected = [...docIds].sort().slice(0, 5);
    const kinds = new Set<SearchableKind>(['doc']);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { hits } = await searchLexicalWorkspace({
        query: TERM,
        kinds,
        limit: 5,
        allowedContainerIds: [containerId],
        containerRowsCache: null,
        timeRange: null,
      });
      expect(hits.map((hit) => hit.id)).toEqual(expected);
    }
  });
});
