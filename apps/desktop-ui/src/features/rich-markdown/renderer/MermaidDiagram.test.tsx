import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { __resetTableNameCacheForTests } from '@desktop/features/database/tableNameCache';
import { __resetEntryNameCacheForTests } from '@desktop/features/table-entries/entryNameCache';
import { DashboardNavigationProvider } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { MermaidDiagram } from './MermaidDiagram';
import { extractMermaidChips } from './mermaidChips';
import { renderMermaid } from './mermaidRender';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});
const api = vi.hoisted(() => ({
  listTree: vi.fn(),
  listTables: vi.fn(),
  archivedTables: vi.fn(),
  resolveEntries: vi.fn(),
  entries: vi.fn(),
}));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: api.listTree },
    tablesApi: {
      ...actual.tablesApi,
      list: api.listTables,
      resolveEntries: api.resolveEntries,
      entries: api.entries,
    },
    archiveApi: { ...actual.archiveApi, tables: api.archivedTables },
  };
});
// The agent roster: `cached` is what has loaded (null: nothing yet), and
// `ensureAgents` loads `roster` into it.
const agents = vi.hoisted(() => ({
  cached: null as Array<{ id: string; name: string }> | null,
  roster: [] as Array<{ id: string; name: string }>,
  ensure: vi.fn(),
}));
vi.mock('@desktop/features/rich-markdown/editor/agentMentionCache', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@desktop/features/rich-markdown/editor/agentMentionCache')
    >();
  return { ...actual, getAgentsCached: () => agents.cached, ensureAgents: agents.ensure };
});
vi.mock('@desktop/features/rich-markdown/preview/WikiLinkPreviewModal', () => ({
  WikiLinkPreviewModal: ({ kind, id }: { kind: string; id: string }) => (
    <div role="dialog" aria-label="Node preview">{`${kind}:${id}`}</div>
  ),
}));
vi.mock('./mermaidRender', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mermaidRender')>();
  return { ...actual, renderMermaid: vi.fn() };
});
const mockedRender = vi.mocked(renderMermaid);
const image = 'data:image/svg+xml,test';
const size = { width: 800, height: 400 };
const DOC = 'doc-1111111111111-aaaaaaaaa';
const TABLE = 'table-1111111111111-aaaaaaaaa';
const ENTRY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AGENT = 'test-agent-a';

const catalogEntry = (id: string, name: string): TableCatalogEntry => ({
  id,
  name,
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  vi.useFakeTimers();
  mockedRender.mockReset().mockResolvedValue({ src: image, size, nodes: [] });
  api.listTree.mockReset().mockResolvedValue([]);
  // Each test starts from a fresh library tree, table catalog, row names and roster.
  emitLibraryEvent({ type: 'tree-invalidated', ids: [] });
  __resetTableNameCacheForTests();
  __resetEntryNameCacheForTests();
  api.listTables.mockReset().mockResolvedValue({ tables: [catalogEntry(TABLE, 'test_backlog')] });
  api.archivedTables.mockReset().mockResolvedValue({ tables: [] });
  api.resolveEntries.mockReset().mockResolvedValue({
    entries: [{ tableId: TABLE, entryId: ENTRY_ID, name: 'Fix login', tableName: 'test_backlog' }],
  });
  api.entries.mockReset().mockResolvedValue({ page: 1 });
  agents.cached = null;
  agents.roster = [{ id: AGENT, name: 'Test Agent A' }];
  agents.ensure.mockReset().mockImplementation(async () => {
    agents.cached = agents.roster;
    return agents.cached;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** jsdom does no layout: give every viewer box and image a size. */
function stubLayout(box: { width: number; height: number }, natural = size) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => box.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => box.height);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockImplementation(
    () => natural.width
  );
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockImplementation(
    () => natural.height
  );
}

function loadImages() {
  for (const img of screen.queryAllByRole('img', { name: 'Mermaid diagram' })) fireEvent.load(img);
}

async function finishDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
}

describe('MermaidDiagram', () => {
  it.each([true, false])('prevents native preview dragging (showSource=%s)', async (showSource) => {
    const outerDrag = vi.fn();
    render(
      <div onDragStart={outerDrag}>
        <MermaidDiagram source="graph TD; A-->B" showSource={showSource} />
      </div>
    );
    await finishDebounce();
    const preview = screen.getByRole('img');
    expect(preview).toHaveAttribute('draggable', 'false');
    expect(fireEvent.dragStart(preview)).toBe(false);
    expect(outerDrag).not.toHaveBeenCalled();
    if (showSource) {
      // The source remains normal selectable/copyable text, not part of the guard.
      expect(fireEvent.dragStart(screen.getByText('graph TD; A-->B'))).toBe(true);
      expect(outerDrag).toHaveBeenCalledOnce();
    }
  });
  it('renders an image and keeps the original source available', async () => {
    render(<MermaidDiagram source="graph TD; A-->B" />);
    expect(screen.getByRole('status')).toHaveTextContent('Rendering');
    await finishDebounce();
    expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toHaveAttribute('src', image);
    expect(screen.getByText('graph TD; A-->B')).toBeInTheDocument();
    expect(screen.getByText('Diagram source').closest('details')).not.toHaveAttribute('open');
  });

  it('shows errors as text with expanded source and recovers after an edit', async () => {
    mockedRender.mockRejectedValueOnce(new Error('<script>bad syntax</script>'));
    const { rerender, container } = render(<MermaidDiagram source="broken" />);
    await finishDebounce();
    expect(screen.getByRole('status')).toHaveTextContent('Unable to render');
    expect(screen.getByText('Diagram source').closest('details')).toHaveAttribute('open');
    expect(container.querySelector('script')).toBeNull();
    rerender(<MermaidDiagram source="graph TD; A-->B" />);
    await finishDebounce();
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.queryByText('<script>bad syntax</script>')).toBeNull();
  });

  it('coalesces streaming edits and never displays an old completion', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof renderMermaid>>) => void;
    mockedRender.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    const { rerender } = render(<MermaidDiagram source="old" />);
    await finishDebounce();
    const oldSignal = mockedRender.mock.calls[0]?.[1];
    rerender(<MermaidDiagram source="intermediate" />);
    rerender(<MermaidDiagram source="new" />);
    expect(oldSignal?.aborted).toBe(true);
    await finishDebounce();
    await act(async () => {
      resolveOld({ src: 'data:image/svg+xml,old', size, nodes: [] });
    });
    expect(mockedRender).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('img')).toHaveAttribute('src', image);
  });

  it('does not start work after unmounting during debounce', async () => {
    const { unmount } = render(<MermaidDiagram source="graph TD; A-->B" />);
    unmount();
    await finishDebounce();
    expect(mockedRender).not.toHaveBeenCalled();
  });

  it('keeps a successful image visible while an edited diagram is rendering', async () => {
    const { rerender } = render(<MermaidDiagram source="first" />);
    await finishDebounce();
    rerender(<MermaidDiagram source="updated" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', image);
    expect(screen.getByRole('status')).toHaveTextContent('Updating');
    await finishDebounce();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the diagram in a pan/zoom viewer sized from the diagram', async () => {
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await finishDebounce();
    const viewer = screen.getByRole('group', { name: 'Image viewer' });
    const preview = within(viewer).getByRole('img', { name: 'Mermaid diagram' });
    expect(preview).toHaveAttribute('data-snaglet-mermaid-preview', '');
    const box = viewer.closest<HTMLElement>('[data-mermaid-viewport]');
    expect(box).not.toBeNull();
    expect(box).toHaveAttribute('data-sized');
    expect(box?.style.getPropertyValue('--mermaid-ratio')).toBe('800 / 400');
    expect(box?.style.getPropertyValue('--mermaid-height')).toBe('400px');
  });

  it('uses a fixed box when the diagram has no intrinsic size', async () => {
    mockedRender.mockResolvedValue({ src: image, size: null, nodes: [] });
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await finishDebounce();
    const box = document.querySelector('[data-mermaid-viewport]');
    expect(box).not.toBeNull();
    expect(box).not.toHaveAttribute('data-sized');
  });

  it('lets a plain wheel scroll the page at fit and zooms in place with Ctrl/⌘ + wheel', async () => {
    stubLayout({ width: 400, height: 200 });
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await finishDebounce();
    loadImages();
    const viewer = screen.getByRole('group', { name: 'Image viewer' });
    expect(within(viewer).getByRole('status')).toHaveTextContent('50%');
    expect(fireEvent.wheel(viewer, { deltaY: 40 })).toBe(true);
    expect(fireEvent.wheel(viewer, { ctrlKey: true, deltaY: -20 })).toBe(false);
    expect(viewer).toHaveAttribute('data-zoomed');
  });

  it('opens the diagram large in a preview modal that closes on Escape or Close', async () => {
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await finishDebounce();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open diagram larger' }));
    const dialog = screen.getByRole('dialog', { name: 'Mermaid diagram preview' });
    const large = within(dialog).getByRole('img', { name: 'Mermaid diagram' });
    expect(large).toHaveAttribute('src', image);
    expect(large).toHaveAttribute('data-snaglet-mermaid-preview', '');
    expect(within(dialog).getByRole('group', { name: 'Image viewer' })).toBeInTheDocument();
    // A native drag out of the modal never carries the SVG data URI either.
    expect(fireEvent.dragStart(large)).toBe(false);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open diagram larger' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a small diagram bigger than actual size in the preview modal', async () => {
    stubLayout({ width: 1000, height: 700 }, { width: 200, height: 100 });
    mockedRender.mockResolvedValue({ src: image, size: { width: 200, height: 100 }, nodes: [] });
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await finishDebounce();
    fireEvent.click(screen.getByRole('button', { name: 'Open diagram larger' }));
    loadImages();
    const dialog = screen.getByRole('dialog', { name: 'Mermaid diagram preview' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('200%');
  });
});

describe('MermaidDiagram node chips', () => {
  const box = { x: 10, y: 20, width: 200, height: 40 };
  const labelWidth = 150;
  const nav = { openTable: vi.fn(), openTableEntry: vi.fn() };
  const chipSlots = (scope: HTMLElement | Document = document) =>
    Array.from(scope.querySelectorAll<HTMLElement>('[data-mermaid-chip]'));

  /** Render `source`, answering with an image whose nodes carry `labels`. */
  async function renderChart(
    source: string,
    labels: (rewritten: string, chipLabels: readonly string[]) => string[]
  ) {
    mockedRender.mockImplementation(async (rewritten, _signal, options) => ({
      src: image,
      size,
      nodes: labels(rewritten, options?.chipLabels ?? []).map((label) => ({
        label,
        box,
        labelWidth,
      })),
    }));
    stubLayout({ width: 800, height: 400 });
    nav.openTable.mockReset();
    nav.openTableEntry.mockReset();
    render(
      <DashboardNavigationProvider
        value={{ openInPane: vi.fn(), openThreadAgent: vi.fn(), requestReveal: vi.fn(), ...nav }}
      >
        <MermaidDiagram source={source} />
      </DashboardNavigationProvider>
    );
    await finishDebounce();
    await finishDebounce();
    loadImages();
  }

  /** An image that draws every chip node it was asked to. */
  const everyChip = (_rewritten: string, chipLabels: readonly string[]) => [...chipLabels];
  const chipAt = (index: number) =>
    chipSlots()[index]?.querySelector<HTMLAnchorElement>('a.md-chip') ?? null;

  it('renders a bare-id node as a chip over its box and hands Mermaid the rewritten source', async () => {
    const source = `graph TD; A[${DOC}] --> B[Next]`;
    const { source: rewritten, chips } = extractMermaidChips(source);
    await renderChart(source, () => [chips[0]?.label ?? '', 'Next']);

    expect(mockedRender).toHaveBeenCalledWith(rewritten, expect.any(AbortSignal), {
      chipLabels: [chips[0]?.label],
    });
    const slots = chipSlots();
    expect(slots).toHaveLength(1);
    // At fit the 800×400 diagram fills the 800×400 box: natural px = image px.
    // The slot is the node's height and its label's width plus 8px a side.
    expect(slots[0]).toHaveStyle({ left: '27px', top: '20px', width: '166px', height: '40px' });
    const chip = slots[0]?.querySelector('.md-chip');
    expect(chip).toHaveAttribute('data-node-id', DOC);
    expect(chip).toHaveTextContent(DOC);
    // The original source stays what the reader sees.
    expect(screen.getByText(source)).toBeInTheDocument();
  });

  it('shows a bare id under its current title, and sizes the node for it', async () => {
    api.listTree.mockResolvedValue([{ kind: 'doc', id: DOC, title: 'Release plan' }]);
    const source = `graph TD; A[${DOC}] --> B[Next]`;
    await renderChart(source, () => []);
    const rewritten = mockedRender.mock.lastCall?.[0] ?? '';
    expect(rewritten).toContain('\u2060Release plan\u2060');
    expect(mockedRender).toHaveBeenCalledTimes(1);
  });

  it('shows the link text of a markdown-link node as the chip title', async () => {
    const source = `graph TD; A["[Spec](${DOC}#L12-L20)"] --> B[Next]`;
    const { chips } = extractMermaidChips(source);
    await renderChart(source, () => [chips[0]?.label ?? '']);
    const chip = chipSlots()[0]?.querySelector('.md-chip');
    expect(chip?.querySelector('.md-chip-title')).toHaveTextContent('Spec');
    expect(chip).toHaveAttribute('data-node-url', `${DOC}#L12-L20`);
  });

  it('shows the chips in the preview modal too', async () => {
    const source = `graph TD; A["[Spec](${DOC})"] --> B[Next]`;
    const { chips } = extractMermaidChips(source);
    await renderChart(source, () => [chips[0]?.label ?? '']);
    fireEvent.click(screen.getByRole('button', { name: 'Open diagram larger' }));
    loadImages();
    const dialog = screen.getByRole('dialog', { name: 'Mermaid diagram preview' });
    expect(chipSlots(dialog)).toHaveLength(1);
    expect(chipSlots(dialog)[0]?.querySelector('.md-chip')).toHaveAttribute('data-node-id', DOC);
  });

  it('opens the node preview on click, and never pans or zooms the chart from a chip', async () => {
    const source = `graph TD; A["[Spec](${DOC})"] --> B[Next]`;
    const { chips } = extractMermaidChips(source);
    await renderChart(source, () => [chips[0]?.label ?? '']);
    const viewer = screen.getByRole('group', { name: 'Image viewer' });
    fireEvent.keyDown(viewer, { key: '+' });
    expect(viewer).toHaveAttribute('data-pannable');
    const zoom = within(viewer).getByRole('status').textContent;

    const chip = chipSlots()[0]?.querySelector<HTMLElement>('.md-chip');
    expect(chip).toBeInstanceOf(HTMLElement);
    if (!chip) return;
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(viewer).not.toHaveAttribute('data-dragging');
    fireEvent.pointerUp(chip, { button: 0, pointerId: 1 });
    fireEvent.doubleClick(chip);
    expect(within(viewer).getByRole('status').textContent).toBe(zoom);

    fireEvent.click(chip);
    expect(screen.getByRole('dialog', { name: 'Node preview' })).toHaveTextContent(`page:${DOC}`);

    // Empty parts of the chart still pan.
    fireEvent.pointerDown(viewer, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    expect(viewer).toHaveAttribute('data-dragging');
  });

  it('renders no chip layer for a diagram without chips, or when a chip node is missing', async () => {
    await renderChart('graph TD; A-->B', () => ['A', 'B']);
    expect(mockedRender).toHaveBeenCalledWith('graph TD; A-->B', expect.any(AbortSignal), {
      chipLabels: [],
    });
    expect(chipSlots()).toHaveLength(0);
  });

  it('skips a chip whose node the image does not carry', async () => {
    await renderChart(`graph TD; A[${DOC}] --> B[Next]`, () => ['Next']);
    expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument();
    expect(chipSlots()).toHaveLength(0);
  });

  it('renders a table link as a table chip that opens the table', async () => {
    await renderChart(`graph TD; A["[Old name](table:${TABLE})"] --> B[Next]`, everyChip);
    const chip = chipAt(0);
    expect(chip).toHaveClass('md-chip-table');
    expect(chip).toHaveAttribute('data-node-id', TABLE);
    expect(chip).toHaveAttribute('href', `table:${TABLE}`);
    // Like a table chip in prose, it shows the catalog's current name.
    await finishDebounce();
    expect(chip?.querySelector('.md-chip-title')).toHaveTextContent('test_backlog');
    if (chip) fireEvent.click(chip);
    expect(nav.openTable).toHaveBeenCalledWith(TABLE);
  });

  it('renders a row link as a row chip that opens the row', async () => {
    await renderChart(
      `graph TD; A["[Old title](entry:${TABLE}/${ENTRY_ID})"] --> B[Next]`,
      everyChip
    );
    const chip = chipAt(0);
    expect(chip).toHaveClass('md-chip-entry');
    expect(chip).toHaveAttribute('data-node-id', `${TABLE}/${ENTRY_ID}`);
    await finishDebounce();
    expect(chip?.querySelector('.md-chip-title')).toHaveTextContent('Fix login');
    if (chip) fireEvent.click(chip);
    expect(nav.openTableEntry).toHaveBeenCalledWith(TABLE, ENTRY_ID);
  });

  it('waits for the table catalog, then draws a row by table name once, as a chip', async () => {
    await renderChart(`graph TD; A["[Fix login](test_backlog:${ENTRY_ID})"] --> B`, everyChip);
    expect(api.listTables).toHaveBeenCalledTimes(1);
    expect(mockedRender).toHaveBeenCalledTimes(1);
    expect(mockedRender.mock.lastCall?.[0]).toContain('\u2060Fix login\u2060');
    const chip = chipAt(0);
    expect(chip).toHaveClass('md-chip-entry');
    expect(chip).toHaveAttribute('href', `test_backlog:${ENTRY_ID}`);
    if (chip) fireEvent.click(chip);
    expect(nav.openTableEntry).toHaveBeenCalledWith(TABLE, ENTRY_ID);
  });

  it('waits for the agent roster, then draws a link to an agent id once, as a chip', async () => {
    await renderChart(`graph TD; A["[Test Agent A](${AGENT})"] --> B`, everyChip);
    expect(agents.ensure).toHaveBeenCalledTimes(1);
    expect(mockedRender).toHaveBeenCalledTimes(1);
    const chip = chipAt(0);
    expect(chip).toHaveClass('md-chip-agent');
    expect(chip).toHaveAttribute('data-node-id', AGENT);
    expect(chip?.querySelector('.md-chip-title')).toHaveTextContent('Test Agent A');
    if (chip) fireEvent.click(chip);
    expect(screen.getByRole('dialog', { name: 'Node preview' })).toHaveTextContent(
      `agent:${AGENT}`
    );
  });

  it('renders an agent:<agent id> link as an agent chip without loading the roster', async () => {
    await renderChart(`graph TD; A["[Test Agent A](agent:${AGENT})"] --> B`, everyChip);
    expect(agents.ensure).not.toHaveBeenCalled();
    const chip = chipAt(0);
    expect(chip).toHaveClass('md-chip-agent');
    expect(chip).toHaveAttribute('data-node-id', AGENT);
    if (chip) fireEvent.click(chip);
    expect(screen.getByRole('dialog', { name: 'Node preview' })).toHaveTextContent(
      `agent:${AGENT}`
    );
  });

  it('draws a link no agent or table answers to as plain text once the lookups settle', async () => {
    const source = [
      'graph TD',
      '  A["[Someone](someone-else)"] --> B["[Row](other_table:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee)"]',
      `  B --> C[${AGENT}]`,
    ].join('\n');
    await renderChart(source, everyChip);
    expect(agents.ensure).toHaveBeenCalledTimes(1);
    expect(api.listTables).toHaveBeenCalledTimes(1);
    expect(mockedRender).toHaveBeenCalledTimes(1);
    expect(mockedRender).toHaveBeenCalledWith(source, expect.any(AbortSignal), { chipLabels: [] });
    expect(chipSlots()).toHaveLength(0);
  });

  it('still draws the chart when a lookup fails', async () => {
    agents.ensure.mockReset().mockRejectedValue(new Error('roster unavailable'));
    const source = `graph TD; A["[Test Agent A](${AGENT})"] --> B`;
    await renderChart(source, everyChip);
    expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument();
    expect(mockedRender).toHaveBeenCalledWith(source, expect.any(AbortSignal), { chipLabels: [] });
    expect(chipSlots()).toHaveLength(0);
  });

  it('neither loads nor waits for a roster that is already warm', async () => {
    agents.cached = agents.roster;
    // A load that never lands: waiting on it would hold the chart past renderChart.
    agents.ensure.mockReset().mockReturnValue(new Promise(() => {}));
    await renderChart(`graph TD; A["[Test Agent A](${AGENT})"] --> B`, everyChip);
    expect(agents.ensure).not.toHaveBeenCalled();
    expect(mockedRender).toHaveBeenCalledTimes(1);
    expect(chipAt(0)).toHaveClass('md-chip-agent');
  });

  it('draws plain labels once a hung lookup outlasts its wait, and the chip when it lands', async () => {
    let land = () => {};
    agents.ensure.mockReset().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          land = () => {
            agents.cached = agents.roster;
            resolve();
          };
        })
    );
    const source = `graph TD; A["[Test Agent A](${AGENT})"] --> B`;
    await renderChart(source, everyChip);
    expect(mockedRender).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Rendering diagram');

    // The wait runs out 1.5 s in: the chart draws with the link as plain text.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(mockedRender).not.toHaveBeenCalled();
    await finishDebounce();
    expect(mockedRender).toHaveBeenCalledTimes(1);
    expect(mockedRender).toHaveBeenLastCalledWith(source, expect.any(AbortSignal), {
      chipLabels: [],
    });
    loadImages();
    expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument();
    expect(chipSlots()).toHaveLength(0);

    // The roster lands late: one more render, now with the chip.
    await act(async () => {
      land();
    });
    await finishDebounce();
    loadImages();
    expect(mockedRender).toHaveBeenCalledTimes(2);
    expect(chipAt(0)).toHaveClass('md-chip-agent');
  });
});
