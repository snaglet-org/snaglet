/**
 * HubView (the Home pane) with its data hooks mocked: each section renders
 * its items, empty state, loading and error states, and its actions reach
 * the hooks (name, pins, instructions) or open in the pane. The header has
 * no picture; the recent lists (threads, docs) scroll inside named,
 * focusable areas; there is no recent tables list.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { indexTree, type PinRecord } from './hubModel';
import type {
  HubInstructionsState,
  HubPinsState,
  HubProfileState,
  HubTablesState,
  HubTreeState,
  ThreadDetails,
} from './useHubData';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const hooks = vi.hoisted(() => ({
  profile: null as unknown as HubProfileState,
  tree: null as unknown as HubTreeState,
  pins: null as unknown as HubPinsState,
  tables: null as unknown as HubTablesState,
  details: new Map<string, ThreadDetails>(),
  instructions: null as unknown as HubInstructionsState,
}));

vi.mock('./useHubData', () => ({
  useHubProfile: () => hooks.profile,
  useHubTree: () => hooks.tree,
  useHubPins: () => hooks.pins,
  useHubTables: () => hooks.tables,
  useThreadDetails: () => hooks.details,
  useGlobalInstructions: () => hooks.instructions,
}));

const api = vi.hoisted(() => ({ createDoc: vi.fn(), createThread: vi.fn() }));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    docsApi: { ...actual.docsApi, create: api.createDoc },
    threadsApi: { ...actual.threadsApi, createInProjectWithAgents: api.createThread },
  };
});

// The agent picker is its own tested component; a stand-in confirms one agent.
vi.mock('@desktop/features/workspace-tree/ThreadAgentPickerModal', async () => {
  const { createElement } = await import('react');
  return {
    ThreadAgentPickerModal: ({ onCreate }: { onCreate: (ids: string[]) => Promise<void> }) =>
      createElement('button', { onClick: () => void onCreate(['agent-1']) }, 'Create with Venus'),
  };
});

import { HubView } from './HubView';

const T0 = '2026-11-16T10:00:00.000Z';

const tree: LibraryTreeChild[] = [
  {
    kind: 'container',
    id: 'project-1',
    parentId: null,
    name: 'Snaglet',
    sortOrder: 0,
    createdAt: T0,
    updatedAt: T0,
    category: 'project',
    folderPath: null,
    githubUrl: null,
    children: [
      {
        kind: 'thread',
        id: 'thread-1',
        projectId: 'project-1',
        title: 'Release checklist',
        sortOrder: 0,
        lastMessageAt: '2026-11-16T09:00:00.000Z',
        createdAt: T0,
        updatedAt: T0,
      },
      {
        kind: 'container',
        id: 'folder-1',
        parentId: 'project-1',
        name: 'Design',
        sortOrder: 0,
        createdAt: T0,
        updatedAt: T0,
        category: null,
        folderPath: null,
        githubUrl: null,
        children: [
          {
            kind: 'doc',
            id: 'doc-1',
            containerId: 'folder-1',
            title: 'Home notes',
            content: '',
            sortOrder: 0,
            createdAt: T0,
            updatedAt: '2026-11-16T08:00:00.000Z',
          },
        ],
      },
    ],
  },
  {
    kind: 'thread',
    id: 'thread-2',
    projectId: null,
    title: 'Garden plan',
    sortOrder: 1,
    lastMessageAt: null,
    createdAt: T0,
    updatedAt: '2026-11-15T00:00:00.000Z',
  },
];

const table: TableCatalogEntry = {
  id: 'table-1',
  name: 'Release queue',
  origin: 'custom',
  projectId: 'project-1',
  sortOrder: 0,
  createdAt: T0,
} as TableCatalogEntry;

/** A built-in system table: Home never offers it, but shows it if pinned. */
const builtinTable: TableCatalogEntry = {
  ...table,
  id: 'table-builtin-agents',
  name: 'Agents',
  origin: 'builtin',
  projectId: null,
};

function pinsState(records: PinRecord[]): HubPinsState {
  return {
    status: 'ready',
    error: null,
    pins: records,
    isPinned: (kind, id) => records.some((p) => p.kind === kind && p.id === id),
    pin: vi.fn(async () => undefined),
    unpin: vi.fn(async () => undefined),
    reload: vi.fn(),
  };
}

const onReplaceSelection = vi.fn();

function renderHub() {
  return render(<HubView onReplaceSelection={onReplaceSelection} />);
}

function section(name: string) {
  return screen.getByRole('region', { name });
}

beforeEach(() => {
  hooks.profile = {
    status: 'ready',
    profile: {
      id: 'user-1',
      name: 'Robin',
      email: 'g@example.com',
      picture: null,
      active: true,
      createdAt: T0,
      updatedAt: T0,
    },
    error: null,
    saveName: vi.fn(async () => undefined),
  };
  hooks.tree = { status: 'ready', index: indexTree(tree), error: null, reload: vi.fn() };
  hooks.pins = pinsState([]);
  hooks.tables = { status: 'ready', tables: [table], error: null, reload: vi.fn() };
  hooks.details = new Map([
    [
      'thread-1',
      {
        status: 'ready',
        agents: [{ id: 'agent-1', name: 'Venus' }],
        snippet: { sender: 'Venus', text: 'Signed build is up.' },
      },
    ],
    ['thread-2', { status: 'ready', agents: [], snippet: null }],
  ]);
  hooks.instructions = {
    status: 'ready',
    saved: 'Keep replies short.',
    error: null,
    save: vi.fn(async () => undefined),
  };
  onReplaceSelection.mockReset();
  api.createDoc.mockReset();
  api.createThread.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('Home header', () => {
  it('greets the user by name, with the date and no picture', () => {
    const view = renderHub();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      /^Good (morning|afternoon|evening), Robin$/
    );
    expect(view.container.querySelector('img')).toBeNull();
  });

  it('saves a new name on Enter', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(screen.getByRole('button', { name: 'Robin, change your name' }));
    const input = screen.getByRole('textbox', { name: 'Your name' });
    await user.clear(input);
    await user.type(input, 'Grace{Enter}');
    expect(hooks.profile.saveName).toHaveBeenCalledWith('Grace');
  });

  it('cancels on Escape without saving', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(screen.getByRole('button', { name: 'Robin, change your name' }));
    await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'xyz{Escape}');
    expect(hooks.profile.saveName).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Your name' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Robin, change your name' })).toBeInTheDocument();
  });

  it('keeps editing and says why when the name is refused', async () => {
    const user = userEvent.setup();
    vi.mocked(hooks.profile.saveName).mockRejectedValueOnce(
      new Error('A user with that name already exists')
    );
    renderHub();
    await user.click(screen.getByRole('button', { name: 'Robin, change your name' }));
    const input = screen.getByRole('textbox', { name: 'Your name' });
    await user.clear(input);
    await user.type(input, 'Bob{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A user with that name already exists'
    );
    expect(screen.getByRole('textbox', { name: 'Your name' })).toBeInTheDocument();
  });
});

describe('Home pinned', () => {
  beforeEach(() => {
    hooks.pins = pinsState([
      { kind: 'project', id: 'project-1', title: 'Snaglet', pinnedAt: '1' },
      { kind: 'doc', id: 'doc-1', title: 'Old name', pinnedAt: '2' },
      { kind: 'table', id: 'table-1', title: 'Release queue', pinnedAt: '3' },
      { kind: 'doc', id: 'doc-gone', title: 'Old roadmap', pinnedAt: '4' },
    ]);
  });

  it('shows pinned chips by their live names, kind and project, and gone ones as not found', () => {
    renderHub();
    const pinned = section('Pinned');
    expect(within(pinned).getByRole('button', { name: 'Home notes · Doc · Design' })).toBeEnabled();
    expect(
      within(pinned).getByRole('button', { name: 'Release queue · Table · Snaglet' })
    ).toBeEnabled();
    expect(
      within(pinned).getByRole('button', { name: 'Old roadmap, not found (archived or deleted)' })
    ).toBeDisabled();
  });

  it('opens a pinned item in the pane', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(
      within(section('Pinned')).getByRole('button', { name: 'Release queue · Table · Snaglet' })
    );
    expect(onReplaceSelection).toHaveBeenCalledWith({
      kind: 'table',
      table_id: 'table-1',
      table,
    });
  });

  it('unpins from the chip', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(screen.getByRole('button', { name: 'Unpin Snaglet' }));
    expect(hooks.pins.unpin).toHaveBeenCalledWith('project', 'project-1');
  });

  it('pins from the + chip’s picker', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(within(section('Pinned')).getByRole('button', { name: 'Pin something' }));
    const picker = await screen.findByRole('dialog', { name: 'Pin to Home' });
    await user.type(within(picker).getByRole('textbox'), 'garden');
    await user.click(within(picker).getByRole('button', { name: /Garden plan/ }));
    expect(hooks.pins.pin).toHaveBeenCalledWith({
      kind: 'thread',
      id: 'thread-2',
      title: 'Garden plan',
    });
    expect(screen.queryByRole('dialog', { name: 'Pin to Home' })).toBeNull();
  });

  it('closes the picker on Escape without pinning', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(within(section('Pinned')).getByRole('button', { name: 'Pin something' }));
    await screen.findByRole('dialog', { name: 'Pin to Home' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Pin to Home' })).toBeNull();
    expect(hooks.pins.pin).not.toHaveBeenCalled();
  });

  it('offers the user’s tables in the picker, never built-in ones', async () => {
    hooks.tables = {
      status: 'ready',
      tables: [table, builtinTable, { ...table, id: 'table-2', name: 'Budget', projectId: null }],
      error: null,
      reload: vi.fn(),
    };
    const user = userEvent.setup();
    renderHub();
    await user.click(within(section('Pinned')).getByRole('button', { name: 'Pin something' }));
    const picker = await screen.findByRole('dialog', { name: 'Pin to Home' });
    const tables = within(picker).getByRole('group', { name: 'Tables' });
    expect(within(tables).getByRole('button', { name: /Budget/ })).toBeEnabled();
    expect(within(tables).getByRole('button', { name: /Release queue/ })).toBeDisabled();
    expect(within(picker).queryByRole('button', { name: /^Agents/ })).toBeNull();
  });

  it('still shows a built-in table pinned earlier as a chip that opens it', async () => {
    hooks.pins = pinsState([
      { kind: 'table', id: builtinTable.id, title: 'Agents', pinnedAt: '1' },
    ]);
    hooks.tables = { status: 'ready', tables: [table, builtinTable], error: null, reload: vi.fn() };
    const user = userEvent.setup();
    renderHub();
    await user.click(within(section('Pinned')).getByRole('button', { name: 'Agents · Table' }));
    expect(onReplaceSelection).toHaveBeenCalledWith({
      kind: 'table',
      table_id: builtinTable.id,
      table: builtinTable,
    });
  });

  it('says nothing is pinned yet and offers the picker', async () => {
    hooks.pins = pinsState([]);
    renderHub();
    const pinned = section('Pinned');
    expect(within(pinned).getByText(/Nothing pinned yet/)).toBeInTheDocument();
    expect(within(pinned).getByRole('button', { name: 'Pin something' })).toBeInTheDocument();
  });

  it('shows a load error with Try again', async () => {
    hooks.pins = { ...pinsState([]), status: 'error', error: 'Could not load your pins' };
    const user = userEvent.setup();
    renderHub();
    const pinned = section('Pinned');
    expect(within(pinned).getByRole('alert')).toHaveTextContent('Could not load your pins');
    await user.click(within(pinned).getByRole('button', { name: 'Try again' }));
    expect(hooks.pins.reload).toHaveBeenCalled();
  });
});

describe('Home recent threads', () => {
  it('lists threads newest first in a named scroll area, with their last message', () => {
    renderHub();
    expect(screen.queryByRole('region', { name: 'Recent tables' })).toBeNull();
    const threads = section('Recent threads');
    const scroller = within(threads).getByRole('group', { name: 'Recent threads, scrollable' });
    expect(scroller).toHaveAttribute('tabindex', '0');
    const rows = within(scroller).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Release checklist');
    expect(rows[0]).toHaveTextContent('Venus: Signed build is up.');
    expect(rows[1]).toHaveTextContent('Garden plan');
    expect(rows[1]).toHaveTextContent('No messages yet');
  });

  it('opens a thread in the pane', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(
      within(section('Recent threads')).getByRole('button', { name: /^Garden plan/ })
    );
    expect(onReplaceSelection).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'thread', thread_id: 'thread-2' })
    );
  });

  it('pins and unpins from the row', async () => {
    hooks.pins = pinsState([{ kind: 'thread', id: 'thread-2', pinnedAt: '1' }]);
    const user = userEvent.setup();
    renderHub();
    await user.click(screen.getByRole('button', { name: 'Pin Release checklist' }));
    expect(hooks.pins.pin).toHaveBeenCalledWith({
      kind: 'thread',
      id: 'thread-1',
      title: 'Release checklist',
    });
    const unpin = within(section('Recent threads')).getByRole('button', {
      name: 'Unpin Garden plan',
    });
    expect(unpin).toHaveAttribute('aria-pressed', 'true');
    await user.click(unpin);
    expect(hooks.pins.unpin).toHaveBeenCalledWith('thread', 'thread-2');
  });

  it('starts a thread from the empty state and opens it', async () => {
    hooks.tree = { ...hooks.tree, index: indexTree([]) };
    api.createThread.mockResolvedValue({
      thread: { id: 'thread-new', title: 'New thread', createdAt: T0, updatedAt: T0 },
      failedAgentIds: [],
    });
    const user = userEvent.setup();
    renderHub();
    const threads = section('Recent threads');
    expect(within(threads).getByText(/No threads yet/)).toBeInTheDocument();
    await user.click(within(threads).getByRole('button', { name: 'New thread' }));
    await user.click(screen.getByRole('button', { name: 'Create with Venus' }));
    expect(api.createThread).toHaveBeenCalledWith('New thread', null, ['agent-1']);
    await waitFor(() =>
      expect(onReplaceSelection).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'thread', thread_id: 'thread-new' })
      )
    );
  });

  it('says it is loading, then why a load failed', () => {
    hooks.tree = { status: 'loading', index: null, error: null, reload: vi.fn() };
    const view = renderHub();
    expect(within(section('Recent threads')).getByText('Loading…')).toBeInTheDocument();

    hooks.tree = { status: 'error', index: null, error: 'Server is down', reload: vi.fn() };
    view.rerender(<HubView onReplaceSelection={onReplaceSelection} />);
    const threads = section('Recent threads');
    expect(within(threads).getByRole('alert')).toHaveTextContent('Server is down');
    fireEvent.click(within(threads).getByRole('button', { name: 'Try again' }));
    expect(hooks.tree.reload).toHaveBeenCalled();
  });
});

describe('Home recently edited docs', () => {
  it('lists docs with their folder path and opens one in the pane', async () => {
    const user = userEvent.setup();
    renderHub();
    const docs = section('Recently edited docs');
    expect(within(docs).getByText('Snaglet / Design')).toBeInTheDocument();
    await user.click(within(docs).getByRole('button', { name: /^Home notes/ }));
    expect(onReplaceSelection).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'doc', doc_id: 'doc-1' })
    );
  });

  it('creates a doc from the empty state and opens it', async () => {
    hooks.tree = { ...hooks.tree, index: indexTree([]) };
    api.createDoc.mockResolvedValue({
      id: 'doc-new',
      containerId: null,
      title: 'Untitled doc',
      content: '',
      sortOrder: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    const user = userEvent.setup();
    renderHub();
    const docs = section('Recently edited docs');
    expect(within(docs).getByText(/No docs yet/)).toBeInTheDocument();
    await user.click(within(docs).getByRole('button', { name: 'New doc' }));
    expect(api.createDoc).toHaveBeenCalledWith({ title: 'Untitled doc', containerId: null });
    await waitFor(() =>
      expect(onReplaceSelection).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'doc', doc_id: 'doc-new' })
      )
    );
  });
});

describe('Home instructions for all agents', () => {
  it('shows a preview of the saved text and its length', () => {
    renderHub();
    const card = section('Instructions for all agents');
    expect(within(card).getByText('Keep replies short.')).toBeInTheDocument();
    expect(within(card).getByText('19 / 8000')).toBeInTheDocument();
    expect(within(card).getByText('Applies to every agent')).toBeInTheDocument();
  });

  it('prompts for instructions when there are none', () => {
    hooks.instructions = { ...hooks.instructions, saved: '' };
    renderHub();
    expect(
      within(section('Instructions for all agents')).getByText(/Nothing yet/)
    ).toBeInTheDocument();
  });

  it('edits in a floating editor: Save saves and says so', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(
      within(section('Instructions for all agents')).getByRole('button', { name: 'Edit' })
    );
    const editor = await screen.findByRole('dialog', {
      name: 'Edit instructions for all agents',
    });
    const textbox = within(editor).getByRole('textbox');
    expect(textbox).toHaveValue('Keep replies short.');
    expect(within(editor).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(textbox, ' Ask first.');
    expect(within(editor).getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(within(editor).getByRole('button', { name: 'Save' }));
    expect(hooks.instructions.save).toHaveBeenCalledWith('Keep replies short. Ask first.');
    expect(await within(editor).findByText('Saved')).toBeInTheDocument();
  });

  it('saves with Cmd+S', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(
      within(section('Instructions for all agents')).getByRole('button', { name: 'Edit' })
    );
    const editor = await screen.findByRole('dialog', {
      name: 'Edit instructions for all agents',
    });
    const textbox = within(editor).getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'Use metric units.' } });
    fireEvent.keyDown(textbox, { key: 's', metaKey: true });
    expect(hooks.instructions.save).toHaveBeenCalledWith('Use metric units.');
  });

  it('closes on Escape without saving', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(
      within(section('Instructions for all agents')).getByRole('button', { name: 'Edit' })
    );
    const editor = await screen.findByRole('dialog', {
      name: 'Edit instructions for all agents',
    });
    await user.type(within(editor).getByRole('textbox'), ' draft');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Edit instructions for all agents' })).toBeNull();
    expect(hooks.instructions.save).not.toHaveBeenCalled();
  });
});

describe('Home workspace row', () => {
  it('opens the settings that keep their own panes, including the account pane', async () => {
    const user = userEvent.setup();
    renderHub();
    const nav = screen.getByRole('navigation', { name: 'Workspace settings' });
    await user.click(within(nav).getByRole('button', { name: /Providers/ }));
    expect(onReplaceSelection).toHaveBeenLastCalledWith({ kind: 'providers' });
    const account = within(nav).getByRole('button', { name: /Account and users/ });
    expect(account).toHaveAttribute('title', expect.stringContaining('which user you act as'));
    await user.click(account);
    expect(onReplaceSelection).toHaveBeenLastCalledWith({ kind: 'profile', account: true });
  });

  it('holds links only: no Open Home on launch option', () => {
    renderHub();
    expect(screen.queryByRole('button', { name: /Open Home on launch/ })).toBeNull();
    expect(screen.queryByText(/Open Home on launch/)).toBeNull();
  });
});
