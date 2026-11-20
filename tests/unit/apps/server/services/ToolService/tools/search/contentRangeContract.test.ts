/**
 * The `search` tool's `content_range` contract, exercised through the real tool
 * entry points an agent calls:
 *   - `tools/workspace/search/tool.ts`  — backend routing and the ranged-backend guard
 *   - `handlers/search/workspaceSearch/workspaceSearch.ts` — validation and the
 *     exact-id ranged read
 *
 * The point of these tests (vs. the unit tests on contentRange/rangedRead) is
 * that validation happens before any search work: a bad range is a fast, clear
 * error, and a call without `content_range` is untouched by any of this.
 */

type MockQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
const mockPoolQuery = jest.fn<MockQuery>();
jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (sql: string, params?: unknown[]) => mockPoolQuery(sql, params) }),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mockPoolQuery(sql, params) }),
}));

import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  MAX_RANGED_RESULTS,
  MAX_RANGE_LINES,
} from '@server/services/ToolService/handlers/search/workspaceSearch/contentRange';
import searchTool from '@server/services/ToolService/tools/workspace/search/tool';
import workspaceSearch from '@server/services/ToolService/handlers/search/workspaceSearch/workspaceSearch';
import definition from '@server/services/ToolService/tools/workspace/search/definition';

const RANGE = { start_line: 2, end_line: 4 };

function wireDoc(id: string, title: string, content: string): void {
  mockPoolQuery.mockImplementation(async (sql, params) => {
    if (String(params?.[0] ?? '') !== id) return { rows: [] };
    if (sql.includes('FROM public.nodes WHERE id = $1')) {
      return { rows: [{ type: 'doc', archived: false }] };
    }
    if (sql.includes('FROM public.docs')) {
      return { rows: [{ id, title, content, updated_at: new Date().toISOString() }] };
    }
    return { rows: [] };
  });
}

describe('search tool — content_range routing guard', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  it.each(['docs', 'containers', 'code', 'files', 'database', 'conversations'])(
    'rejects content_range on the %s backend instead of ignoring it',
    async (kind) => {
      const out = await searchTool({ kind, query: 'anything', content_range: RANGE }, {});
      expect(out).toContain('content_range is supported only on the workspace backend');
      expect(out).toContain(`not kind: "${kind}"`);
      // Rejected before the backend ran.
      expect(mockPoolQuery).not.toHaveBeenCalled();
    }
  );

  it('rejects content_range on the archived_only and recent listing routes', async () => {
    for (const input of [{ archived_only: true }, { sort: 'recent' }]) {
      const out = await searchTool({ ...input, content_range: RANGE }, {});
      expect(out).toContain('content_range is not supported with archived_only or sort:"recent"');
    }
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it.each([undefined, 'all', 'workspace'])('allows the %s backend through', async (kind) => {
    wireDoc('doc-1', 'Plan', 'a\nb\nc\nd\ne');
    const out = await searchTool({ kind, id: 'doc-1', content_range: RANGE }, {});
    expect(out).toContain('Ranged read (lines 2-4, 1-indexed inclusive)');
    expect(out).toContain('b\nc\nd');
  });

  it('routes focused backends normally when no content_range is passed', async () => {
    // No content_range → the guard is inert and the call reaches the backend,
    // which then answers (or fails) on its own rules. Either way the response
    // must never mention content_range.
    const out = await searchTool({ kind: 'database', query: 'x' }, {}).catch((err) => String(err));
    expect(String(out)).not.toContain('content_range');
  });
});

describe('workspaceSearch — content_range validation runs before any search work', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  it.each([
    ['a non-object range', 'lines 2-4', 'must be an object'],
    ['a range missing a bound', { start_line: 2 }, 'requires both start_line and end_line'],
    ['a non-integer bound', { start_line: 1, end_line: 2.5 }, 'must be integers'],
    ['a zero bound', { start_line: 0, end_line: 4 }, 'must be >= 1'],
    ['an inverted range', { start_line: 9, end_line: 2 }, 'must be <= end_line'],
    [
      'an over-long span',
      { start_line: 1, end_line: MAX_RANGE_LINES + 50 },
      `maximum is ${MAX_RANGE_LINES}`,
    ],
  ])('rejects %s without querying', async (_label, content_range, expected) => {
    const out = await workspaceSearch({ id: 'doc-1', content_range }, {});
    expect(out).toContain(expected);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('rejects an explicit query limit that would multiply the range', async () => {
    const out = await workspaceSearch(
      { query: 'retry backoff', content_range: RANGE, limit: 20 },
      {}
    );
    expect(out).toContain(`at most ${MAX_RANGED_RESULTS} results`);
    expect(out).toContain('limit is 20');
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('accepts an explicit limit exactly at the ranged cap', async () => {
    wireDoc('doc-1', 'Plan', 'a\nb\nc\nd\ne');
    const out = await workspaceSearch(
      { query: 'doc-1', content_range: RANGE, limit: MAX_RANGED_RESULTS },
      {}
    );
    expect(out).toContain('Ranged read');
  });

  it('lowers an unstated limit to the ranged cap instead of rejecting the call', async () => {
    wireDoc('doc-1', 'Plan', 'a\nb\nc\nd\ne');
    const out = await workspaceSearch({ query: 'doc-1', content_range: RANGE }, {});
    expect(out).not.toContain('at most');
    expect(out).toContain('Ranged read');
  });

  it('rejects content_range against explicit kinds that can never carry content', async () => {
    const out = await workspaceSearch(
      { query: 'standup', kinds: ['thread', 'container'], content_range: RANGE, limit: 3 },
      {}
    );
    expect(out).toContain('content_range is not supported for kinds');
    expect(out).toContain('doc, message, memory, file');
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('allows a mixed explicit kinds list (rangeable kinds are read, the rest reported)', async () => {
    // Validation passes here; the per-item reporting is covered in rangedRead.test.ts.
    wireDoc('doc-1', 'Plan', 'a\nb\nc\nd\ne');
    const out = await workspaceSearch(
      { id: 'doc-1', kinds: ['doc', 'thread'], content_range: RANGE },
      {}
    );
    expect(out).not.toContain('is not supported for kinds');
    expect(out).toContain('b\nc\nd');
  });
});

describe('workspaceSearch — exact-id ranged read', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  it('serves `id` + content_range as a bounded read of current content', async () => {
    wireDoc('doc-1', 'Retry policy', 'one\ntwo\nthree\nfour\nfive\nsix');
    const out = await workspaceSearch({ id: 'doc-1', content_range: RANGE }, {});
    expect(out).toContain('doc "Retry policy" (doc-1) — lines 2-4 of 6 · truncated: true');
    expect(out).toContain('two\nthree\nfour');
    expect(out).not.toContain('five');
  });

  it('serves a literal id passed as `query` the same way (backward-compatible spelling)', async () => {
    wireDoc('doc-1', 'Retry policy', 'one\ntwo\nthree\nfour\nfive\nsix');
    const viaId = await workspaceSearch({ id: 'doc-1', content_range: RANGE }, {});
    const viaQuery = await workspaceSearch({ query: 'doc-1', content_range: RANGE }, {});
    expect(viaQuery).toBe(viaId);
  });

  it('ignores `detail` for a ranged read — the range IS the detail level', async () => {
    wireDoc('doc-1', 'Retry policy', 'one\ntwo\nthree\nfour\nfive\nsix');
    const compact = await workspaceSearch(
      { id: 'doc-1', content_range: RANGE, detail: 'compact' },
      {}
    );
    const full = await workspaceSearch({ id: 'doc-1', content_range: RANGE, detail: 'full' }, {});
    expect(compact).toBe(full);
    expect(full).toContain('two\nthree\nfour');
  });
});

describe('workspaceSearch — calls without content_range are unchanged', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  it('returns the pre-existing id-resolution output byte-for-byte', async () => {
    wireDoc('doc-1', 'Retry policy', 'one\ntwo\nthree');
    const out = await workspaceSearch({ id: 'doc-1', detail: 'full' }, {});
    expect(out).toContain('Resolved id "doc-1" → doc');
    expect(out).toContain('Content:');
    expect(out).not.toContain('Ranged read');
  });

  it('keeps the missing-input message unchanged', async () => {
    expect(await workspaceSearch({}, {})).toBe('Search query or id is required.');
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('search tool schema documents the discovery-then-read workflow', () => {
  it('advertises content_range with both bounds required', () => {
    const schema = definition.parameters_schema as {
      properties: Record<string, Record<string, unknown>>;
    };
    const range = schema.properties.content_range;
    expect(range).toBeDefined();
    expect(range.type).toBe('object');
    expect(range.required).toEqual(['start_line', 'end_line']);
    const description = String(range.description);
    expect(description).toContain('1-indexed');
    expect(description).toContain('INCLUSIVE');
    expect(description).toContain(`${MAX_RANGE_LINES} lines`);
    expect(description).toContain(`top ${MAX_RANGED_RESULTS} results`);
  });

  it('tells agents to query first, then do an exact-id ranged read', () => {
    expect(definition.description).toContain('content_range');
    expect(definition.description).toContain('`query` to find the item');
    expect(definition.description).toContain('`id` + `content_range`');
  });
});

describe('search — doc line link as the id', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  it('reads just the linked lines when the id is `doc-…#L2-L4`', async () => {
    wireDoc('doc-1', 'Plan', 'a\nb\nc\nd\ne');
    const out = await searchTool({ id: 'doc-1#L2-L4' }, {});
    expect(out).toContain('Ranged read (lines 2-4, 1-indexed inclusive)');
    expect(out).toContain('b\nc\nd');
  });

  it('an explicit content_range wins over the fragment', async () => {
    wireDoc('doc-1', 'Plan', 'a\nb\nc\nd\ne');
    const out = await searchTool(
      { id: 'doc-1#L4', content_range: { start_line: 1, end_line: 2 } },
      {}
    );
    expect(out).toContain('Ranged read (lines 1-2, 1-indexed inclusive)');
  });

  it('refuses a line link longer than the ranged cap', async () => {
    const out = await searchTool({ id: `doc-1#L1-L${MAX_RANGE_LINES + 1}` }, {});
    expect(out).toContain('Narrow it');
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('search — doc heading link as the id', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  it('reads just the section for `doc-…#h=limits`', async () => {
    wireDoc(
      'doc-1',
      'Plan',
      '# Plan\nintro\n## Limits\n10 rpm\n### Retry\nback off\n## Costs\ncheap'
    );
    const out = await searchTool({ id: 'doc-1#h=limits' }, {});
    expect(out).toContain('Section "h=limits" = lines 3-6.');
    expect(out).toContain('10 rpm');
    expect(out).toContain('back off');
    expect(out).not.toContain('cheap');
  });

  it('reads a heading range `doc-…#h=limits..h=costs`', async () => {
    wireDoc('doc-1', 'Plan', '# Plan\nintro\n## Limits\n10 rpm\n## Costs\ncheap\n## Later\nnope');
    const out = await searchTool({ id: 'doc-1#h=limits..h=costs' }, {});
    expect(out).toContain('Section "h=limits..h=costs" = lines 3-6.');
    expect(out).toContain('cheap');
    expect(out).not.toContain('nope');
  });

  it('says so when the heading is gone', async () => {
    wireDoc('doc-1', 'Plan', '# Plan\nintro');
    const out = await searchTool({ id: 'doc-1#h=limits' }, {});
    expect(out).toContain('No heading "h=limits"');
  });
});
