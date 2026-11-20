/**
 * contentRefs — node-id extraction from markdown content into `links`
 * "references" edges.
 *
 * Docs converted from tasks keep their `task-…` node ids, so both the
 * prefixed-id link form `[Title](task-…)` and the `[Title](task:<uuid>)`
 * scheme still extract as reference edges — the same alias precedent the
 * file applies to `page` → `doc`.
 */

const mockReplaceOutgoing = jest.fn();
jest.mock('@snaglet/db/tables/links', () => ({
  Links: {
    replaceOutgoing: (...args: unknown[]) => mockReplaceOutgoing(...args),
  },
}));

import { syncContentRefLinks } from '@server/services/contentRefs';

beforeEach(() => {
  jest.clearAllMocks();
  mockReplaceOutgoing.mockResolvedValue(undefined);
});

describe('syncContentRefLinks — task- prefixed ids', () => {
  it('extracts a `[Title](task-…)` prefixed-id reference as an outgoing edge', () => {
    syncContentRefLinks('doc-1', '[My Task](task-1111111111111-hoznartwp)');
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [
      'task-1111111111111-hoznartwp',
    ]);
  });

  it('extracts a bare `task-…` mention (no brackets) as an outgoing edge', () => {
    syncContentRefLinks('doc-1', 'see task-1111111111111-hoznartwp for details');
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [
      'task-1111111111111-hoznartwp',
    ]);
  });

  it('extracts a legacy `[Title](task:<uuid>)` scheme reference as an outgoing edge', () => {
    syncContentRefLinks('doc-1', '[Legacy Task](task:9494d9d0-ae25-4509-a8f6-fb86ae2ba238)');
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [
      '9494d9d0-ae25-4509-a8f6-fb86ae2ba238',
    ]);
  });

  it('dedupes a task- id that appears both bracketed and bare in the same content', () => {
    syncContentRefLinks(
      'doc-1',
      '[My Task](task-1111111111111-hoznartwp) — also see task-1111111111111-hoznartwp'
    );
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [
      'task-1111111111111-hoznartwp',
    ]);
  });
});

describe('syncContentRefLinks — sketch- prefixed ids', () => {
  const SKETCH_ID = 'sketch-1111111111111-aaaaaaaaa';

  it('extracts a `[Title](sketch-…)` chip as an outgoing reference edge', () => {
    syncContentRefLinks('doc-1', `[Login wireframe](${SKETCH_ID})`);
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [SKETCH_ID]);
  });

  it('extracts a bare `sketch-…` mention as an outgoing reference edge', () => {
    syncContentRefLinks('doc-1', `see ${SKETCH_ID} for the layout`);
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [SKETCH_ID]);
  });
});

describe('syncContentRefLinks — post- prefixed ids', () => {
  const POST_ID = 'post-1111111111111-aaaaaaaaa';

  it('extracts a `[Title](post-…)` chip as an outgoing reference edge', () => {
    syncContentRefLinks('doc-1', `[Release plan](${POST_ID})`);
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [POST_ID]);
  });

  it('extracts a bare `post-…` mention as an outgoing reference edge', () => {
    syncContentRefLinks('doc-1', `see ${POST_ID} on the board`);
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [POST_ID]);
  });

  it('records edges authored FROM a post body (posts are link sources too)', () => {
    syncContentRefLinks(POST_ID, `context in [The plan](doc-1111111111111-bbbbbbbbb)`);
    expect(mockReplaceOutgoing).toHaveBeenCalledWith(POST_ID, 'references', [
      'doc-1111111111111-bbbbbbbbb',
    ]);
  });
});

describe('syncContentRefLinks — table: chips', () => {
  // Database tables are catalog rows, not nodes: a `table:` chip is never a
  // `links` edge target, whatever the catalog id looks like.
  it('harvests nothing from builtin or custom table chips', () => {
    syncContentRefLinks(
      'doc-1',
      'See [Docs](table:table-builtin-docs) and [Test Table](table:table-1111111111111-abcdefghi).'
    );
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', []);
  });

  it('keeps node refs beside a table chip', () => {
    syncContentRefLinks(
      'doc-1',
      '[Tools](table:table-builtin-tools) with [The plan](doc-1111111111111-bbbbbbbbb)'
    );
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [
      'doc-1111111111111-bbbbbbbbb',
    ]);
  });
});

describe('syncContentRefLinks — doc line links', () => {
  it('backlinks `[x](doc-…#L4-L9)` to the bare doc id', () => {
    syncContentRefLinks(
      'doc-1',
      '[part](doc-1111111111111-ccccccccc#L4-L9) and [all](doc-1111111111111-ccccccccc)'
    );
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [
      'doc-1111111111111-ccccccccc',
    ]);
  });
});

describe('syncContentRefLinks — hand-written line ranges', () => {
  it('backlinks `[x](doc-…#L3–5)` and `#L3-5` to the bare doc id', () => {
    syncContentRefLinks(
      'doc-1',
      '[Worksheet › L3–5](doc-1111111111111-ccccccccc#L3–5) and [b](doc-1111111111111-ddddddddd#L3-5)'
    );
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [
      'doc-1111111111111-ccccccccc',
      'doc-1111111111111-ddddddddd',
    ]);
  });
});

describe('syncContentRefLinks — doc heading links', () => {
  it('backlinks `[x](doc-…#h3=rate-limits)` to the bare doc id', () => {
    syncContentRefLinks('doc-1', '[sec](doc-1111111111111-ccccccccc#h3=rate-limits)');
    expect(mockReplaceOutgoing).toHaveBeenCalledWith('doc-1', 'references', [
      'doc-1111111111111-ccccccccc',
    ]);
  });

  it('records no edge for a link to a heading of the same doc, with or without its id', () => {
    const self = 'doc-1111111111111-aaaaaaaaa';
    syncContentRefLinks(
      self,
      `- [Q1](#h=q1-what)\n- [Next](#next-steps)\n- [Q2](${self}#h=q2-why)\n- [Q3](${self}#h2=q3)`
    );
    expect(mockReplaceOutgoing).toHaveBeenCalledWith(self, 'references', []);
  });
});
