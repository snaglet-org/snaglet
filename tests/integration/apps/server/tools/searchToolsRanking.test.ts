/**
 * search_tools keyword-relevance evaluation, against the real tool catalog.
 * The embedder is unavailable here, so `hybrid` degrades to keyword: these
 * results are what an agent gets without semantic search. Fusion is covered in
 * tests/unit/.../search-tools/fusion.test.ts.
 *
 * Not asserted here: "show me what's in package.json" and "load a file from
 * the filesystem" share no token with `file_read`'s name, keywords or aliases,
 * so lexical ranking cannot find them; the fusion suite covers them.
 *
 * Nothing here may be satisfied by boosting a tool id or matching a sentence:
 * every assertion is about order emerging from generic scoring.
 */

import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import searchTools from '@server/services/ToolService/handlers/tools/tool-search';
import { toolView } from '@snaglet/db';

type SearchToolsResult = {
  tools: Array<{ id: string }>;
  related?: Array<{ id: string }>;
  count: number;
};

async function searchResult(
  query: string,
  mode: 'hybrid' | 'keyword' = 'hybrid'
): Promise<SearchToolsResult> {
  const raw = (await searchTools({ query, mode })) as string;
  return JSON.parse(raw) as SearchToolsResult;
}

async function topIds(query: string, mode: 'hybrid' | 'keyword' = 'hybrid'): Promise<string[]> {
  return (await searchResult(query, mode)).tools.map((tool) => tool.id);
}

describe('search_tools keyword relevance', () => {
  beforeAll(async () => {
    await toolRegistry.load();
    await toolRegistry.syncToDatabase();
  }, 180_000);

  describe('read/open/show file intents reach file', () => {
    it.each([
      'read a local file',
      'read this file',
      'cat this file',
      'view file contents',
      'read the contents of a file on disk',
      'read a slice of a file',
      'read part of a file by line range',
      'open a file and read it',
      'show me lines 20 through 40 of a file',
      'open src/index.ts and show me lines 10 to 40',
    ])(
      '%s',
      async (query) => {
        expect(await topIds(query)).toContain('file');
      },
      30_000
    );
  });

  describe('sibling file tools still win their own intents', () => {
    // Guards against over-tuning (one tool winning everywhere): each sibling
    // must still be reachable.
    it.each([
      ['list files in a directory', 'file'],
      ['write a file to disk', 'file'],
      ['edit a file and replace some text', 'file'],
      ['file metadata size and modified time', 'file'],
    ])(
      '%s → %s',
      async (query, expected) => {
        expect(await topIds(query)).toContain(expected);
      },
      30_000
    );
  });

  describe('negative controls keep their own tools and exclude file_read', () => {
    it.each([
      ['send an email', 'google_gmail'],
      ['commit these changes with git', 'git'],
      ['schedule a calendar event', 'google_calendar'],
      ['create a project brief document', 'doc'],
    ])(
      '%s → %s, and file never outranks it',
      async (query, expected) => {
        const ids = await topIds(query);
        expect(ids).toContain(expected);
        // `file` may fill a trailing slot when few tools match at all ("commit
        // these changes with git" has only git as a real match and file lands
        // third at a negative score), but it must never rank above the tool
        // the query asked for.
        if (ids.includes('file')) {
          expect(ids.indexOf('file')).toBeGreaterThan(ids.indexOf(expected));
        }
      },
      30_000
    );

    it('a memory question reaches a memory tool, not file', async () => {
      const ids = await topIds('what do I remember about the launch?');
      expect(ids.some((id) => id === 'memory' || id.startsWith('memory_'))).toBe(true);
      expect(ids).not.toContain('file');
    }, 30_000);

    it('a workspace search question reaches search, not a file tool', async () => {
      const ids = await topIds('search my notes for the launch plan');
      expect(ids).toContain('search');
      expect(ids).not.toContain('file');
    }, 30_000);
  });

  describe('substring matches are scored, not listed alphabetically', () => {
    it('a bare substring query ranks by relevance, not by spelling', async () => {
      // `file` matches dozens of tools; listed `name ASC`, `file_read`
      // ('Read File') would fall outside the first ten.
      const { tools } = await toolView.searchByKeyword('file', 10);
      const ids = tools.map((tool) => tool.id);

      expect(ids).toContain('file');
      const names = tools.map((tool) => tool.name);
      expect(names).not.toEqual([...names].sort((a, b) => a.localeCompare(b)));
    }, 30_000);

    it('an exact tool name outranks alphabetically-earlier tools', async () => {
      const ids = (await toolView.searchByKeyword('read file', 5)).tools.map((tool) => tool.id);
      expect(ids[0]).toBe('file');
    }, 30_000);
  });

  describe('ranking is deterministic', () => {
    it('returns an identical order for an identical query', async () => {
      // Ties resolve on evidence quality and then, only as a last resort, on
      // name — so repeated calls cannot reshuffle.
      const [first, second] = await Promise.all([
        toolView.searchByKeyword('read a local file', 8),
        toolView.searchByKeyword('read a local file', 8),
      ]);

      expect(first.tools.map((t) => t.id)).toEqual(second.tools.map((t) => t.id));
    }, 30_000);
  });

  describe('node discovery', () => {
    // Every tree/node verb lands on the one node(op) tool. No MCP server is enabled in this
    // environment, so "no mcp__ id outranks node" reduces to the top-1
    // assertion; the MCP-present case is covered by the synthetic-catalog eval
    // in tests/unit/.../search-tools/ranking.eval.test.ts.
    it('"show the workspace tree of nodes" → node first', async () => {
      const ids = await topIds('show the workspace tree of nodes');
      expect(ids[0]).toBe('node');
    }, 30_000);

    it.each([
      'move a node to another container',
      'rename a workspace node',
      'archive a node in the tree',
      'get a node by its id',
    ])(
      '%s → node',
      async (query) => {
        expect(await topIds(query)).toContain('node');
      },
      30_000
    );
  });

  describe('domain preference cannot override relevance', () => {
    it('does not hoist a weakly-matched thread tool over the tools asked for', async () => {
      // `thread_delete` lists `project` among its keywords, so a query about
      // creating a project doc retrieves it weakly. A domain preference must
      // not lift a thread_*/workspace_* candidate above better matches.
      const ids = await topIds('create a project brief document');

      expect(ids).not.toContain('thread_delete');
      expect(ids[0]).not.toMatch(/^thread_/);
      // The tool asked for (doc, op create) must still be near the top.
      expect(ids.slice(0, 3)).toContain('doc');
    }, 30_000);
  });
});
