import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  list: vi.fn(),
  hardDelete: vi.fn(),
  restore: vi.fn(),
  sweepAll: vi.fn(),
}));
const fieldApi = vi.hoisted(() => ({ restoreField: vi.fn(), purgeField: vi.fn() }));

vi.mock('@desktop/utils/api', () => ({ archiveApi: api, tablesApi: fieldApi }));
vi.mock('@desktop/utils/api/automations', () => ({
  automationsApi: { restore: vi.fn(), purge: vi.fn() },
}));
vi.mock('@desktop/features/automations/automationsStore', () => ({
  upsertAutomation: vi.fn(),
  loadAutomations: vi.fn(),
}));
vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn() }));
vi.mock('@desktop/utils/workspaceEvents.js', () => ({ emitLibraryEvent: vi.fn() }));

import { ArchivedDrawer } from './ArchivedDrawer';

const SHOW_A = 'container-1111111111111-aaaaaaaaa';
const SHOW_B = 'container-2222222222222-bbbbbbbbb';
const SEGMENTS_A = 'table-1111111111111-aaaaaaaaa';
const SEGMENTS_B = 'table-2222222222222-bbbbbbbbb';

function item(id: string, type: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type,
    title,
    archived: true,
    archived_at: '2026-07-06T00:00:00Z',
    container_id: null,
    project_id: null,
    sort_order: 0,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-06T00:00:00Z',
    ...extra,
  };
}

const showA = item(SHOW_A, 'container', 'Radio show A', { archived_at: '2026-07-02T00:00:00Z' });
const showB = item(SHOW_B, 'container', 'Radio show B', { archived_at: '2026-07-03T00:00:00Z' });
const segmentsA = item(SEGMENTS_A, 'table', 'segments', { container_id: SHOW_A });
const segmentsB = item(SEGMENTS_B, 'table', 'segments', { container_id: SHOW_B });
const episode = item('doc-1111111111111-aaaaaaaaa', 'doc', 'Episode notes', {
  container_id: SHOW_A,
});
const plan = item('doc-2222222222222-bbbbbbbbb', 'doc', 'Launch plan', {
  archived_at: '2026-07-09T00:00:00Z',
});
const agent = item('agent-retired', 'agent', 'Retired Bot', {
  archived_at: '2026-07-01T00:00:00Z',
});

const listing = {
  roots: [showA, showB, plan, agent],
  children: [segmentsA, episode, segmentsB],
};

function renderDrawer(onClose = vi.fn()) {
  render(<ArchivedDrawer open onClose={onClose} />);
  return onClose;
}

/** The listed row whose title is `title` (titles carry a `title` tooltip). */
function rowsTitled(title: string): HTMLElement[] {
  return screen
    .getAllByTitle(title)
    .map((label) => label.closest('li'))
    .filter((row): row is HTMLLIElement => row !== null);
}

const search = () => screen.getByRole('searchbox', { name: 'Search archived items' });

describe('ArchivedDrawer search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue(listing);
    api.restore.mockResolvedValue({ node: null, affected: 1 });
  });

  it('focuses the search box when the drawer opens', async () => {
    renderDrawer();
    await screen.findByTitle('Launch plan');
    await waitFor(() => expect(search()).toHaveFocus());
  });

  it('filters by name as you type, ignoring case, and announces the count', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('7 archived items'));

    await user.type(search(), 'LAUNCH');

    await waitFor(() => expect(screen.queryByTitle('Retired Bot')).toBeNull());
    expect(screen.getByTitle('Launch plan')).toBeInTheDocument();
    expect(screen.queryByTitle('Radio show A')).toBeNull();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 match'));
  });

  it('announces the count once typing pauses, not on every keystroke', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');
    const status = screen.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('7 archived items'));
    expect(status).not.toHaveAttribute('aria-live');

    await user.type(search(), 'LAUNCH');

    expect(screen.queryByTitle('Retired Bot')).toBeNull();
    expect(status).toHaveTextContent('7 archived items');
    await waitFor(() => expect(status).toHaveTextContent('1 match'));
  });

  it('lists a parent that matches, not everything inside it', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.type(search(), 'radio');

    await waitFor(() => expect(screen.queryByTitle('Launch plan')).toBeNull());
    expect(rowsTitled('Radio show A')[0]).toHaveTextContent('Restore');
    expect(rowsTitled('Radio show B')[0]).toHaveTextContent('Restore');
    expect(screen.queryAllByTitle('segments')).toHaveLength(0);
    expect(screen.queryByTitle('Episode notes')).toBeNull();
    // Each kind chip counts what it would list: the items inside, by their parent's name.
    expect(screen.getByRole('radio', { name: 'All 2' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Docs 1' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Tables 2' })).toBeInTheDocument();
  });

  it('with a kind chosen, lists the items of that kind inside a parent that matches', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.click(screen.getByRole('radio', { name: 'Docs 2' }));
    await user.type(search(), 'radio');

    await waitFor(() => expect(screen.queryByTitle('Launch plan')).toBeNull());
    expect(screen.getByRole('radio', { name: 'Docs 1' })).toBeChecked();
    expect(screen.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Radio show A'),
      expect.stringContaining('Episode notes'),
    ]);
    expect(rowsTitled('Radio show A')[0]).toHaveTextContent('1 match inside');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 match'));

    await user.click(screen.getByRole('radio', { name: 'Tables 2' }));
    expect(rowsTitled('segments')).toHaveLength(2);
    expect(screen.queryByTitle('Episode notes')).toBeNull();
  });

  it('highlights the matched text', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.type(search(), 'plan');

    const label = await screen.findByTitle('Launch plan');
    await waitFor(() => expect(label.querySelector('mark')).toHaveTextContent('plan'));
  });

  it('finds items through their archived parent and shows where each one came from', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.type(search(), 'radio segments');

    await waitFor(() => expect(screen.queryByTitle('Episode notes')).toBeNull());
    const matches = rowsTitled('segments');
    expect(matches).toHaveLength(2);
    expect(within(matches[0] as HTMLElement).getByTitle('in Radio show A')).toBeInTheDocument();
    expect(within(matches[1] as HTMLElement).getByTitle('in Radio show B')).toBeInTheDocument();
    expect(screen.queryByTitle('Launch plan')).toBeNull();
  });

  it('keeps a match’s ancestors as context rows without actions', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.type(search(), 'segments');

    await waitFor(() => expect(screen.queryByTitle('Launch plan')).toBeNull());
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Radio show A'),
      expect.stringContaining('segments'),
      expect.stringContaining('Radio show B'),
      expect.stringContaining('segments'),
    ]);
    const [context] = rowsTitled('Radio show A');
    expect(context).toHaveTextContent('1 match inside');
    expect(within(context as HTMLElement).queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(rows[1]).toHaveStyle({ paddingLeft: '28px' });
  });

  it('filters by kind and counts each kind for the current query', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');
    const kinds = screen.getByRole('radiogroup', { name: 'Filter by kind' });
    expect(within(kinds).getByRole('radio', { name: 'All 7' })).toBeChecked();
    expect(within(kinds).getByRole('radio', { name: 'Docs 2' })).toBeInTheDocument();
    expect(within(kinds).queryByRole('radio', { name: /Automations/ })).toBeNull();

    // Titled with an e: both segments tables, Episode notes, Retired Bot.
    await user.type(search(), 'e');
    await waitFor(() => expect(within(kinds).getByRole('radio', { name: 'All 4' })).toBeChecked());
    expect(within(kinds).getByRole('radio', { name: 'Docs 1' })).toBeInTheDocument();
    expect(within(kinds).getByRole('radio', { name: 'Tables 2' })).toBeInTheDocument();
    expect(within(kinds).getByRole('radio', { name: 'Folders & projects 0' })).toBeInTheDocument();

    await user.click(within(kinds).getByRole('radio', { name: 'Docs 1' }));
    expect(within(kinds).getByRole('radio', { name: 'Docs 1' })).toBeChecked();
    expect(screen.getByTitle('Episode notes')).toBeInTheDocument();
    expect(screen.queryAllByTitle('segments')).toHaveLength(0);
    expect(rowsTitled('Radio show A')[0]).toHaveTextContent('1 match inside');
  });

  it('moves between kinds with the arrow keys', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');
    const all = screen.getByRole('radio', { name: 'All 7' });
    all.focus();

    await user.keyboard('{ArrowRight}');

    const folders = screen.getByRole('radio', { name: 'Folders & projects 2' });
    expect(folders).toBeChecked();
    expect(folders).toHaveFocus();
    expect(screen.queryByTitle('Launch plan')).toBeNull();
  });

  it('says nothing matches and clears the search from there', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.type(search(), 'zzz');

    expect(await screen.findByText('No archived items match “zzz”.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search()).toHaveValue('');
    expect(await screen.findByTitle('Launch plan')).toBeInTheDocument();
    expect(search()).toHaveFocus();
  });

  it('clears the search on the first Escape and closes the drawer on the next', async () => {
    const user = userEvent.setup();
    const onClose = renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.type(search(), 'radio');
    await user.keyboard('{Escape}');
    expect(search()).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Archived items' })).toBeVisible();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears the search on Escape after a click leaves focus on the dialog itself', async () => {
    const user = userEvent.setup();
    const onClose = renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.type(search(), 'plan');
    await user.click(screen.getByTitle('Launch plan'));
    expect(search()).not.toHaveFocus();
    await user.keyboard('{Escape}');

    expect(search()).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears the search on Escape when focus has dropped to the page', async () => {
    const user = userEvent.setup();
    const onClose = renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.type(search(), 'plan');
    search().blur();
    expect(document.body).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(search()).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears the search on Escape from a result row too', async () => {
    const user = userEvent.setup();
    const onClose = renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.type(search(), 'plan');
    const row = rowsTitled('Launch plan')[0] as HTMLElement;
    within(row).getByRole('button', { name: 'Restore' }).focus();
    await user.keyboard('{Escape}');

    expect(search()).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('restores a filtered row and keeps the search after the list reloads', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');
    await user.type(search(), 'segments');
    await waitFor(() => expect(rowsTitled('segments')).toHaveLength(2));
    api.list.mockResolvedValue({
      roots: listing.roots,
      children: [segmentsA, episode],
    });

    const second = rowsTitled('segments')[1] as HTMLElement;
    await user.click(within(second).getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(api.restore).toHaveBeenCalledWith(SEGMENTS_B, {}));
    await waitFor(() => expect(rowsTitled('segments')).toHaveLength(1));
    expect(search()).toHaveValue('segments');
    expect(screen.queryByTitle('Radio show B')).toBeNull();
  });

  it('goes back to all kinds when the chosen kind’s last item leaves, and stays there', async () => {
    const lone = item('table-5555555555555-aaaaaaaaa', 'table', 'reading_list');
    api.list.mockResolvedValue({ roots: [plan, lone], children: [] });
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('reading_list');
    await user.click(screen.getByRole('radio', { name: 'Tables 1' }));
    expect(screen.queryByTitle('Launch plan')).toBeNull();

    api.list.mockResolvedValue({ roots: [plan], children: [] });
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByTitle('Launch plan')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All 1' })).toBeChecked();

    // The table comes back (say, archived again): the list stays on all kinds.
    api.list.mockResolvedValue({ roots: [plan, lone], children: [] });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByTitle('reading_list')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All 2' })).toBeChecked();
    expect(screen.getByTitle('Launch plan')).toBeInTheDocument();
  });

  it('lists the newest archived first when asked', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'newest');

    const roots = screen
      .getAllByRole('listitem')
      .filter((row) => row.style.paddingLeft === '12px')
      .map((row) => row.querySelector('[title]')?.getAttribute('title'));
    expect(roots).toEqual(['Launch plan', 'Radio show B', 'Radio show A', 'Retired Bot']);
  });
});

describe('ArchivedDrawer search for items in a live project', () => {
  const liveProjectTable = item('table-4444444444444-aaaaaaaaa', 'table', 'segments', {
    project_id: 'container-4444444444444-aaaaaaaaa',
    location: ['Morning show', 'planning'],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue({ roots: [liveProjectTable, plan], children: [] });
  });

  it('says where an archived table in a live project sits, even before searching', async () => {
    renderDrawer();
    await screen.findByTitle('segments');
    const [row] = rowsTitled('segments');
    expect(within(row as HTMLElement).getByTitle('in Morning show › planning')).toBeInTheDocument();
    expect(rowsTitled('Launch plan')[0]?.querySelector('[title^="in "]')).toBeNull();
  });

  it('finds it by searching the project’s name', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('Launch plan');

    await user.type(search(), 'morning');

    await waitFor(() => expect(screen.queryByTitle('Launch plan')).toBeNull());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 match'));
    const location = screen.getByTitle('in Morning show › planning');
    expect(location.querySelector('mark')).toHaveTextContent('Morning');
  });
});

describe('ArchivedDrawer search over a large archive', () => {
  const many = Array.from({ length: 3000 }, (_, i) =>
    item(`table-${String(i).padStart(13, '0')}-aaaaaaaaa`, 'table', `table ${i}`)
  );

  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue({ roots: many, children: [] });
  });

  it('renders a page of matches at a time and shows more on request', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByTitle('table 0');
    expect(screen.getAllByRole('listitem')).toHaveLength(200);

    await user.type(search(), 'table 1');

    // Every word must match: the 1,542 of 0…2999 that hold a 1.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1542 matches'));
    expect(screen.getAllByRole('listitem')).toHaveLength(200);
    expect(screen.getByText('Showing 200 of 1542')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(400);

    // A new query starts again from one page.
    await user.clear(search());
    await user.type(search(), 'table 2');
    await waitFor(() => expect(screen.getByText('Showing 200 of 1542')).toBeInTheDocument());
    expect(screen.getAllByRole('listitem')).toHaveLength(200);
    // 3,000 rows and typed input: slow machines need more than the 5-second default.
  }, 30_000);
});
