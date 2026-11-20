import { checkSidebarDisclosures } from '@desktop/test/sidebarDisclosure';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolRow } from '@desktop/utils/api';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import { ToolsView } from './ToolsView';
import type { ComponentProps } from 'react';

// ToolsView pulls `toolsApi` + `toolWorkspacesApi` (and the erased `ToolRow`
// type) from the api barrel at runtime, and `onLibraryEvent` for its sync
// listener. Stub all so the tree renders from a fixed tool list with no
// network / event plumbing.
const { listMock, deleteToolMock, deleteWorkspaceMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  deleteToolMock: vi.fn(),
  deleteWorkspaceMock: vi.fn(),
}));
vi.mock('@desktop/utils/api', () => ({
  toolsApi: { list: listMock, delete: deleteToolMock },
  toolWorkspacesApi: { delete: deleteWorkspaceMock },
}));

// A capturing `onLibraryEvent` mock — `triggerLibraryEvent` lets a test fire
// a fake `tool-saved`/`tool-enabled-changed` event exactly as the pane-hosted
// ToolBuilderPanel (via ToolPane) would, without any real
// event-bus plumbing.
const { onLibraryEventMock, triggerLibraryEvent } = vi.hoisted(() => {
  const handlers = new Set<(event: unknown) => void>();
  return {
    onLibraryEventMock: vi.fn((handler: (event: unknown) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    triggerLibraryEvent: (event: unknown) => handlers.forEach((handler) => handler(event)),
  };
});
vi.mock('@desktop/utils/workspaceEvents.js', () => ({ onLibraryEvent: onLibraryEventMock }));

// The top-level components barrel and nodeChip barrel transitively load
// api/config modules that need Vite env vars unavailable under vitest.
// Stub the display-only Light, functional Button and Select, and unused drag
// writer.
vi.mock('@desktop/components', () => ({
  Light: () => null,
  Select: ({
    size: _size,
    unstyled: _unstyled,
    ...rest
  }: Omit<ComponentProps<'select'>, 'size'> & { size?: string; unstyled?: boolean }) => (
    <select {...rest} />
  ),
  Button: ({
    children,
    variant: _variant,
    size: _size,
    iconOnly: _iconOnly,
    loading: _loading,
    loadingText: _loadingText,
    // Real Button defaults its native `type` to 'button' (see
    // components/controls/Button/Button.tsx) so a Cancel button inside a
    // <form> never accidentally submits it — match that default here too.
    type = 'button',
    ...rest
  }: ComponentProps<'button'> & {
    variant?: string;
    size?: string;
    iconOnly?: boolean;
    loading?: boolean;
    loadingText?: string;
  }) => (
    <button type={type} {...rest}>
      {children}
    </button>
  ),
}));
vi.mock('@desktop/utils/nodeChip/index.js', () => ({
  writeChipDragData: vi.fn(),
  clearChipDragPayload: vi.fn(),
}));

function makeTool(overrides: Partial<ToolRow> & Pick<ToolRow, 'id' | 'name'>): ToolRow {
  return {
    description: '',
    type: 'builtin',
    parametersSchema: {},
    source: null,
    configJson: {},
    aliases: [],
    enabled: true,
    tier: 'standard',
    categoryPath: 'uncategorized',
    providerId: null,
    availability: 'available',
    keywords: [],
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Categories open collapsed. Waits for the list to load, then opens every
 * closed category, outermost first (a sub-category mounts only once its
 * parent is open), so the tool rows render.
 */
async function expandAllCategories(): Promise<void> {
  await waitFor(() =>
    expect(document.querySelector('[data-sidebar-mounted="ready"]')).not.toBeNull()
  );
  for (let clicks = 0; clicks < 50; clicks += 1) {
    const closed = screen
      .queryAllByRole('treeitem')
      .find((row) => row.getAttribute('aria-expanded') === 'false');
    if (!closed) return;
    fireEvent.click(closed);
  }
  throw new Error('Categories still closed after 50 clicks');
}

/** The view header, which holds the filter and the total count. */
const headerOf = () => screen.getByRole('combobox', { name: 'Show tools' }).closest('header')!;

const treeItemOf = (text: string) =>
  screen.getByText(text).closest<HTMLElement>('[role="treeitem"]');

describe('ToolsView group toggle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    listMock.mockReset();
  });

  it('opens with every category and sub-category collapsed', async () => {
    listMock.mockResolvedValue([
      makeTool({ id: 'a', name: 'alpha-tool', categoryPath: 'docs' }),
      makeTool({ id: 'g', name: 'gmail-tool', categoryPath: 'integrations/google' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);

    expect(await screen.findByText('Docs')).toBeInTheDocument();
    expect(treeItemOf('Docs')).toHaveAttribute('aria-expanded', 'false');
    expect(treeItemOf('Integrations')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Google')).not.toBeInTheDocument();
    expect(screen.queryByText('alpha-tool')).not.toBeInTheDocument();
    expect(screen.queryByText('gmail-tool')).not.toBeInTheDocument();
  });

  it('opens collapsed again after a category was expanded and the view closed', async () => {
    listMock.mockResolvedValue([makeTool({ id: 'a', name: 'alpha-tool', categoryPath: 'docs' })]);

    const first = render(
      <ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />
    );
    await userEvent.click(await screen.findByText('Docs'));
    expect(screen.getByText('alpha-tool')).toBeInTheDocument();
    first.unmount();

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);

    expect(await screen.findByText('Docs')).toBeInTheDocument();
    expect(treeItemOf('Docs')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('alpha-tool')).not.toBeInTheDocument();
  });

  it('expands a collapsed section on a single click and collapses it on the next', async () => {
    listMock.mockResolvedValue([
      makeTool({ id: 'a', name: 'alpha-tool', categoryPath: 'docs' }),
      makeTool({ id: 'b', name: 'beta-tool', categoryPath: 'docs' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);

    // The first click is never a no-op: it opens the collapsed section.
    await userEvent.click(await screen.findByLabelText('Expand'));
    expect(screen.getByText('alpha-tool')).toBeInTheDocument();
    expect(screen.getByText('beta-tool')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Collapse'));
    expect(screen.queryByText('alpha-tool')).not.toBeInTheDocument();
    expect(screen.queryByText('beta-tool')).not.toBeInTheDocument();
  });

  it('expands a collapsed group on a single click', async () => {
    listMock.mockResolvedValue([
      makeTool({ id: 'g', name: 'gmail-tool', categoryPath: 'integrations/google' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);

    // Opening "Integrations" shows its "Google" group, itself still closed.
    await userEvent.click(await screen.findByText('Integrations'));
    const groupHeader = screen.getByText('Google');
    expect(screen.queryByText('gmail-tool')).not.toBeInTheDocument();

    await userEvent.click(groupHeader);

    expect(screen.getByText('gmail-tool')).toBeInTheDocument();
  });
});

describe('ToolsView counts', () => {
  beforeEach(() => {
    window.localStorage.clear();
    listMock.mockReset();
  });

  it('shows the plain total under All when every tool in a category is on, else enabled/total', async () => {
    listMock.mockResolvedValue([
      makeTool({ id: 'a', name: 'alpha-tool', categoryPath: 'docs' }),
      makeTool({ id: 'b', name: 'beta-tool', categoryPath: 'docs' }),
      makeTool({ id: 'w1', name: 'web-on', categoryPath: 'web' }),
      makeTool({ id: 'w2', name: 'web-off', categoryPath: 'web', enabled: false }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);

    await screen.findByText('Docs');
    expect(within(treeItemOf('Docs')!).getByTitle('2 of 2 enabled')).toHaveTextContent(/^2$/);
    expect(within(treeItemOf('Web')!).getByTitle('1 of 2 enabled')).toHaveTextContent(/^1\/2$/);
    // The header total sits next to the filter and reads the same way.
    expect(within(headerOf()).getByTitle('3 of 4 enabled')).toHaveTextContent(/^3\/4$/);
  });

  it('counts a sub-category from the tools it lists', async () => {
    listMock.mockResolvedValue([
      makeTool({ id: 'g1', name: 'gmail-tool', categoryPath: 'integrations/google' }),
      makeTool({
        id: 'g2',
        name: 'drive-tool',
        categoryPath: 'integrations/google',
        enabled: false,
      }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await userEvent.click(await screen.findByText('Integrations'));

    expect(within(treeItemOf('Google')!).getByTitle('1 of 2 enabled')).toHaveTextContent(/^1\/2$/);
  });
});

describe('ToolsView filter', () => {
  const tools = [
    makeTool({ id: 'a', name: 'alpha-tool', categoryPath: 'docs' }),
    makeTool({ id: 'b', name: 'beta-tool', categoryPath: 'docs', enabled: false }),
    makeTool({ id: 'w', name: 'web-off', categoryPath: 'web', enabled: false }),
    makeTool({ id: 'g', name: 'gmail-tool', categoryPath: 'integrations/google' }),
  ];
  const filterSelect = () => screen.getByRole('combobox', { name: 'Show tools' });
  const toggled = (id: string, enabled: boolean) => ({
    type: 'tool-enabled-changed',
    scope: 'tool',
    id,
    enabled,
    availability: enabled ? 'available' : 'disabled',
  });
  // jsdom has no scrollIntoView or CSS.escape; reveal tests stub both.
  const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  const stubRevealDom = () => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  };

  beforeEach(() => {
    window.localStorage.clear();
    listMock.mockReset();
    listMock.mockResolvedValue(tools);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (scrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoView);
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });

  it('defaults to All and lists every tool', async () => {
    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();

    expect(filterSelect()).toHaveValue('all');
    for (const name of ['alpha-tool', 'beta-tool', 'web-off', 'gmail-tool']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it('Enabled hides disabled tools and categories left empty, and counts what it shows', async () => {
    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await screen.findByText('Docs');

    await userEvent.selectOptions(filterSelect(), 'enabled');
    await expandAllCategories();

    expect(screen.getByText('alpha-tool')).toBeInTheDocument();
    expect(screen.getByText('gmail-tool')).toBeInTheDocument();
    expect(screen.queryByText('beta-tool')).not.toBeInTheDocument();
    expect(screen.queryByText('web-off')).not.toBeInTheDocument();
    expect(screen.queryByText('Web')).not.toBeInTheDocument();
    expect(within(treeItemOf('Docs')!).getByTitle('1 enabled')).toHaveTextContent(/^1$/);
    expect(within(treeItemOf('Google')!).getByTitle('1 enabled')).toHaveTextContent(/^1$/);
    expect(within(headerOf()).getByTitle('2 enabled')).toHaveTextContent(/^2$/);
  });

  it('Disabled shows only disabled tools and counts them', async () => {
    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await screen.findByText('Docs');

    await userEvent.selectOptions(filterSelect(), 'disabled');
    await expandAllCategories();

    expect(screen.getByText('beta-tool')).toBeInTheDocument();
    expect(screen.getByText('web-off')).toBeInTheDocument();
    expect(screen.queryByText('alpha-tool')).not.toBeInTheDocument();
    expect(screen.queryByText('Integrations')).not.toBeInTheDocument();
    expect(within(treeItemOf('Docs')!).getByTitle('1 disabled')).toHaveTextContent(/^1$/);
    expect(within(treeItemOf('Web')!).getByTitle('1 disabled')).toHaveTextContent(/^1$/);
    expect(within(headerOf()).getByTitle('2 disabled')).toHaveTextContent(/^2$/);
  });

  it('says so when no tool matches the filter', async () => {
    listMock.mockResolvedValue([makeTool({ id: 'a', name: 'alpha-tool', categoryPath: 'docs' })]);
    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await screen.findByText('Docs');

    await userEvent.selectOptions(filterSelect(), 'disabled');

    expect(screen.getByText('No disabled tools')).toBeInTheDocument();
    expect(screen.queryByText('Docs')).not.toBeInTheDocument();
  });

  it('remembers the choice the next time the view opens', async () => {
    const first = render(
      <ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />
    );
    await screen.findByText('Docs');
    await userEvent.selectOptions(filterSelect(), 'disabled');
    first.unmount();

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await screen.findByText('Docs');

    expect(filterSelect()).toHaveValue('disabled');
    expect(screen.queryByText('Integrations')).not.toBeInTheDocument();
  });

  it('falls back to All, and still filters, when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await screen.findByText('Docs');
    expect(filterSelect()).toHaveValue('all');

    await userEvent.selectOptions(filterSelect(), 'enabled');
    expect(filterSelect()).toHaveValue('enabled');
    expect(screen.queryByText('Web')).not.toBeInTheDocument();
  });

  it('ignores a stored value that is not a filter', async () => {
    window.localStorage.setItem('snaglet.dashboard.toolsView.filter', 'everything');

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await screen.findByText('Docs');

    expect(filterSelect()).toHaveValue('all');
  });

  it('switches to All, without saving it, when a tool hidden by the filter is revealed', async () => {
    stubRevealDom();
    window.localStorage.setItem('snaglet.dashboard.toolsView.filter', 'enabled');

    render(
      <ToolsView
        onToolCreate={vi.fn()}
        onToolClick={vi.fn()}
        onToolEdit={vi.fn()}
        revealNodeId="w"
        revealNonce={1}
      />
    );

    expect(await screen.findByText('web-off')).toBeInTheDocument();
    expect(filterSelect()).toHaveValue('all');
    // The viewer's saved choice is theirs: the next open shows Enabled again.
    expect(window.localStorage.getItem('snaglet.dashboard.toolsView.filter')).toBe('enabled');
  });

  it('handles a reveal once: a later tool change keeps the filter the viewer picked again', async () => {
    stubRevealDom();
    window.localStorage.setItem('snaglet.dashboard.toolsView.filter', 'enabled');
    render(
      <ToolsView
        onToolCreate={vi.fn()}
        onToolClick={vi.fn()}
        onToolEdit={vi.fn()}
        revealNodeId="w"
        revealNonce={1}
      />
    );
    await screen.findByText('web-off');

    await userEvent.selectOptions(filterSelect(), 'enabled');
    act(() => triggerLibraryEvent(toggled('a', true)));

    expect(filterSelect()).toHaveValue('enabled');
    expect(screen.queryByText('web-off')).not.toBeInTheDocument();
  });

  it('hides a revealed tool switched off under Enabled instead of flipping to All', async () => {
    stubRevealDom();
    window.localStorage.setItem('snaglet.dashboard.toolsView.filter', 'enabled');
    render(
      <ToolsView
        onToolCreate={vi.fn()}
        onToolClick={vi.fn()}
        onToolEdit={vi.fn()}
        revealNodeId="a"
        revealNonce={1}
      />
    );
    expect(await screen.findByText('alpha-tool')).toBeInTheDocument();
    expect(filterSelect()).toHaveValue('enabled');

    act(() => triggerLibraryEvent(toggled('a', false)));

    expect(filterSelect()).toHaveValue('enabled');
    expect(screen.queryByText('alpha-tool')).not.toBeInTheDocument();
  });

  it('keeps open categories open when a tool is toggled or saved elsewhere', async () => {
    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();

    act(() => triggerLibraryEvent(toggled('g', false)));
    act(() =>
      triggerLibraryEvent({ type: 'tool-saved', tool: { ...tools[0], description: 'Saved' } })
    );

    for (const label of ['Docs', 'Web', 'Integrations', 'Google']) {
      expect(treeItemOf(label)).toHaveAttribute('aria-expanded', 'true');
    }
    expect(screen.getByText('gmail-tool')).toBeInTheDocument();
    expect(within(treeItemOf('Google')!).getByTitle('0 of 1 enabled')).toHaveTextContent(/^0\/1$/);
  });

  it('drops a tool switched off elsewhere from the Enabled list and its counts', async () => {
    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await screen.findByText('Docs');
    await userEvent.selectOptions(filterSelect(), 'enabled');
    await expandAllCategories();

    act(() => triggerLibraryEvent(toggled('a', false)));

    expect(screen.queryByText('alpha-tool')).not.toBeInTheDocument();
    // Docs held only that enabled tool, so the category goes too.
    expect(screen.queryByText('Docs')).not.toBeInTheDocument();
    expect(screen.getByText('gmail-tool')).toBeInTheDocument();
    expect(within(headerOf()).getByTitle('1 enabled')).toHaveTextContent(/^1$/);
  });

  it('adds a tool switched off elsewhere to the Disabled list and its counts', async () => {
    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await screen.findByText('Docs');
    await userEvent.selectOptions(filterSelect(), 'disabled');
    await expandAllCategories();
    expect(screen.queryByText('alpha-tool')).not.toBeInTheDocument();

    act(() => triggerLibraryEvent(toggled('a', false)));

    expect(screen.getByText('alpha-tool')).toBeInTheDocument();
    expect(within(treeItemOf('Docs')!).getByTitle('2 disabled')).toHaveTextContent(/^2$/);
    expect(within(headerOf()).getByTitle('3 disabled')).toHaveTextContent(/^3$/);
  });

  it('forgets the expansion state older versions saved', async () => {
    window.localStorage.setItem(
      'snaglet.dashboard.toolOrganization.expanded.v1',
      JSON.stringify({ 'section:docs': true })
    );

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await screen.findByText('Docs');

    expect(treeItemOf('Docs')).toHaveAttribute('aria-expanded', 'false');
    expect(
      window.localStorage.getItem('snaglet.dashboard.toolOrganization.expanded.v1')
    ).toBeNull();
  });
});

describe('ToolsView catalog exposure', () => {
  beforeEach(() => {
    window.localStorage.clear();
    listMock.mockReset();
  });

  it('marks canonical core tools separately from discoverable on-demand tools', async () => {
    listMock.mockResolvedValue([
      makeTool({ id: 'doc', name: 'Get Doc', categoryPath: 'docs', tier: 'standard' }),
      makeTool({
        id: 'google_gmail',
        name: 'Gmail',
        categoryPath: 'docs',
        tier: 'core',
      }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();

    expect(await screen.findByText('Get Doc')).toBeInTheDocument();
    expect(screen.getByText('Gmail')).toBeInTheDocument();
    expect(screen.getByText('Core')).toHaveAttribute('title', 'Advertised to agents on every turn');
    expect(screen.getByText('On demand')).toHaveAttribute(
      'title',
      'Discovered by agents when needed'
    );
  });
});

describe('ToolsView narrow rows', () => {
  beforeEach(() => {
    window.localStorage.clear();
    listMock.mockReset();
  });

  const rowOf = (name: string) => screen.getByText(name).closest('[role="treeitem"]');

  it('leads the row tooltip with the full name, since the label can truncate', async () => {
    listMock.mockResolvedValue([
      makeTool({
        id: 'described',
        name: 'Test Tool With A Long Name',
        description: 'Does one thing.',
        categoryPath: 'docs',
      }),
      makeTool({ id: 'bare', name: 'Bare Tool', categoryPath: 'docs' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();

    await screen.findByText('Test Tool With A Long Name');
    expect(rowOf('Test Tool With A Long Name')).toHaveAttribute(
      'title',
      'Test Tool With A Long Name\nDoes one thing.'
    );
    expect(rowOf('Bare Tool')).toHaveAttribute('title', 'Bare Tool');
  });

  it('marks set-up and workspace rows so their extra chrome can step down', async () => {
    listMock.mockResolvedValue([
      makeTool({ id: 'plain', name: 'Plain Tool', categoryPath: 'docs' }),
      makeTool({
        id: 'needs_key',
        name: 'Keyed Tool',
        categoryPath: 'docs',
        availability: 'missing_credential',
      }),
      makeTool({
        id: 'switched_off',
        name: 'Switched Off Tool',
        categoryPath: 'docs',
        availability: 'integration_disabled',
      }),
      makeTool({
        id: 'custom',
        name: 'custom-tool',
        categoryPath: 'docs',
        source: 'workspace:custom-tool',
      }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();

    await screen.findByText('Plain Tool');
    expect(rowOf('Plain Tool')?.className).toMatch(/rowTool/);
    expect(rowOf('Plain Tool')?.className).not.toMatch(/rowNeedsSetup|rowWorkspace/);

    expect(rowOf('Keyed Tool')?.className).toMatch(/rowNeedsSetup/);
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect.className).toMatch(/setupChip/);
    expect(connect).toHaveAttribute('title', 'Connect');

    expect(rowOf('Switched Off Tool')?.className).toMatch(/rowNeedsSetup/);
    expect(screen.getByRole('button', { name: 'Integration off' })).toHaveAttribute(
      'title',
      'Integration off'
    );

    expect(rowOf('custom-tool')?.className).toMatch(/rowWorkspace/);
    expect(rowOf('custom-tool')?.className).not.toMatch(/rowNeedsSetup/);
  });
});

describe('ToolsView tool-builder entry points', () => {
  beforeEach(() => {
    window.localStorage.clear();
    listMock.mockReset();
  });

  it('always renders a "New tool" header affordance, regardless of the tool list', async () => {
    listMock.mockResolvedValue([]);
    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);

    expect(await screen.findByRole('button', { name: /new tool/i })).toBeInTheDocument();
  });

  it('shows the Edit affordance only for workspace-sourced tools, never builtin/mcp ones', async () => {
    listMock.mockResolvedValue([
      makeTool({ id: 'custom', name: 'custom-tool', source: 'workspace:custom-tool' }),
      makeTool({ id: 'native', name: 'native-tool', source: null, type: 'builtin' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();

    expect(await screen.findByText('custom-tool')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit custom-tool/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit native-tool/i })).not.toBeInTheDocument();
  });

  it('the row Edit pencil calls onToolEdit with that tool — no more create/edit modal', async () => {
    const tool = makeTool({ id: 'custom', name: 'custom-tool', source: 'workspace:custom-tool' });
    listMock.mockResolvedValue([tool]);
    const onToolEdit = vi.fn();
    const user = userEvent.setup();

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={onToolEdit} />);
    await expandAllCategories();
    await user.click(await screen.findByRole('button', { name: /edit custom-tool/i }));

    expect(onToolEdit).toHaveBeenCalledWith(tool);
    // No modal builder mounts from this view.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a plain row click calls onToolClick (view/run face), not onToolEdit', async () => {
    const tool = makeTool({ id: 'custom', name: 'custom-tool', source: 'workspace:custom-tool' });
    listMock.mockResolvedValue([tool]);
    const onToolClick = vi.fn();
    const onToolEdit = vi.fn();
    const user = userEvent.setup();

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={onToolClick} onToolEdit={onToolEdit} />);
    await expandAllCategories();
    await user.click(await screen.findByText('custom-tool'));

    expect(onToolClick).toHaveBeenCalledWith(tool);
    expect(onToolEdit).not.toHaveBeenCalled();
  });

  it('clicking "New tool" routes directly to the pane-hosted create builder', async () => {
    listMock.mockResolvedValue([]);
    const onToolCreate = vi.fn();
    const user = userEvent.setup();

    render(<ToolsView onToolCreate={onToolCreate} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /new tool/i }));

    expect(onToolCreate).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('dragging "New tool" exposes the pane-hosted create selection', async () => {
    listMock.mockResolvedValue([]);
    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    const setData = vi.fn();
    const dataTransfer = { setData, effectAllowed: 'none' };

    fireEvent.dragStart(await screen.findByRole('button', { name: /new tool/i }), {
      dataTransfer,
    });

    expect(setData).toHaveBeenCalledWith(PANE_ITEM_MIME, JSON.stringify({ kind: 'tool-create' }));
    expect(dataTransfer.effectAllowed).toBe('all');
  });

  it('a "tool-saved" event (fired when the pane-hosted builder saves) patches the matching row in place', async () => {
    const original = makeTool({
      id: 'custom',
      name: 'custom-tool',
      source: 'workspace:custom-tool',
      description: 'Old',
    });
    listMock.mockResolvedValue([original]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();
    await screen.findByText('custom-tool');

    const updated = { ...original, description: 'New description' };
    triggerLibraryEvent({ type: 'tool-saved', tool: updated });

    // Re-render reads the same name (immutable in edit mode) — the patch is
    // confirmed indirectly via the description now showing in the row title.
    expect(await screen.findByTitle(/New description/)).toBeInTheDocument();
  });

  it('a "tool-saved" event for a tool not in the list yet (Create tool) adds its row', async () => {
    listMock.mockResolvedValue([
      makeTool({ id: 'custom', name: 'custom-tool', source: 'workspace:custom-tool' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();
    await screen.findByText('custom-tool');

    act(() =>
      triggerLibraryEvent({
        type: 'tool-saved',
        tool: makeTool({ id: 'created', name: 'created-tool', source: 'workspace:created-tool' }),
      })
    );

    expect(await screen.findByText('created-tool')).toBeInTheDocument();
    expect(screen.getByText('custom-tool')).toBeInTheDocument();
  });
});

describe('ToolsView delete affordance', () => {
  beforeEach(() => {
    window.localStorage.clear();
    listMock.mockReset();
    deleteToolMock.mockReset();
    deleteWorkspaceMock.mockReset();
  });

  it('shows Delete only for workspace-sourced tools, never builtin/mcp ones', async () => {
    listMock.mockResolvedValue([
      makeTool({ id: 'custom', name: 'custom-tool', source: 'workspace:custom-tool' }),
      makeTool({ id: 'native', name: 'native-tool', source: null, type: 'builtin' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();

    expect(await screen.findByText('custom-tool')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete custom-tool/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete native-tool/i })).not.toBeInTheDocument();
  });

  it('clicking the trash button opens the in-app confirm dialog without deleting anything yet', async () => {
    // Regression guard for the Tauri silent-death bug: this flow must never
    // rely on a browser-native dialog.
    const nativeConfirm = vi.spyOn(window, 'confirm');
    listMock.mockResolvedValue([
      makeTool({ id: 'custom_tool', name: 'custom-tool', source: 'workspace:custom-tool' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();
    await userEvent.click(await screen.findByRole('button', { name: /delete custom-tool/i }));

    expect(screen.getByRole('dialog', { name: 'Delete "custom-tool"?' })).toBeInTheDocument();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(deleteWorkspaceMock).not.toHaveBeenCalled();
    expect(deleteToolMock).not.toHaveBeenCalled();
  });

  it('does nothing when the confirm dialog is declined', async () => {
    listMock.mockResolvedValue([
      makeTool({ id: 'custom_tool', name: 'custom-tool', source: 'workspace:custom-tool' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();
    await userEvent.click(await screen.findByRole('button', { name: /delete custom-tool/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deleteWorkspaceMock).not.toHaveBeenCalled();
    expect(deleteToolMock).not.toHaveBeenCalled();
    expect(screen.getByText('custom-tool')).toBeInTheDocument();
  });

  it('on confirm, deletes the workspace folder BEFORE the tool row, then drops it from the list', async () => {
    const callOrder: string[] = [];
    deleteWorkspaceMock.mockImplementation(async () => {
      callOrder.push('workspace');
    });
    deleteToolMock.mockImplementation(async () => {
      callOrder.push('tool');
    });
    listMock.mockResolvedValue([
      makeTool({ id: 'custom_tool', name: 'custom-tool', source: 'workspace:custom-tool' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();
    await userEvent.click(await screen.findByRole('button', { name: /delete custom-tool/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('custom-tool')).not.toBeInTheDocument());
    expect(deleteWorkspaceMock).toHaveBeenCalledWith('custom-tool');
    expect(deleteToolMock).toHaveBeenCalledWith('custom_tool');
    expect(callOrder).toEqual(['workspace', 'tool']);
  });

  it('a workspace-delete failure surfaces an error and never calls the row delete', async () => {
    deleteWorkspaceMock.mockRejectedValue(new Error('Workspace delete failed'));
    listMock.mockResolvedValue([
      makeTool({ id: 'custom_tool', name: 'custom-tool', source: 'workspace:custom-tool' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();
    await userEvent.click(await screen.findByRole('button', { name: /delete custom-tool/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/workspace delete failed/i)).toBeInTheDocument();
    expect(deleteToolMock).not.toHaveBeenCalled();
    expect(screen.getByText('custom-tool')).toBeInTheDocument();
  });

  it('the reverse: folder delete succeeds but row delete fails — row stays visible, error surfaced', async () => {
    // The degraded-but-safe half of the ordering contract: with the folder
    // already gone, the fs scanner will disable the surviving row on its next
    // pass, so the UI must NOT optimistically drop it — keep it visible and
    // report the failure instead.
    deleteWorkspaceMock.mockResolvedValue(null);
    deleteToolMock.mockRejectedValue(new Error('Row delete failed'));
    listMock.mockResolvedValue([
      makeTool({ id: 'custom_tool', name: 'custom-tool', source: 'workspace:custom-tool' }),
    ]);

    render(<ToolsView onToolCreate={vi.fn()} onToolClick={vi.fn()} onToolEdit={vi.fn()} />);
    await expandAllCategories();
    await userEvent.click(await screen.findByRole('button', { name: /delete custom-tool/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/row delete failed/i)).toBeInTheDocument();
    expect(deleteWorkspaceMock).toHaveBeenCalledWith('custom-tool');
    expect(deleteToolMock).toHaveBeenCalledWith('custom_tool');
    expect(screen.getByText('custom-tool')).toBeInTheDocument();
  });
});

it('native sidebar disclosure changes only existing sections/categories', async () => {
  localStorage.clear();
  listMock.mockResolvedValue([
    makeTool({ id: 'test-tool', name: 'Safe tool', categoryPath: 'workspace' }),
  ]);
  const open = vi.fn();
  const create = vi.fn();
  const edit = vi.fn();
  const view = render(<ToolsView onToolClick={open} onToolCreate={create} onToolEdit={edit} />);
  // Categories open collapsed, so wait on the category row, not the tool.
  await screen.findByText('Workspace');
  await checkSidebarDisclosures(view.container, 'tools');
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(edit).not.toHaveBeenCalled();
});
