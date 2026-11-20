import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { ContainerRow } from '@snaglet/db/tables/containers';
import type { DocRow } from '@snaglet/db/tables/docs';
import type { ThreadRow } from '@snaglet/db/tables/threads';

// Mocks (hoisted before module imports)

const mockListAllOrderedContainers = jest.fn();
const mockListAllOrderedDocs = jest.fn();
const mockListAllOrderedThreads = jest.fn();

jest.mock('@snaglet/db/tables/containers', () => ({
  Containers: {
    listAllOrdered: (...args: unknown[]) => mockListAllOrderedContainers(...args),
  },
}));
jest.mock('@snaglet/db/tables/docs', () => ({
  Docs: {
    listAllOrdered: (...args: unknown[]) => mockListAllOrderedDocs(...args),
  },
}));
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    listAllOrdered: (...args: unknown[]) => mockListAllOrderedThreads(...args),
  },
}));
// No Projects mock: the tool reads project-ness from `container.category`, not
// from a projects table.

import tool from '@server/services/ToolService/handlers/workspace/workspaceTreeOp';
import { invokeTool, toolOutputText } from '../../../../../../support/toolHarness';

const NOW = '2025-01-01T00:00:00.000Z';

function container(
  id: string,
  name: string,
  parentId: string | null = null,
  category: 'project' | 'status' | null = null
) {
  return {
    id,
    name,
    parentId,
    category,
    sortOrder: 0,
    updatedAt: NOW,
    createdAt: NOW,
  };
}
function doc(id: string, title: string, containerId: string | null, content = 'hello world') {
  return { id, title, containerId, content, sortOrder: 0, updatedAt: NOW, createdAt: NOW };
}
/** Threads attach to a project (or are flat); `projectId` is their only placement. */
function thread(id: string, title: string | null, projectId: string | null) {
  return {
    id,
    title,
    projectId,
    lastMessageAt: NOW,
    updatedAt: NOW,
    createdAt: NOW,
  };
}

async function call(input: unknown = {}) {
  return toolOutputText(await invokeTool(tool, input));
}

beforeEach(() => {
  mockListAllOrderedContainers.mockReset();
  mockListAllOrderedDocs.mockReset();
  mockListAllOrderedThreads.mockReset();

  mockListAllOrderedContainers.mockResolvedValue([]);
  mockListAllOrderedDocs.mockResolvedValue([]);
  mockListAllOrderedThreads.mockResolvedValue([]);
});

describe('workspace_tree', () => {
  it.each(['doc', 'thread'])(
    'renders scoped %s leaves without their container rows',
    async (kind) => {
      // Root, Child and Other are projects so each can carry threads.
      mockListAllOrderedContainers.mockResolvedValue([
        container('container-root', 'Root', null, 'project'),
        container('container-child', 'Child', 'container-root', 'project'),
        container('container-other', 'Other', null, 'project'),
      ]);
      mockListAllOrderedDocs.mockResolvedValue([
        doc('doc-root', 'Root document', 'container-root'),
        doc('doc-child', 'Child document', 'container-child'),
        doc('doc-other', 'Outside document', 'container-other'),
        doc('doc-loose', 'Loose document', null),
      ]);
      mockListAllOrderedThreads.mockResolvedValue([
        thread('thread-root', 'Root conversation', 'container-root'),
        thread('thread-child', 'Child conversation', 'container-child'),
        thread('thread-other', 'Outside conversation', 'container-other'),
        thread('thread-loose', 'Loose conversation', null),
      ]);
      const out = await call({ container_id: 'container-root', kinds: [kind] });
      expect(out).toContain(`${kind}-root`);
      expect(out).toContain(`${kind}-child`);
      expect(out).not.toContain(`${kind}-other`);
      expect(out).not.toContain(`${kind}-loose`);
      expect(out).not.toContain('container-root');
      expect(out).not.toContain('(empty workspace)');
      expect(out).toContain(`2 ${kind}(s)`);
    }
  );

  it('renders unscoped doc-only results inside and outside containers', async () => {
    mockListAllOrderedContainers.mockResolvedValue([container('container-root', 'Root')]);
    mockListAllOrderedDocs.mockResolvedValue([
      doc('doc-root', 'Contained', 'container-root'),
      doc('doc-loose', 'Loose', null),
    ]);
    const out = await call({ kinds: ['doc'] });
    expect(out).toContain('Contained');
    expect(out).toContain('Loose');
    expect(out).toContain('2 doc(s)');
    expect(out).not.toContain('container-root');
  });

  it('reports an empty scoped result when all requested leaves are outside the scope', async () => {
    mockListAllOrderedContainers.mockResolvedValue([container('container-root', 'Root')]);
    mockListAllOrderedDocs.mockResolvedValue([doc('doc-loose', 'Loose', null)]);
    const out = await call({ container_id: 'container-root', kinds: ['doc'] });
    expect(out).toContain('(empty workspace)');
    expect(out).toContain('0 doc(s)');
  });
  it('returns "(empty workspace)" when there is nothing', async () => {
    const out = await call({});
    expect(out).toContain('(empty workspace)');
    expect(out).toMatch(/0 container/);
  });

  it('renders a single root container', async () => {
    mockListAllOrderedContainers.mockResolvedValue([container('container-a', 'Alpha')]);
    const out = await call({});
    expect(out).toContain('Alpha');
    expect(out).toContain('container-a');
    expect(out).toMatch(/1 container/);
  });

  it('nests child containers under their parent', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      container('container-root', 'Root'),
      container('container-child', 'Child', 'container-root'),
    ]);
    const out = await call({});
    expect(out).toContain('Root');
    expect(out).toContain('Child');
    // Child appears under root: the Child line should be after Root
    const rootIdx = out.indexOf('Root');
    const childIdx = out.indexOf('Child');
    expect(rootIdx).toBeLessThan(childIdx);
    expect(out).toMatch(/2 container/);
  });

  it('attaches docs to their container', async () => {
    mockListAllOrderedContainers.mockResolvedValue([container('container-a', 'Alpha')]);
    mockListAllOrderedDocs.mockResolvedValue([doc('doc-1', 'Readme', 'container-a')]);
    const out = await call({});
    expect(out).toContain('Alpha');
    expect(out).toContain('Readme');
    expect(out).toMatch(/1 doc/);
  });

  it('renders loose docs at top level when no scope', async () => {
    mockListAllOrderedDocs.mockResolvedValue([doc('doc-loose', 'Floating', null)]);
    const out = await call({});
    expect(out).toContain('Floating');
  });

  it('respects kinds filter — excludes docs when not requested', async () => {
    mockListAllOrderedContainers.mockResolvedValue([container('container-a', 'Alpha')]);
    const out = await call({ kinds: 'container' });
    expect(out).toContain('Alpha');
    // Docs.listAllOrdered should not have been called since 'doc' is excluded
    expect(mockListAllOrderedDocs).not.toHaveBeenCalled();
    expect(mockListAllOrderedThreads).not.toHaveBeenCalled();
  });

  it('includes threads when requested, in a Threads block under their project', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      container('container-a', 'Alpha', null, 'project'),
    ]);
    mockListAllOrderedThreads.mockResolvedValue([thread('thread-1', 'Planning', 'container-a')]);
    const out = await call({ kinds: 'container,thread' });
    expect(out).toContain('Planning');
    expect(out).toMatch(/^ {4}└── 💬 Threads\n {8}└── 💬 \[Planning\]\(thread-1\)/m);
    expect(out).toMatch(/1 thread/);
  });

  it('uses "Untitled thread" when title is null', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      container('container-a', 'Alpha', null, 'project'),
    ]);
    mockListAllOrderedThreads.mockResolvedValue([thread('thread-1', null, 'container-a')]);
    const out = await call({ kinds: 'container,thread' });
    expect(out).toContain('Untitled thread');
  });

  it('renders flat threads in a top-level Threads block and none under a plain folder', async () => {
    mockListAllOrderedContainers.mockResolvedValue([container('container-a', 'Alpha')]);
    mockListAllOrderedThreads.mockResolvedValue([thread('thread-flat', 'Stray', null)]);
    const unscoped = await call({ kinds: 'container,thread' });
    expect(unscoped).toMatch(/^└── 💬 Threads\n {4}└── 💬 \[Stray\]\(thread-flat\)/m);
    const scoped = await call({ container_id: 'container-a', kinds: 'container,thread' });
    expect(scoped).not.toContain('Threads');
    expect(scoped).toMatch(/0 thread/);
  });

  it('scoping to a container excludes siblings', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      container('container-a', 'Alpha'),
      container('container-b', 'Beta'),
      container('container-a-child', 'AChild', 'container-a'),
    ]);
    const out = await call({ container_id: 'container-a' });
    expect(out).toContain('Alpha');
    expect(out).toContain('AChild');
    expect(out).not.toContain('Beta');
  });

  it('returns scope error for an unknown path', async () => {
    mockListAllOrderedContainers.mockResolvedValue([container('container-a', 'Alpha')]);
    const out = await call({ path: '/Nope' });
    // resolveContainerScope returns an error message; the tool returns it as-is.
    expect(out).toMatch(/No container "Nope"/);
  });

  it('annotates a container with the 🗂️ project tag when its category is project', async () => {
    // A project is its container: the `category='project'` facet drives the tag.
    mockListAllOrderedContainers.mockResolvedValue([
      { ...container('container-a', 'Alpha'), category: 'project' },
    ]);
    const out = await call({ kinds: 'container' });
    expect(out).toContain('Alpha');
    expect(out).toContain('🗂️ project');
  });

  it('summary tally includes every requested kind', async () => {
    mockListAllOrderedContainers.mockResolvedValue([container('container-a', 'Alpha')]);
    mockListAllOrderedDocs.mockResolvedValue([doc('doc-1', 'D1', 'container-a')]);
    mockListAllOrderedThreads.mockResolvedValue([thread('thread-1', 'T1', 'container-a')]);
    const out = await call({ kinds: 'container,doc,thread' });
    expect(out).toMatch(/1 container/);
    expect(out).toMatch(/1 doc/);
    expect(out).toMatch(/1 thread/);
  });

  it('handles deeply nested containers', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      container('c1', 'L1'),
      container('c2', 'L2', 'c1'),
      container('c3', 'L3', 'c2'),
    ]);
    const out = await call({});
    expect(out).toContain('L1');
    expect(out).toContain('L2');
    expect(out).toContain('L3');
    expect(out.indexOf('L1')).toBeLessThan(out.indexOf('L2'));
    expect(out.indexOf('L2')).toBeLessThan(out.indexOf('L3'));
  });
});

// Freeze "now" so `formatRelativeTime` is deterministic in assertions.
const FIXED_NOW = Date.parse('2026-06-01T12:00:00Z');

// Builders
// Keep type bounds tight so a Row-shape change at the source surfaces in the
// test compilation before it surfaces as a runtime mock mismatch.

function makeContainer(overrides: Partial<ContainerRow> = {}): ContainerRow {
  return {
    id: 'container-1-aaa',
    parentId: null,
    name: 'Root',
    // Project-ness is a container facet: category='project' flags the
    // container as a project (there is no separate projects table).
    category: null,
    folderPath: null,
    githubUrl: null,
    fileIndexingEnabled: true,
    description: null,
    createdBy: null,
    lastEditedBy: null,
    sortOrder: 0,
    x: null,
    y: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archived: false,
    archivedAt: null,
    ...overrides,
  };
}

function makeDoc(overrides: Partial<DocRow> = {}): DocRow {
  return {
    id: 'doc-1-aaa',
    containerId: null,
    title: 'Untitled',
    content: '',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 'thread-1-aaa',
    title: 'Thread',
    projectId: null,
    sortOrder: 0,
    dispatchMode: 'all',
    maxAgentDispatches: null,
    maxWaves: null,
    maxTotalOutputTokens: null,
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    threadSystemPrompt: null,
    lastMessageAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archived: false,
    archivedAt: null,
    ...overrides,
  };
}

describe('workspace_tree tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListAllOrderedContainers.mockResolvedValue([]);
    mockListAllOrderedDocs.mockResolvedValue([]);
    mockListAllOrderedThreads.mockResolvedValue([]);
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Empty + footer

  it('reports an empty workspace with zero counts when nothing exists', async () => {
    const out = await tool({}, {});
    expect(out).toContain('(empty workspace)');
    expect(out).toContain('0 container(s)');
    expect(out).toContain('0 doc(s)');
    expect(out).toContain('0 thread(s)');
    // Projects are not a separate kind in the tree summary — the count line
    // lists containers/docs/threads only.
    expect(out).not.toContain('project(s)');
  });

  // Basic rendering

  it('renders a single root container with one doc inside', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-1', name: 'Root' }),
    ]);
    mockListAllOrderedDocs.mockResolvedValue([
      makeDoc({ id: 'doc-1', title: 'README', containerId: 'container-1' }),
    ]);

    const out = await tool({}, {});

    expect(out).toContain('[Root](container-1)');
    expect(out).toContain('[README](doc-1)');
    // README is the last and only child → uses the └── connector,
    // prefixed with the 📄 doc glyph.
    expect(out).toMatch(/└── 📄 \[README\]\(doc-1\)/);
    expect(out).toContain('1 container(s)');
    expect(out).toContain('1 doc(s)');
  });

  it('renders nested containers with correct tree art', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-1', name: 'Root' }),
      makeContainer({ id: 'container-2', name: 'Child', parentId: 'container-1' }),
      makeContainer({ id: 'container-3', name: 'Grandchild', parentId: 'container-2' }),
    ]);
    mockListAllOrderedDocs.mockResolvedValue([
      makeDoc({ id: 'doc-1', title: 'Deep', containerId: 'container-3' }),
    ]);

    const out = await tool({}, {});

    expect(out).toContain('📂 [Root](container-1)');
    expect(out).toContain('📂 [Child](container-2)');
    expect(out).toContain('📂 [Grandchild](container-3)');
    expect(out).toContain('[Deep](doc-1)');
  });

  it('places loose (container-less) docs at the top level when unfiltered', async () => {
    mockListAllOrderedDocs.mockResolvedValue([
      makeDoc({ id: 'doc-loose', title: 'Floating', containerId: null }),
    ]);

    const out = await tool({}, {});

    // A loose doc with no surrounding containers becomes the only top-level
    // child, so it gets the └── (last) connector — prefixed with 📄.
    expect(out).toMatch(/└── 📄 \[Floating\]\(doc-loose\)/);
  });

  // linkForm picks right shape

  it('emits prefixed-id link form for nodes whose id already carries a node-type prefix', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-1779-abc', name: 'New' }),
    ]);
    const out = await tool({}, {});
    expect(out).toContain('[New](container-1779-abc)');
  });

  it('emits legacy <scheme>:<uuid> link form for bare-UUID nodes', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: '11111111-2222-3333-4444-555555555555', name: 'Legacy' }),
    ]);
    mockListAllOrderedDocs.mockResolvedValue([
      makeDoc({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        title: 'LegacyDoc',
        containerId: '11111111-2222-3333-4444-555555555555',
      }),
    ]);

    const out = await tool({}, {});

    expect(out).toContain('[Legacy](container:11111111-2222-3333-4444-555555555555)');
    expect(out).toContain('[LegacyDoc](doc:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)');
  });

  // Path filter

  it('resolves a `/Snaglet/docs` path to the matching container subtree', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-snaglet', name: 'Snaglet', parentId: null }),
      makeContainer({ id: 'container-docs', name: 'docs', parentId: 'container-snaglet' }),
      makeContainer({ id: 'container-other', name: 'Other', parentId: null }),
    ]);
    mockListAllOrderedDocs.mockResolvedValue([
      makeDoc({ id: 'doc-in', title: 'InDocs', containerId: 'container-docs' }),
    ]);

    const out = await tool({ path: '/Snaglet/docs' }, {});

    expect(out).toContain('[docs](container-docs)');
    expect(out).toContain('[InDocs](doc-in)');
    expect(out).not.toContain('Other');
  });

  it('matches path segments case-insensitively', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-snaglet', name: 'Snaglet', parentId: null }),
      makeContainer({ id: 'container-docs', name: 'Docs', parentId: 'container-snaglet' }),
    ]);
    const out = await tool({ path: '/snaglet/DOCS' }, {});
    expect(out).toContain('[Docs](container-docs)');
  });

  it('returns an explanatory error when a path segment does not exist', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-snaglet', name: 'Snaglet', parentId: null }),
    ]);
    const out = await tool({ path: '/Snaglet/missing' }, {});
    expect(out).toContain('No container "missing"');
    expect(out).toContain('/Snaglet');
  });

  // Name filter

  it('uses the unique container when a name matches exactly one', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-only', name: 'Specs', parentId: null }),
      makeContainer({ id: 'container-other', name: 'Other', parentId: null }),
    ]);
    const out = await tool({ name: 'Specs' }, {});
    expect(out).toContain('[Specs](container-only)');
    expect(out).not.toContain('Other');
  });

  it('returns an error message when no container matches the name', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-1', name: 'Snaglet' }),
    ]);
    const out = await tool({ name: 'nonexistent' }, {});
    expect(out).toBe('No container named "nonexistent".');
  });

  it('lists the paths of all matches when the name is ambiguous', async () => {
    // Two containers both named "docs" under different parents — the agent
    // needs the paths spelled out to disambiguate on the next call.
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-snaglet', name: 'Snaglet', parentId: null }),
      makeContainer({ id: 'container-snaglet-docs', name: 'docs', parentId: 'container-snaglet' }),
      makeContainer({ id: 'container-coding', name: 'Coding', parentId: null }),
      makeContainer({ id: 'container-coding-docs', name: 'docs', parentId: 'container-coding' }),
    ]);

    const out = await tool({ name: 'docs' }, {});

    expect(out).toContain('Multiple containers named "docs"');
    expect(out).toContain('/Snaglet/docs');
    expect(out).toContain('/Coding/docs');
    expect(out).toContain('`path`');
  });

  it('matches name case-insensitively', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-only', name: 'Specs', parentId: null }),
    ]);
    const out = await tool({ name: 'SPECS' }, {});
    expect(out).toContain('[Specs](container-only)');
  });

  // Container filter

  it('roots the tree at the specified container when container_id is set', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-out', name: 'Outside', parentId: null }),
      makeContainer({ id: 'container-root', name: 'PickMe', parentId: null }),
      makeContainer({ id: 'container-leaf', name: 'Leaf', parentId: 'container-root' }),
    ]);
    mockListAllOrderedDocs.mockResolvedValue([
      makeDoc({ id: 'doc-leaf', title: 'LeafDoc', containerId: 'container-leaf' }),
      makeDoc({ id: 'doc-elsewhere', title: 'Elsewhere', containerId: 'container-out' }),
    ]);

    const out = await tool({ container_id: 'container-root' }, {});

    expect(out).toContain('[PickMe](container-root)');
    expect(out).toContain('[Leaf](container-leaf)');
    expect(out).toContain('[LeafDoc](doc-leaf)');
    expect(out).not.toContain('Outside');
    expect(out).not.toContain('Elsewhere');
  });

  it('omits loose docs when a subtree filter is active', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-root', name: 'Root' }),
    ]);
    mockListAllOrderedDocs.mockResolvedValue([
      makeDoc({ id: 'doc-loose', title: 'Floating', containerId: null }),
    ]);

    const out = await tool({ container_id: 'container-root' }, {});
    expect(out).not.toContain('Floating');
  });

  // Whitespace / trim handling

  it('trims whitespace-only filter inputs and treats them as absent', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-1', name: 'Root' }),
    ]);

    const out = await tool({ container_id: '   ', path: '', name: '  ' }, {});

    expect(out).toContain('[Root](container-1)');
    expect(out).not.toContain('No container');
  });

  // Timestamps

  it('appends a relative timestamp suffix to every container and doc line', async () => {
    // Now = 2026-06-01T12:00:00Z. updated_at values land in known buckets:
    //   - 30 minutes ago → "30m ago"
    //   - 3 hours ago    → "3h ago"
    //   - 2 days ago     → "2d ago"
    //   - 30 days ago    → "May 2" (older-than-a-week branch)
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({
        id: 'container-1',
        name: 'Recent',
        updatedAt: new Date(FIXED_NOW - 30 * 60_000).toISOString(),
      }),
    ]);
    mockListAllOrderedDocs.mockResolvedValue([
      makeDoc({
        id: 'doc-1',
        title: 'HourOld',
        content: 'hello world',
        containerId: 'container-1',
        updatedAt: new Date(FIXED_NOW - 3 * 60 * 60_000).toISOString(),
      }),
      makeDoc({
        id: 'doc-2',
        title: 'DayOld',
        content: '',
        containerId: 'container-1',
        updatedAt: new Date(FIXED_NOW - 2 * 24 * 60 * 60_000).toISOString(),
      }),
      makeDoc({
        id: 'doc-3',
        title: 'MonthOld',
        content: 'one two three four five',
        containerId: 'container-1',
        updatedAt: new Date(FIXED_NOW - 30 * 24 * 60 * 60_000).toISOString(),
      }),
    ]);

    const out = await tool({}, {});

    expect(out).toContain('[Recent](container-1)  · 30m ago');
    // Docs get an extra `· Nw` word-count suffix so an agent can sort
    // reading order by length at a glance.
    expect(out).toContain('[HourOld](doc-1)  · 3h ago · 2w');
    expect(out).toContain('[DayOld](doc-2)  · 2d ago · 0w');
    // Older-than-a-week falls back to a localized month/day format —
    // assert on the structural separator rather than the exact label so
    // the test stays locale-stable.
    expect(out).toMatch(/\[MonthOld\]\(doc-3\)  · \w+ \d+ · 5w/);
  });

  // Threads
  // Threads attach to a project, not a folder: a project's threads render in
  // a `💬 Threads` block under it; flat threads in a workspace-level block.

  it("renders a project's threads in a Threads block after its docs and folders", async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-snaglet', name: 'Snaglet', category: 'project' }),
      makeContainer({ id: 'container-docs', name: 'docs', parentId: 'container-snaglet' }),
    ]);
    mockListAllOrderedDocs.mockResolvedValue([
      makeDoc({ id: 'doc-1', title: 'README', containerId: 'container-snaglet' }),
    ]);
    mockListAllOrderedThreads.mockResolvedValue([
      makeThread({ id: 'thread-1', title: 'Chat: auth', projectId: 'container-snaglet' }),
    ]);
    const out = await tool({}, {});
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^└── 📂 \[Snaglet\]\(container-snaglet\).*🗂️ project$/);
    expect(lines[1]).toMatch(/^ {4}├── 📂 \[docs\]\(container-docs\)/);
    expect(lines[2]).toMatch(/^ {4}├── 📄 \[README\]\(doc-1\)/);
    expect(lines[3]).toBe('    └── 💬 Threads');
    expect(lines[4]).toMatch(/^ {8}└── 💬 \[Chat: auth\]\(thread-1\)/);
    expect(out).toContain('1 thread(s)');
  });

  it("keeps a project's threads in their manual (sidebar) order", async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-snaglet', name: 'Snaglet', category: 'project' }),
    ]);
    // Threads.listAllOrdered already returns each project's threads in manual
    // order; the renderer must keep that order.
    mockListAllOrderedThreads.mockResolvedValue([
      makeThread({ id: 'thread-first', title: 'First', projectId: 'container-snaglet' }),
      makeThread({ id: 'thread-second', title: 'Second', projectId: 'container-snaglet' }),
    ]);
    const out = await tool({}, {});
    expect(out.indexOf('thread-first')).toBeLessThan(out.indexOf('thread-second'));
  });

  it('places flat threads in a workspace-level Threads block when unscoped', async () => {
    mockListAllOrderedThreads.mockResolvedValue([
      makeThread({ id: 'thread-loose', title: 'Stray', projectId: null }),
    ]);
    const out = await tool({}, {});
    expect(out).toMatch(/^└── 💬 Threads\n {4}└── 💬 \[Stray\]\(thread-loose\)/m);
    expect(out).toContain('1 thread(s)');
  });

  it('shows no threads when scoped to a non-project container', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-folder', name: 'Folder' }),
      makeContainer({ id: 'container-snaglet', name: 'Snaglet', category: 'project' }),
    ]);
    mockListAllOrderedThreads.mockResolvedValue([
      makeThread({ id: 'thread-project', title: 'In project', projectId: 'container-snaglet' }),
      makeThread({ id: 'thread-loose', title: 'Stray', projectId: null }),
    ]);
    const out = await tool({ container_id: 'container-folder' }, {});
    expect(out).not.toContain('Threads');
    expect(out).not.toContain('thread-');
    expect(out).toContain('0 thread(s)');
  });

  it("renders a nested project's threads under the nested project", async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-outer', name: 'Outer', category: 'project' }),
      makeContainer({ id: 'container-folder', name: 'Folder', parentId: 'container-outer' }),
      makeContainer({
        id: 'container-inner',
        name: 'Inner',
        parentId: 'container-folder',
        category: 'project',
      }),
    ]);
    mockListAllOrderedThreads.mockResolvedValue([
      makeThread({ id: 'thread-outer', title: 'Outer chat', projectId: 'container-outer' }),
      makeThread({ id: 'thread-inner', title: 'Inner chat', projectId: 'container-inner' }),
      makeThread({ id: 'thread-loose', title: 'Stray', projectId: null }),
    ]);
    const out = await tool({ container_id: 'container-outer' }, {});
    const lines = out.split('\n');
    const inner = lines.findIndex((l) => l.includes('[Inner](container-inner)'));
    const innerThread = lines.findIndex((l) => l.includes('thread-inner'));
    const outerThread = lines.findIndex((l) => l.includes('thread-outer'));
    // Inner's thread sits directly inside Inner's Threads block …
    expect(innerThread).toBe(inner + 2);
    expect(lines[inner + 1]).toMatch(/💬 Threads$/);
    // … while Outer's own thread is in Outer's block, after the subtree.
    expect(outerThread).toBeGreaterThan(innerThread);
    expect(out).not.toContain('thread-loose');
    expect(out).toContain('2 thread(s)');
  });

  it('uses lastMessageAt for thread recency, falling back to spine updatedAt', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-snaglet', name: 'Snaglet', category: 'project' }),
    ]);
    mockListAllOrderedThreads.mockResolvedValue([
      makeThread({
        id: 'thread-recent',
        title: 'Hot',
        projectId: 'container-snaglet',
        lastMessageAt: new Date(FIXED_NOW - 5 * 60_000).toISOString(),
      }),
    ]);
    const out = await tool({}, {});
    expect(out).toContain('[Hot](thread-recent)  · 5m ago');
  });

  // Projects

  it('renders the 🗂️ project tag on a project-category container line', async () => {
    // A project is its container — the `category='project'` facet flags it, so
    // no separate project row/link is emitted.
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-root', name: 'Snaglet', parentId: null, category: 'project' }),
      makeContainer({ id: 'container-child', name: 'Sub', parentId: 'container-root' }),
    ]);
    const out = await tool({}, {});
    // The project marker appears on the project container's own line.
    expect(out).toMatch(/\[Snaglet\]\(container-root\)[^\n]*🗂️ project/);
    // Non-project containers don't carry the project tag.
    const subLine = out.split('\n').find((l) => l.includes('container-child'));
    expect(subLine).not.toContain('🗂️ project');
    // No project(s) part in the summary count line.
    expect(out).not.toContain('project(s)');
  });

  it('leaves an uncategorized container line unmarked', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-plain', name: 'Plain', category: null }),
    ]);

    const out = await tool({}, {});
    const line = out.split('\n').find((candidate) => candidate.includes('container-plain'));

    expect(line).toContain('📂 [Plain](container-plain)');
    expect(line).not.toMatch(/🗂️ project|📋/);
  });

  // kinds filter

  it('omits threads when `kinds` excludes them', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-1', name: 'Root' }),
    ]);
    mockListAllOrderedDocs.mockResolvedValue([
      makeDoc({ id: 'doc-1', title: 'KeepMe', containerId: 'container-1' }),
    ]);
    mockListAllOrderedThreads.mockResolvedValue([
      makeThread({ id: 'thread-1', title: 'HideMe', projectId: 'container-1' }),
    ]);
    const out = await tool({ kinds: ['container', 'doc'] }, {});
    expect(out).toContain('KeepMe');
    expect(out).not.toContain('HideMe');
    expect(out).not.toContain('thread(s)');
    // Threads should not even be fetched when filtered out.
    expect(mockListAllOrderedThreads).not.toHaveBeenCalled();
  });

  it('accepts a comma-separated string for `kinds`', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      makeContainer({ id: 'container-1', name: 'Root' }),
    ]);
    mockListAllOrderedDocs.mockResolvedValue([
      makeDoc({ id: 'doc-1', title: 'KeepDoc', containerId: 'container-1' }),
    ]);
    const out = await tool({ kinds: 'container,doc' }, {});
    expect(out).toContain('KeepDoc');
    expect(out).not.toContain('thread(s)');
  });
});
