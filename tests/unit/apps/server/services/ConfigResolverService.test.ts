import { beforeEach, describe, expect, it } from '@jest/globals';

const mockPoolQuery = jest.fn();

jest.mock('@snaglet/db', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: jest.fn(() => ({ query: mockPoolQuery })),
}));

// resolveThreadRuntimeConfig touches Threads; not under test here but the
// module still imports it at the top level.
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: jest.fn() },
}));

import { resolveContentField } from '../../../../../apps/server/src/services/ConfigResolverService';

const pgRows = <T>(rows: T[]) => ({ rows });

/**
 * Build the row shape returned by the recursive CTE in loadDocsWithPaths.
 * The CTE produces one row per doc with title/content/segments aggregated.
 */
const docRow = (
  id: string,
  title: string,
  content: string,
  segments: string[]
): { doc_id: string; title: string; content: string; segments: string[] } => ({
  doc_id: id,
  title,
  content,
  segments,
});

describe('ConfigResolverService.resolveContentField', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('passthrough cases', () => {
    it('returns null for null/undefined', async () => {
      expect(await resolveContentField(null)).toBeNull();
      expect(await resolveContentField(undefined)).toBeNull();
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('returns the empty string unchanged without hitting the DB', async () => {
      expect(await resolveContentField('')).toBe('');
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('returns plain text unchanged when no include syntax is present', async () => {
      const text = 'You are a helpful agent. Be concise.';
      expect(await resolveContentField(text)).toBe(text);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('does not expand plain `[Title](doc-X)` links (only the `!` image-style form expands)', async () => {
      const text = 'See [the plan](doc-plan) for details.';
      expect(await resolveContentField(text)).toBe(text);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('returns null for ContentField ref objects (unsupported path)', async () => {
      const result = await resolveContentField({ pageId: 'doc-1' } as Parameters<
        typeof resolveContentField
      >[0]);
      expect(result).toBeNull();
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe('single-level expansion', () => {
    it('wraps `![](doc-X)` in a <doc id path> tag with the doc content inlined', async () => {
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([docRow('doc-plan', 'Plan', 'plan body', ['Projects', 'Plan'])])
      );

      const result = await resolveContentField('You are an agent.\n![](doc-plan)\nBe helpful.');

      expect(result).toBe(
        'You are an agent.\n<doc id="doc-plan" path="/Projects/Plan">\nplan body\n</doc>\nBe helpful.'
      );
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });

    it('wraps the bare `!doc-X` form the same way as `![](doc-X)`', async () => {
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([docRow('doc-plan', 'Plan', 'plan body', ['Projects', 'Plan'])])
      );

      const result = await resolveContentField('Use !doc-plan to ground the response.');

      expect(result).toBe(
        'Use <doc id="doc-plan" path="/Projects/Plan">\nplan body\n</doc> to ground the response.'
      );
    });

    it('ignores the optional title in `![title](doc-X)` syntax', async () => {
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([docRow('doc-plan', 'Plan', 'plan body', ['Plan'])])
      );

      const result = await resolveContentField('![stale title](doc-plan)');

      expect(result).toBe('<doc id="doc-plan" path="/Plan">\nplan body\n</doc>');
    });

    it('shows only the part a `#h=` or `#L` transclusion names, and marks a missing part', async () => {
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([
          docRow('doc-guide', 'Guide', '# Guide\n\n## Setup\ninstall\n\n## Other\nx', ['Guide']),
        ])
      );

      const result = await resolveContentField(
        '![](doc-guide#h=setup) / ![](doc-guide#L6) / ![](doc-guide#h=gone)'
      );

      expect(mockPoolQuery.mock.calls[0]![1]).toEqual([['doc-guide']]);
      expect(result).toBe(
        '<doc id="doc-guide" path="/Guide" part="h=setup">\n## Setup\ninstall\n</doc> / ' +
          '<doc id="doc-guide" path="/Guide" part="L6">\n## Other\n</doc> / ' +
          '<doc id="doc-guide" path="/Guide" part="h=gone" missing="part"/>'
      );
    });

    it('marks a missing doc with a tag, not a comment', async () => {
      mockPoolQuery.mockResolvedValueOnce(pgRows([])); // no matching rows

      const result = await resolveContentField('before ![](doc-ghost) after');

      expect(result).toBe('before <doc id="doc-ghost" missing="true"/> after');
    });
  });

  describe('recursive expansion', () => {
    it('nests <doc> wrappers as it recurses through references', async () => {
      // root references doc-a; doc-a references doc-c (no further refs).
      // depth 0 fetches doc-a; depth 1 fetches doc-c.
      mockPoolQuery
        .mockResolvedValueOnce(pgRows([docRow('doc-a', 'A', 'A start ![](doc-c) A end', ['A'])]))
        .mockResolvedValueOnce(pgRows([docRow('doc-c', 'C', 'C body', ['Sub', 'C'])]));

      const result = await resolveContentField('top ![](doc-a) tail');

      expect(result).toBe(
        'top <doc id="doc-a" path="/A">\n' +
          'A start <doc id="doc-c" path="/Sub/C">\nC body\n</doc> A end\n' +
          '</doc> tail'
      );
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    });

    it('renders a cycle marker instead of recursing into a doc already on the path (B -> A -> B)', async () => {
      // Traversal path:
      //   root prompt -> doc-b -> doc-root -> doc-b (cycle hit)
      // Only two queries: doc-b at depth 0 and doc-root at depth 1.
      // At depth 2 the inner doc-b is served from the shared cache, the
      // visited set catches it, and we emit the marker shell.
      mockPoolQuery
        .mockResolvedValueOnce(pgRows([docRow('doc-b', 'B', 'back to ![](doc-root)', ['B'])]))
        .mockResolvedValueOnce(pgRows([docRow('doc-root', 'Root', 'see ![](doc-b)', ['Root'])]));

      const result = await resolveContentField('top ![](doc-b) tail');

      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
      expect(result).toBe(
        'top <doc id="doc-b" path="/B">\n' +
          'back to <doc id="doc-root" path="/Root">\n' +
          'see <doc id="doc-b" path="/B" skipped="loop"/>\n' +
          '</doc>\n' +
          '</doc> tail'
      );
    });

    it('stops recursing at MAX_TRANSCLUSION_DEPTH=3 and leaves leaf content raw', async () => {
      // Chain: root -> a -> b -> c -> d (4 hops). The cap is 3 levels of
      // expansion, so doc-c is wrapped but its `![](doc-d)` syntax is
      // returned intact (not expanded into a 4th wrapper).
      mockPoolQuery
        .mockResolvedValueOnce(pgRows([docRow('doc-a', 'A', 'a ![](doc-b)', ['A'])]))
        .mockResolvedValueOnce(pgRows([docRow('doc-b', 'B', 'b ![](doc-c)', ['B'])]))
        .mockResolvedValueOnce(pgRows([docRow('doc-c', 'C', 'c ![](doc-d)', ['C'])]));

      const result = await resolveContentField('root ![](doc-a)');

      // Only 3 fetches — doc-d is never queried.
      expect(mockPoolQuery).toHaveBeenCalledTimes(3);
      // doc-c is wrapped but its inner ref is raw, not expanded.
      expect(result).toContain('<doc id="doc-c" path="/C">\nc ![](doc-d)\n</doc>');
      expect(result).not.toContain('<doc id="doc-d"');
    });

    it('batches multiple refs at the same level into a single fetch', async () => {
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([docRow('doc-a', 'A', 'a body', ['A']), docRow('doc-b', 'B', 'b body', ['B'])])
      );

      const result = await resolveContentField('![](doc-a) and ![](doc-b)');

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      expect(result).toBe(
        '<doc id="doc-a" path="/A">\na body\n</doc> and <doc id="doc-b" path="/B">\nb body\n</doc>'
      );
      // Verify the batched parameter included both ids.
      const args = (mockPoolQuery.mock.calls[0] as [string, unknown[]])[1];
      expect((args[0] as string[]).sort()).toEqual(['doc-a', 'doc-b']);
    });
  });
});
