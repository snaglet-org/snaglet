/**
 * The palette (and @-mention search, which shares it) offers canonical tool
 * ids only. A merged tool's alias ids (`exec_command`, `sketch_create`) stay
 * callable, but their soft-retired rows are still `tools` rows with
 * live nodes, so tool hits for them must drop out at hydration.
 */
import { describe, expect, it, jest } from '@jest/globals';

const mockQuery = jest.fn();

jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: mockQuery }),
}));

import { hydratePaletteHits, paletteHit } from '@server/services/search/paletteSearchHydration';

const toolRow = (id: string) => ({
  id,
  name: id,
  description: `${id} description`,
  type: 'builtin',
  source: null,
  category_path: 'system',
  provider_id: null,
  tier: 'standard',
  enabled: id === 'shell',
  sort_order: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

describe('palette tool hits', () => {
  it('drops retired old ids and keeps canonical tools', async () => {
    const ids = ['shell', 'exec_command', 'sketch_create', 'sandbox_run'];
    mockQuery.mockImplementation(async () => ({ rows: ids.map(toolRow) }));

    const hits = await hydratePaletteHits(
      'tool',
      ids.map((id) => paletteHit('tool', id, {}))
    );

    expect(hits.map((hit) => hit.node_id)).toEqual(['shell']);
  });
});
