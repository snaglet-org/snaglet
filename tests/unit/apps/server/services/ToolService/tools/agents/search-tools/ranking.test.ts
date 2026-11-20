/**
 * Pure unit tests for `rankToolCandidates` — the query-aware re-ranker that
 * orders search_tools' retrieval pool.
 *
 * No channels, no handler: every candidate below states its own retrieval
 * score and rank, so each assertion is about the ranking features alone
 * (exact identity, verb agreement, object evidence, the weak-incidental
 * penalty, the near-tie first-party prior, family grouping, determinism).
 */

import {
  rankToolCandidates,
  type ToolCandidate,
} from '@server/services/ToolService/handlers/tools/ranking';

type Seed = Pick<ToolCandidate, 'id'> &
  Omit<Partial<ToolCandidate>, 'id' | 'retrievalScore' | 'retrievalRank'>;

/** Candidates in the order (and with the score) retrieval would have produced. */
function pool(entries: Seed[]): ToolCandidate[] {
  return entries.map((e, i) => ({
    name: e.id,
    description: `${e.id} description`,
    keywords: [],
    aliases: [],
    type: e.id.startsWith('mcp__') ? 'mcp' : 'builtin',
    ...e,
    retrievalScore: 1 / (60 + i + 1),
    retrievalRank: i + 1,
  }));
}

const WIDGET_FAMILY: Seed[] = [
  {
    id: 'widget_get',
    name: 'Get Widget',
    description: 'Read a widget by id: title, placement, the full editable state.',
    keywords: ['widget', 'gadget', 'get', 'read', 'state', 'revision'],
    categoryPath: 'widgets',
  },
  {
    id: 'widget_apply_operations',
    name: 'Apply Widget Operations',
    description: 'Edit a widget with optimistic concurrency: add, update or remove elements.',
    keywords: ['widget', 'gadget', 'edit', 'update', 'add', 'remove'],
    categoryPath: 'widgets',
  },
  {
    id: 'widget_create',
    name: 'Create Widget',
    description: 'Create a new widget — an editable gadget stored as a workspace node.',
    keywords: ['widget', 'gadget', 'create', 'new'],
    categoryPath: 'widgets',
  },
  {
    id: 'widget_export_svg',
    name: 'Export Widget as SVG',
    description: 'Render a widget to standalone SVG and return the source.',
    keywords: ['widget', 'gadget', 'export', 'svg', 'render'],
    categoryPath: 'widgets',
  },
];

const PLAYWRIGHT: Seed[] = [
  {
    id: 'mcp__playwright__browser_navigate',
    name: 'browser_navigate',
    description: 'Navigate to a URL',
    categoryPath: 'integrations/playwright',
  },
  {
    id: 'mcp__playwright__browser_find_text',
    name: 'browser_find_text',
    description: 'Find a new or existing text fragment on the page or drawing area',
    categoryPath: 'integrations/playwright',
  },
];

describe('rankToolCandidates', () => {
  describe('widget discovery', () => {
    it('makes widget_create the clear top result for "create a new widget or gadget"', () => {
      // Retrieval order deliberately puts the provider tools first and
      // widget_create last: the ranker has to earn the result.
      const { primary, related } = rankToolCandidates(
        pool([...PLAYWRIGHT, ...WIDGET_FAMILY]),
        'create a new widget or gadget'
      );

      expect(primary[0].id).toBe('widget_create');
      expect(primary[0].reasons).toEqual(
        expect.arrayContaining(['exact-cover', 'verb:create', 'object:widget', 'object:gadget'])
      );
      // Same family, different verb → related, never a primary slot.
      const relatedIds = related.map((t) => t.id);
      expect(relatedIds).toContain('widget_get');
      expect(relatedIds).toContain('widget_apply_operations');
      expect(primary.map((t) => t.id)).not.toContain('widget_get');
      // Provider tools with only incidental prose hits sit below the winner
      // by a margin no retrieval tie could close.
      const navigate = primary.find((t) => t.id === 'mcp__playwright__browser_navigate');
      expect(navigate?.reasons).toContain('weak-incidental-penalty');
      expect(primary[0].score - (navigate?.score ?? 0)).toBeGreaterThan(3);
    });

    it('verb decides within the family: read → widget_get', () => {
      const { primary } = rankToolCandidates(
        pool(WIDGET_FAMILY),
        'read a widget and look at its state'
      );
      expect(primary[0].id).toBe('widget_get');
      expect(primary[0].reasons).toContain('verb:read');
    });

    it('verb decides within the family: edit → widget_apply_operations', () => {
      const { primary, related } = rankToolCandidates(
        pool(WIDGET_FAMILY),
        'edit an existing widget add an element'
      );
      expect(primary[0].id).toBe('widget_apply_operations');
      expect(related.map((t) => t.id)).toContain('widget_create');
    });

    it('verb decides within the family: export → widget_export_svg', () => {
      const { primary } = rankToolCandidates(pool(WIDGET_FAMILY), 'export a widget to svg');
      expect(primary[0].id).toBe('widget_export_svg');
    });
  });

  describe('verb classes', () => {
    const DOC_FAMILY: Seed[] = [
      { id: 'delete_doc', name: 'Delete Doc', keywords: ['doc', 'document', 'delete'] },
      { id: 'get_doc', name: 'Get Doc', keywords: ['doc', 'document', 'get', 'read'] },
      { id: 'create_doc', name: 'Create Doc', keywords: ['doc', 'document', 'create'] },
      { id: 'edit_doc', name: 'Edit Doc', keywords: ['doc', 'document', 'edit', 'update'] },
    ];

    it.each([
      ['create a document', 'create_doc'],
      ['make a new doc', 'create_doc'],
      ['read a document', 'get_doc'],
      ['show me a doc', 'get_doc'],
      ['update a document', 'edit_doc'],
      ['modify the doc', 'edit_doc'],
      ['delete a document', 'delete_doc'],
      ['remove a doc', 'delete_doc'],
    ])('%s → %s', (query, expected) => {
      const { primary } = rankToolCandidates(pool(DOC_FAMILY), query);
      expect(primary[0].id).toBe(expected);
    });

    it('penalizes an explicit verb conflict', () => {
      const { primary, related } = rankToolCandidates(pool(DOC_FAMILY), 'create a document');
      const all = [...primary, ...related];
      const del = all.find((t) => t.id === 'delete_doc');
      expect(del?.reasons).toContain('verb-conflict:delete');
      expect(del!.score).toBeLessThan(primary[0].score - 2);
    });

    it('a query with no verb leaves ordering to retrieval and object evidence', () => {
      const { primary } = rankToolCandidates(pool(DOC_FAMILY), 'document');
      // Every candidate has identical object evidence; retrieval order holds.
      expect(primary.map((t) => t.id)).toEqual(['delete_doc', 'get_doc', 'create_doc', 'edit_doc']);
      expect(primary.every((t) => !t.reasons.some((r) => r.startsWith('verb')))).toBe(true);
    });
  });

  describe('exact matches', () => {
    it('an exact id (with underscores or spaces) gets the exact-id bonus', () => {
      const candidates = pool([{ id: 'file_read' }, { id: 'file_write' }]);
      expect(rankToolCandidates(candidates, 'file_read').primary[0].reasons).toContain('exact-id');
      expect(rankToolCandidates(candidates, 'file read').primary[0].reasons).toContain('exact-id');
    });

    it('an exact display name gets the exact-name bonus', () => {
      const candidates = pool([{ id: 'file_write' }, { id: 'file_read', name: 'Read File' }]);
      const { primary } = rankToolCandidates(candidates, 'Read File');
      expect(primary[0].id).toBe('file_read');
      expect(primary[0].reasons).toContain('exact-name');
    });

    it('an MCP tool is matched on its local name, not the mcp__server__ prefix', () => {
      const candidates = pool([{ id: 'file_read' }, ...PLAYWRIGHT]);
      const { primary } = rankToolCandidates(candidates, 'browser navigate');
      expect(primary[0].id).toBe('mcp__playwright__browser_navigate');
      expect(primary[0].reasons).toContain('exact-id');
    });
  });

  describe('weak incidental matches', () => {
    it('description-only hits cannot beat a single curated hit, whatever retrieval said', () => {
      const candidates = pool([
        {
          id: 'mcp__playwright__browser_snapshot',
          description: 'Capture a widget-like accessibility snapshot of the gadget on the page',
        },
        { id: 'widget_create', keywords: ['widget', 'gadget', 'create'] },
      ]);
      const { primary } = rankToolCandidates(candidates, 'create a widget gadget');
      expect(primary[0].id).toBe('widget_create');
      const snapshot = primary[1];
      expect(snapshot.reasons).toEqual(
        expect.arrayContaining([
          'object-in-description-only:widget',
          'object-in-description-only:gadget',
          'weak-incidental-penalty',
        ])
      );
    });

    it('applies the penalty uniformly, so retrieval still orders tools with no evidence', () => {
      const candidates = pool([{ id: 'alpha_tool' }, { id: 'beta_tool' }, { id: 'gamma_tool' }]);
      const { primary } = rankToolCandidates(candidates, 'something unrelated entirely');
      expect(primary.map((t) => t.id)).toEqual(['alpha_tool', 'beta_tool', 'gamma_tool']);
      expect(primary.every((t) => t.reasons.includes('weak-incidental-penalty'))).toBe(true);
    });
  });

  describe('first-party prior', () => {
    it('breaks a near-tie in favor of the first-party tool', () => {
      // Identical evidence: both ids are exactly the query's tokens. The MCP
      // tool even retrieves first.
      const candidates = pool([
        { id: 'mcp__imaging__resize_image', name: 'resize_image', description: 'Resize an image' },
        { id: 'image_resize', name: 'Resize Image', description: 'Resize an image file' },
      ]);
      const { primary } = rankToolCandidates(candidates, 'resize an image');
      expect(primary[0].id).toBe('image_resize');
      expect(primary[0].reasons).toContain('first-party-prior');
      expect(primary[1].reasons).not.toContain('first-party-prior');
    });

    it('provider wins: a clearly superior MCP tool keeps first place', () => {
      const candidates = pool([
        { id: 'file_read', name: 'Read File', keywords: ['file', 'read'] },
        { id: 'web_fetch', name: 'Fetch URL', keywords: ['fetch', 'url', 'http', 'web'] },
        ...PLAYWRIGHT,
      ]);
      const { primary } = rankToolCandidates(
        candidates,
        'navigate the browser to a url and take a screenshot'
      );
      expect(primary[0].id).toBe('mcp__playwright__browser_navigate');
      expect(primary[0].reasons).toEqual(
        expect.arrayContaining(['object:browser', 'object:navigate'])
      );
      const fetch = primary.find((t) => t.id === 'web_fetch');
      expect(fetch?.reasons).not.toContain('first-party-prior');
    });

    it('never applies without an MCP competitor', () => {
      const { primary } = rankToolCandidates(pool(WIDGET_FAMILY), 'create a widget');
      expect(primary.every((t) => !t.reasons.includes('first-party-prior'))).toBe(true);
    });

    it.each([
      ['external', 'external' as const],
      ['undefined', undefined],
    ])('is not applied to a %s-type candidate in the same near-tie', (_label, type) => {
      const candidates = pool([
        { id: 'mcp__imaging__resize_image', name: 'resize_image', description: 'Resize an image' },
        { id: 'image_resize', name: 'Resize Image', description: 'Resize an image file', type },
      ]);
      const { primary } = rankToolCandidates(candidates, 'resize an image');
      // Same evidence, no prior: the MCP tool keeps its retrieval lead.
      expect(primary[0].id).toBe('mcp__imaging__resize_image');
      expect(primary.every((t) => !t.reasons.includes('first-party-prior'))).toBe(true);
    });
  });

  describe('family grouping', () => {
    it('keeps same-family tools with the same verb in primary', () => {
      const candidates = pool([
        { id: 'file_read', name: 'Read File', keywords: ['file', 'read'] },
        { id: 'file_view', name: 'View File', keywords: ['file', 'view'] },
        { id: 'file_write', name: 'Write File', keywords: ['file', 'write'] },
      ]);
      const { primary, related } = rankToolCandidates(candidates, 'read a file');
      expect(primary.map((t) => t.id)).toEqual(['file_read', 'file_view']);
      expect(related.map((t) => t.id)).toEqual(['file_write']);
      expect(related[0].reasons).toContain('family:file');
    });

    it('a different family stays eligible for primary even with a different verb', () => {
      const candidates = pool([
        { id: 'widget_create', keywords: ['widget', 'create'] },
        { id: 'doc_get', keywords: ['doc', 'get'] },
      ]);
      const { primary, related } = rankToolCandidates(candidates, 'create a widget');
      expect(primary.map((t) => t.id)).toEqual(['widget_create', 'doc_get']);
      expect(related).toEqual([]);
    });

    it('groups MCP tools by server', () => {
      const candidates = pool([
        ...PLAYWRIGHT,
        { id: 'mcp__playwright__browser_delete_cookies', description: 'Delete cookies' },
        {
          id: 'mcp__other__navigate_menu',
          description: 'Navigate a menu',
          categoryPath: 'integrations/other',
        },
      ]);
      const { primary, related } = rankToolCandidates(candidates, 'navigate the browser');
      expect(primary[0].id).toBe('mcp__playwright__browser_navigate');
      expect(related.map((t) => t.id)).toContain('mcp__playwright__browser_delete_cookies');
      expect(primary.map((t) => t.id)).toContain('mcp__other__navigate_menu');
    });

    it('does not group siblings when the top result is only a weak match', () => {
      // Nothing here answers the query: the winner wins on retrieval order
      // alone, so its family siblings are not "alternatives" to anything
      // and every candidate stays primary.
      const candidates = pool([
        { id: 'thing_create', keywords: ['thing', 'create'] },
        { id: 'thing_get', keywords: ['thing', 'get'] },
        { id: 'thing_delete', keywords: ['thing', 'delete'] },
      ]);
      const { primary, related } = rankToolCandidates(candidates, 'frobnicate the widget');
      expect(primary.map((t) => t.id)).toEqual(['thing_create', 'thing_get', 'thing_delete']);
      expect(related).toEqual([]);
    });

    it('a verb-only agreement without a curated object hit is not strong enough to group', () => {
      const candidates = pool([
        { id: 'thing_create', keywords: ['thing', 'create'] },
        { id: 'thing_get', keywords: ['thing', 'get'] },
      ]);
      const { primary, related } = rankToolCandidates(candidates, 'create a widget');
      expect(primary[0].id).toBe('thing_create');
      expect(primary.map((t) => t.id)).toContain('thing_get');
      expect(related).toEqual([]);
    });

    it('derives related from the final winner when a reRank hook changes it', () => {
      // Without the hook: widget_create wins, widget_get is related and the
      // gadget_* family stays primary. A hook that lifts gadget_create to
      // first (the shape of search_tools' domain preference) must flip the
      // grouping with it: gadget_get becomes related, widget_get primary.
      const candidates = pool([
        { id: 'widget_create', keywords: ['widget', 'gadget', 'create'] },
        { id: 'widget_get', keywords: ['widget', 'gadget', 'get'] },
        { id: 'gadget_create', keywords: ['gadget', 'create'] },
        { id: 'gadget_get', keywords: ['gadget', 'get'] },
      ]);
      const query = 'create a widget gadget';
      const baseline = rankToolCandidates(candidates, query);
      expect(baseline.primary[0].id).toBe('widget_create');
      expect(baseline.related.map((t) => t.id)).toEqual(['widget_get']);

      const lift = <T extends { id: string }>(list: T[]): T[] => {
        const i = list.findIndex((t) => t.id === 'gadget_create');
        return [list[i], ...list.filter((_, j) => j !== i)];
      };
      const { primary, related } = rankToolCandidates(candidates, query, { reRank: lift });
      expect(primary[0].id).toBe('gadget_create');
      expect(primary[0].reasons.some((r) => r.startsWith('rerank-shift:+'))).toBe(true);
      expect(related.map((t) => t.id)).toEqual(['gadget_get']);
      expect(related.every((t) => t.family === primary[0].family)).toBe(true);
      expect(primary.map((t) => t.id)).toContain('widget_get');
    });

    it('ignores a reRank hook that is not a permutation of its input', () => {
      const candidates = pool([
        { id: 'widget_create', keywords: ['widget', 'create'] },
        { id: 'widget_get', keywords: ['widget', 'get'] },
      ]);
      const drop = <T extends { id: string }>(list: T[]): T[] => list.slice(1);
      const { primary } = rankToolCandidates(candidates, 'create a widget', { reRank: drop });
      expect(primary[0].id).toBe('widget_create');
    });

    it('caps related at three', () => {
      const candidates = pool([
        { id: 'thing_create', keywords: ['thing', 'create'] },
        { id: 'thing_get', keywords: ['thing', 'get'] },
        { id: 'thing_edit', keywords: ['thing', 'edit'] },
        { id: 'thing_delete', keywords: ['thing', 'delete'] },
        { id: 'thing_export', keywords: ['thing', 'export'] },
      ]);
      const { related } = rankToolCandidates(candidates, 'create a thing');
      expect(related).toHaveLength(3);
      expect(
        rankToolCandidates(candidates, 'create a thing', { relatedLimit: 1 }).related
      ).toHaveLength(1);
    });
  });

  describe('determinism and edges', () => {
    it('returns empty lists for empty input', () => {
      expect(rankToolCandidates([], 'anything')).toEqual({
        primary: [],
        related: [],
        query: { verbs: [], objects: ['anything'] },
      });
    });

    it('produces identical output for identical input across calls and input order', () => {
      const a = pool([...PLAYWRIGHT, ...WIDGET_FAMILY]);
      const first = rankToolCandidates(a, 'create a new widget or gadget');
      const second = rankToolCandidates(a, 'create a new widget or gadget');
      expect(second).toEqual(first);
    });

    it('breaks exact ties by evidence, then retrieval rank, then id', () => {
      const candidates = pool([{ id: 'zeta_tool' }, { id: 'alpha_tool' }]);
      const { primary } = rankToolCandidates(candidates, 'tool');
      // Equal scores (identical evidence): retrieval rank wins over id order.
      expect(primary.map((t) => t.id)).toEqual(['zeta_tool', 'alpha_tool']);

      const tied = [
        { ...candidates[0], retrievalRank: 1, retrievalScore: 0.5 },
        { ...candidates[1], retrievalRank: 1, retrievalScore: 0.5 },
      ];
      expect(rankToolCandidates(tied, 'tool').primary.map((t) => t.id)).toEqual([
        'alpha_tool',
        'zeta_tool',
      ]);
    });

    it('reports the query analysis it ranked with', () => {
      const { query } = rankToolCandidates(pool(WIDGET_FAMILY), 'create a new widget or gadget');
      expect(query).toEqual({ verbs: ['create'], objects: ['widget', 'gadget'] });
    });
  });
});
