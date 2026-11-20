/**
 * The palette must never blank the app over a node kind outside the model
 * (task, project, comment, …): the footer's prefix chips read only entries
 * present in PREFIX_FILTER_META, and a result of an unknown kind falls back
 * to a neutral icon, label and tone. The hook is mocked to drive exact result
 * shapes (including an unknown kind) without a server.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The palette imports the real API barrel, whose config module throws at import
// time if these are unset. Stub them in a hoisted block so they exist before
// the static import below runs (tests never make real requests here).
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: () => false,
}));

import { CommandPalette } from './CommandPalette';
import { toolsApi, type PaletteFileNodeItem } from '@desktop/utils/api';
import {
  entryHitToNode,
  labelOf,
  serverHitToNode,
  toSearchResult,
  type SearchResult,
  type SearchSection,
} from './paletteResultMappers';

// Stable fn identities — the palette's search effect depends on `search`, so a
// fresh identity every render would loop. `sections` is reassigned per test.
const hookState = vi.hoisted(() => ({
  sections: [] as SearchSection[],
  fileResults: [] as PaletteFileNodeItem[],
  executionPlan: null as Record<string, unknown> | null,
  coverage: {} as Record<string, string>,
  search: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('./useQuickSearch.js', () => ({
  useQuickSearch: () => ({
    results: hookState.sections.flatMap((section) => section.results),
    sections: hookState.sections,
    fileResults: hookState.fileResults,
    filesystemResults: [],
    loading: false,
    lexicalLoading: false,
    serverLoading: false,
    semanticStatus: 'ready',
    semanticStatusReason: null,
    coverage: hookState.coverage,
    executionPlan: hookState.executionPlan,
    search: hookState.search,
    invalidate: hookState.invalidate,
  }),
  hydrateSearchResultNode: vi.fn(async (hit: SearchResult) => hit.node),
}));

beforeEach(() => {
  hookState.sections = [];
  hookState.fileResults = [];
  hookState.executionPlan = null;
  hookState.coverage = {};
  hookState.search.mockClear();
  hookState.invalidate.mockClear();
});

function renderPalette() {
  return render(
    <CommandPalette
      open
      onClose={vi.fn()}
      onSelect={vi.fn()}
      onOpenThreadAgent={vi.fn()}
      onOpenThreadWithFocusMessage={vi.fn()}
      onOpenTool={vi.fn()}
      onOpenAgent={vi.fn()}
      onOpenFile={vi.fn()}
    />
  );
}

// A result whose kind is not in the node model. Cast through `unknown`
// because that kind is deliberately outside the union.
const deletedKindResult = {
  node: {
    kind: 'task',
    id: 'task-legacy-1',
    title: 'Legacy task node',
    payload: {},
    createdAt: null,
    updatedAt: null,
  },
  label: 'Legacy task node',
  kindLabel: 'task',
  origin: 'server',
  channels: [],
  createdAt: null,
  updatedAt: null,
} as unknown as SearchResult;

describe('CommandPalette render safety', () => {
  it('opens without crashing and renders no `project:` prefix chip', () => {
    renderPalette();

    // The footer renders unconditionally on open, so a prefix chip that reads
    // a missing PREFIX_FILTER_META entry would throw here.
    expect(screen.getByRole('dialog', { name: 'Quick search' })).toBeInTheDocument();
    expect(screen.getByText('agent:')).toBeInTheDocument();
    expect(screen.getByText('file:')).toBeInTheDocument();
    expect(screen.queryByText('project:')).toBeNull();
  });

  it('activates the file filter from the footer chip', async () => {
    const user = userEvent.setup();
    renderPalette();

    hookState.search.mockClear();
    await user.click(screen.getByText('file:'));

    expect(screen.getByText('File')).toBeInTheDocument();
    expect(hookState.search).toHaveBeenLastCalledWith(
      '',
      null,
      'file',
      { keyword: true, vector: true },
      null
    );
  });

  it('activates the canonical image filter from the footer chip', async () => {
    const user = userEvent.setup();
    renderPalette();

    hookState.search.mockClear();
    await user.click(screen.getByText('image:'));

    expect(screen.getByText('Image')).toBeInTheDocument();
    expect(hookState.search).toHaveBeenLastCalledWith(
      '',
      ['image'],
      null,
      { keyword: true, vector: true },
      null
    );
  });

  it('passes the selected search channels to the query hook', async () => {
    const user = userEvent.setup();
    renderPalette();

    hookState.search.mockClear();
    await user.click(screen.getByRole('checkbox', { name: 'Vector' }));

    expect(hookState.search).toHaveBeenLastCalledWith(
      '',
      null,
      null,
      { keyword: true, vector: false },
      null
    );
  });

  it('renders a result with an unknown/deleted kind via a neutral fallback', async () => {
    hookState.sections = [
      {
        id: 'server-task',
        label: 'Tasks',
        origin: 'server',
        results: [deletedKindResult],
      } as unknown as SearchSection,
    ];
    const user = userEvent.setup();
    renderPalette();

    // Results only render once there's a query — type to flip `hasQuery`.
    await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'legacy');

    // The unknown-kind row renders (label + fallback badge) instead of throwing.
    expect(screen.getByText('Legacy task node')).toBeInTheDocument();
    expect(screen.getByText('task')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Quick search' })).toBeInTheDocument();
  });
});

describe('Database tables in the palette', () => {
  const TABLE_ID = 'table-1111111111111-aaaaaaaaa';

  it('narrows to tables with `table:` and opens a table hit by catalog id', async () => {
    hookState.sections = [
      {
        id: 'server-table',
        label: 'Tables',
        origin: 'server',
        results: [
          toSearchResult(
            serverHitToNode({
              node_id: TABLE_ID,
              kind: 'table',
              score: 1,
              channels: ['fts'],
              payload: { name: 'Reading list', title: 'Reading list' },
            }),
            'server',
            ['fts']
          ),
        ],
      },
    ];
    const onSelect = vi.fn();
    const onOpenTable = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        onSelect={onSelect}
        onOpenThreadAgent={vi.fn()}
        onOpenThreadWithFocusMessage={vi.fn()}
        onOpenTool={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenTable={onOpenTable}
        onOpenFile={vi.fn()}
      />
    );
    expect(screen.getByText('table:')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'table:reading');
    expect(screen.getByRole('textbox', { name: 'Quick search' })).toHaveValue('reading');
    expect(hookState.search).toHaveBeenLastCalledWith(
      'reading',
      ['table'],
      null,
      { keyword: true, vector: true },
      null
    );

    await user.click(screen.getByText('Reading list'));
    await waitFor(() => expect(onOpenTable).toHaveBeenCalledWith(TABLE_ID, undefined));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('table entries in the palette', () => {
  const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
  const ENTRY_ID = '00000000-0000-4000-8000-000000000001';
  const CHANNELS = { keyword: true, vector: true };

  function renderWithEntries(onOpenEntry = vi.fn()) {
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onOpenThreadAgent={vi.fn()}
        onOpenThreadWithFocusMessage={vi.fn()}
        onOpenTool={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenEntry={onOpenEntry}
        onOpenFile={vi.fn()}
      />
    );
    return { onOpenEntry, input: screen.getByRole('textbox', { name: 'Quick search' }) };
  }

  function withEntryResult() {
    hookState.sections = [
      {
        id: 'server-entry',
        label: 'Entries',
        origin: 'server',
        results: [
          toSearchResult(
            entryHitToNode({
              tableId: TABLE_ID,
              tableName: 'item_list',
              projectId: null,
              entryId: ENTRY_ID,
              name: 'Orchid plan',
              score: 0.9,
              createdAt: '2026-01-01T00:00:00.000Z',
            }),
            'server',
            ['fts']
          ),
        ],
      },
    ];
  }

  it('turns entry: into an Entry chip with its own placeholder', async () => {
    const user = userEvent.setup();
    const { input } = renderWithEntries();
    expect(screen.getByText('entry:')).toBeInTheDocument();

    await user.type(input, 'entry: orchid');

    expect(input).toHaveValue('orchid');
    expect(screen.getByRole('button', { name: 'Remove Entry filter' })).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'Search entries…');
    expect(hookState.search).toHaveBeenLastCalledWith('orchid', null, null, CHANNELS, {
      table: null,
    });
  });

  it('activates the entry filter from the footer chip', async () => {
    const user = userEvent.setup();
    const { input } = renderWithEntries();

    await user.click(screen.getByText('entry:'));

    expect(screen.getByText('Entry')).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'Search entries…');
    expect(hookState.search).toHaveBeenLastCalledWith('', null, null, CHANNELS, { table: null });
  });

  it('keeps entries to one table with table:<name> entry:, quoted or after a Table chip', async () => {
    const user = userEvent.setup();
    const { input } = renderWithEntries();

    // Typed in one go: the Table chip appears at `table:`, then
    // `"Item list" entry:` turns both into the entry filter for that table.
    await user.type(input, 'table:"Item list" entry: orchid');

    expect(input).toHaveValue('orchid');
    expect(screen.getByText('Item list')).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'Search entries in Item list…');
    expect(screen.queryByRole('button', { name: 'Remove Table filter' })).toBeNull();
    expect(hookState.search).toHaveBeenLastCalledWith('orchid', null, null, CHANNELS, {
      table: 'Item list',
    });

    // Backspace on an empty input drops the table first, then the filter.
    await user.clear(input);
    await user.keyboard('{Backspace}');
    expect(screen.queryByText('Item list')).toBeNull();
    expect(hookState.search).toHaveBeenLastCalledWith('', null, null, CHANNELS, { table: null });
    await user.keyboard('{Backspace}');
    expect(screen.queryByRole('button', { name: 'Remove Entry filter' })).toBeNull();
    expect(hookState.search).toHaveBeenLastCalledWith('', null, null, CHANNELS, null);
  });

  it('reads a pasted table:<name> entry: query whole', async () => {
    const user = userEvent.setup();
    const { input } = renderWithEntries();

    await user.click(input);
    await user.paste('table:item_list entry: orchid');

    expect(input).toHaveValue('orchid');
    expect(hookState.search).toHaveBeenLastCalledWith('orchid', null, null, CHANNELS, {
      table: 'item_list',
    });
  });

  it('labels a row with its table and opens its window', async () => {
    withEntryResult();
    const user = userEvent.setup();
    const { input, onOpenEntry } = renderWithEntries();

    await user.type(input, 'orchid');
    expect(screen.getByText('Orchid plan · item_list')).toBeInTheDocument();
    expect(screen.getByText('Entry', { selector: 'span' })).toBeInTheDocument();
    // The secondary open is offered once a row is listed.
    expect(screen.getByText('show row in table')).toBeInTheDocument();

    await user.click(screen.getByText('Orchid plan · item_list'));
    await waitFor(() => expect(onOpenEntry).toHaveBeenCalledWith(TABLE_ID, ENTRY_ID, 'window'));
  });

  it('opens a row highlighted in its table on ⌘/Ctrl-click and ⌘/Ctrl+Enter', async () => {
    withEntryResult();
    const user = userEvent.setup();
    const { input, onOpenEntry } = renderWithEntries();
    await user.type(input, 'orchid');

    fireEvent.mouseDown(screen.getByText('Orchid plan · item_list'), { button: 0, metaKey: true });
    await waitFor(() =>
      expect(onOpenEntry).toHaveBeenLastCalledWith(TABLE_ID, ENTRY_ID, 'highlight')
    );

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onOpenEntry).toHaveBeenCalledTimes(2));
    expect(onOpenEntry).toHaveBeenLastCalledWith(TABLE_ID, ENTRY_ID, 'highlight');
  });

  it('opens a strong match listed above other kinds the same way, by arrow keys and Enter', async () => {
    withEntryResult();
    const docs: SearchSection = {
      id: 'server-doc',
      label: 'Docs',
      origin: 'server',
      results: [
        toSearchResult(
          serverHitToNode({
            node_id: 'doc-1111111111111-aaaaaaaaa',
            kind: 'doc',
            score: 0.9,
            channels: ['fts'],
            payload: { title: 'Orchid notes', containerId: null, sortOrder: 0 },
          }),
          'server',
          ['fts']
        ),
      ],
    };
    const threads: SearchSection = {
      id: 'server-thread',
      label: 'Threads',
      origin: 'server',
      results: [
        toSearchResult(
          serverHitToNode({
            node_id: 'thread-1111111111111-aaaaaaaaa',
            kind: 'thread',
            score: 0.9,
            channels: ['fts'],
            payload: { title: 'Orchid chat', projectId: null, sortOrder: 0 },
          }),
          'server',
          ['fts']
        ),
      ],
    };
    hookState.sections = [docs, hookState.sections[0]!, threads];
    const user = userEvent.setup();
    const { input, onOpenEntry } = renderWithEntries();
    await user.type(input, 'orchid');

    const row = screen.getByText('Orchid plan · item_list').closest('[role="option"]');
    expect(row).toHaveAttribute('data-result-index', '1');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(row).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onOpenEntry).toHaveBeenCalledWith(TABLE_ID, ENTRY_ID, 'highlight'));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onOpenEntry).toHaveBeenLastCalledWith(TABLE_ID, ENTRY_ID, 'window'));
  });
});

describe('paletteResultMappers degrade gracefully on deleted kinds', () => {
  it('labelOf returns a best-effort label for a deleted kind', () => {
    const node = { kind: 'project', id: 'project-1', name: 'Old project' } as never;
    expect(labelOf(node)).toBe('Old project');
  });

  it('serverHitToNode maps an unknown kind to a generic node and never returns undefined', () => {
    const hit = {
      node_id: 'automation-1',
      kind: 'automation',
      score: 1,
      channels: [],
      payload: { title: 'Legacy automation' },
    } as never;

    const node = serverHitToNode(hit);
    expect(node).toBeDefined();
    expect(() => toSearchResult(node, 'server', [])).not.toThrow();
    const result = toSearchResult(node, 'server', []);
    expect(result.label).toBe('Legacy automation');
    // Missing KIND_LABELS entry falls back to the raw kind string.
    expect(result.kindLabel).toBe('automation');
  });
});

/**
 * A scope the server refused must read as refused.
 *
 * The server returns 200 with zero results and a `scopeError` when a named
 * project cannot be resolved. If the palette renders that as an ordinary empty
 * search, the user sees "no matches" for a project that does exist, or worse,
 * assumes their scope applied and the workspace is empty. The message is the
 * only thing separating those two readings.
 */
describe('an unapplied scope is reported, not swallowed', () => {
  const withScopeError = (code: string, message: string) => {
    hookState.executionPlan = {
      query: 'rotation policy',
      scopePolicy: 'strict',
      scopeSource: 'named_project',
      scopeError: { code, message },
      ordering: 'relevance',
      gaps: [`scope not applied: ${code}`],
    };
  };

  it('shows the reason a named project could not be resolved', async () => {
    withScopeError('not_found', 'No project named "Ledger".');
    const user = userEvent.setup();
    renderPalette();

    await user.type(
      screen.getByRole('textbox', { name: 'Quick search' }),
      'rotation policy in "Ledger"'
    );

    expect(await screen.findByText('No project named "Ledger".')).toBeInTheDocument();
  });

  it('shows the ambiguity rather than a silent empty list', async () => {
    withScopeError('ambiguous', 'More than one project is named "Vega".');
    const user = userEvent.setup();
    renderPalette();

    await user.type(
      screen.getByRole('textbox', { name: 'Quick search' }),
      'rotation policy in "Vega"'
    );

    expect(await screen.findByText(/more than one project is named/i)).toBeInTheDocument();
  });

  it('says nothing extra when the scope resolved normally', async () => {
    hookState.executionPlan = {
      query: 'rotation policy',
      scopePolicy: 'strict',
      scopeSource: 'named_project',
      scopeLabel: 'Ledger',
      scopeId: 'container-ledger',
      ordering: 'relevance',
      gaps: [],
    };
    const user = userEvent.setup();
    renderPalette();

    await user.type(
      screen.getByRole('textbox', { name: 'Quick search' }),
      'rotation policy in "Ledger"'
    );

    // The resolved scope surfaces as a constraint chip, not an error.
    expect(await screen.findByText('Scope: Ledger')).toBeInTheDocument();
    expect(screen.queryByText(/no project named/i)).toBeNull();
  });
});

describe('CommandPalette focus restore', () => {
  function palette(open: boolean) {
    return (
      <CommandPalette
        open={open}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onOpenThreadAgent={vi.fn()}
        onOpenThreadWithFocusMessage={vi.fn()}
        onOpenTool={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );
  }

  it('returns focus to the previously focused element when it closes', async () => {
    const composer = document.createElement('textarea');
    composer.setAttribute('aria-label', 'Message composer');
    document.body.appendChild(composer);
    composer.focus();

    const view = render(palette(true));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    await waitFor(() => expect(composer).not.toHaveFocus());

    view.rerender(palette(false));

    await waitFor(() => expect(composer).toHaveFocus());
    composer.remove();
  });

  it('leaves focus alone when the pick already moved it somewhere new', async () => {
    const composer = document.createElement('textarea');
    const opened = document.createElement('input');
    document.body.append(composer, opened);
    composer.focus();

    const view = render(palette(true));
    await waitFor(() => expect(composer).not.toHaveFocus());
    view.rerender(palette(false));
    opened.focus();

    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(opened).toHaveFocus();
    composer.remove();
    opened.remove();
  });
});

describe('CommandPalette keyboard and pointer picks', () => {
  const docResult = (id: string, label: string): SearchResult =>
    toSearchResult(
      serverHitToNode({
        node_id: id,
        kind: 'doc',
        score: 1,
        channels: ['fts'],
        payload: { title: label },
      }),
      'server',
      ['fts']
    );
  const docsSection = (results: SearchResult[]): SearchSection => ({
    id: 'server-doc',
    label: 'Docs',
    origin: 'server',
    results,
  });

  function palette(handlers: { onClose?: () => void; onSelect?: () => void } = {}) {
    return (
      <CommandPalette
        open
        onClose={handlers.onClose ?? vi.fn()}
        onSelect={handlers.onSelect ?? vi.fn()}
        onOpenThreadAgent={vi.fn()}
        onOpenThreadWithFocusMessage={vi.fn()}
        onOpenTool={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );
  }

  it('closes on Escape while focus is on a control other than the input', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(palette({ onClose }));
    // Opening focuses the input a tick later; move off it after that.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Quick search' })).toHaveFocus()
    );

    const vector = screen.getByRole('checkbox', { name: 'Vector' });
    vector.focus();
    expect(vector).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'Behind the palette';
    document.body.appendChild(outside);
    const user = userEvent.setup();
    render(palette());
    const input = screen.getByRole('textbox', { name: 'Quick search' });
    await waitFor(() => expect(input).toHaveFocus());

    const dialog = screen.getByRole('dialog', { name: 'Quick search' });
    const tabbable = Array.from(dialog.querySelectorAll<HTMLElement>('button, input'));
    tabbable[tabbable.length - 1]?.focus();
    await user.tab();
    expect(input).toHaveFocus();

    await user.tab({ shift: true });
    expect(tabbable[tabbable.length - 1]).toHaveFocus();
    outside.remove();
  });

  it('opens the row the user moved to even when later results shift the list', async () => {
    const first = docResult('doc-1111111111111-aaaaaaaaa', 'First doc');
    const second = docResult('doc-2222222222222-bbbbbbbbb', 'Second doc');
    hookState.sections = [docsSection([first, second])];
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    const view = render(palette({ onSelect, onClose }));

    const input = screen.getByRole('textbox', { name: 'Quick search' });
    await user.type(input, 'doc');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /Second doc/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // Semantic results land and insert a row above the highlighted one.
    const late = docResult('doc-3333333333333-ccccccccc', 'Late doc');
    hookState.sections = [docsSection([late, first, second])];
    view.rerender(palette({ onSelect, onClose }));
    expect(screen.getByRole('option', { name: /Second doc/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    await user.keyboard('{Enter}');
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: second.node.id });
  });

  it('stays open and says so when a picked result fails to load', async () => {
    const toolResult = toSearchResult(
      serverHitToNode({
        node_id: 'tool-1111111111111-aaaaaaaaa',
        kind: 'tool',
        score: 1,
        channels: ['fts'],
        payload: { name: 'Weather lookup' },
      }),
      'server',
      ['fts']
    );
    hookState.sections = [
      { id: 'server-tool', label: 'Tools', origin: 'server', results: [toolResult] },
    ];
    const getTool = vi.spyOn(toolsApi, 'get').mockRejectedValue(new Error('offline'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(palette({ onClose }));

    await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'weather');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('option', { name: /Couldn't open Weather lookup/ })
    ).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    getTool.mockRestore();
    consoleError.mockRestore();
  });

  it('names an irregular plural kind in the filtered placeholder', async () => {
    const user = userEvent.setup();
    render(palette());
    const input = screen.getByRole('textbox', { name: 'Quick search' });

    await user.type(input, 'memory:');
    expect(input).toHaveAttribute('placeholder', 'Search memories…');
  });

  it('announces a result count only once there is a query', async () => {
    hookState.sections = [docsSection([docResult('doc-1111111111111-aaaaaaaaa', 'First doc')])];
    const user = userEvent.setup();
    render(palette());
    expect(screen.getByRole('status')).toHaveTextContent('');

    await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'doc');

    expect(screen.getByRole('status')).toHaveTextContent('1 result across 1 kind');
  });

  describe('a pointer that has not moved', () => {
    const first = docResult('doc-1111111111111-aaaaaaaaa', 'First doc');
    const second = docResult('doc-2222222222222-bbbbbbbbb', 'Second doc');
    const row = (name: RegExp) => screen.getByRole('option', { name });

    /**
     * What a browser sends when rows appear or move under a resting pointer:
     * boundary events and, in WebKit, a mousemove — all at the same spot.
     */
    function contentAppearsUnder(element: HTMLElement, clientX: number, clientY: number) {
      fireEvent.mouseOver(element, { clientX, clientY });
      fireEvent.mouseEnter(element, { clientX, clientY });
      fireEvent.mouseMove(element, { clientX, clientY });
      fireEvent.mouseMove(element, { clientX, clientY });
    }

    it('cannot take the highlight from the first result, so Enter opens the top hit', async () => {
      hookState.sections = [docsSection([first, second])];
      const onSelect = vi.fn();
      const user = userEvent.setup();
      render(palette({ onSelect }));

      await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'doc');
      contentAppearsUnder(row(/Second doc/), 300, 200);

      expect(row(/First doc/)).toHaveAttribute('aria-selected', 'true');
      expect(row(/Second doc/)).toHaveAttribute('aria-selected', 'false');
      await user.keyboard('{Enter}');
      await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
      expect(onSelect.mock.calls[0][0]).toMatchObject({ id: first.node.id });
    });

    it('cannot take it after the query changes either', async () => {
      hookState.sections = [docsSection([first, second])];
      const user = userEvent.setup();
      render(palette());
      const input = screen.getByRole('textbox', { name: 'Quick search' });

      await user.type(input, 'doc');
      fireEvent.mouseMove(row(/Second doc/), { clientX: 300, clientY: 200 });
      fireEvent.mouseMove(row(/Second doc/), { clientX: 302, clientY: 203 });
      expect(row(/Second doc/)).toHaveAttribute('aria-selected', 'true');

      // Typing puts the highlight back on the top result; the pointer stays put
      // while the new results render under it.
      await user.type(input, 's');
      expect(row(/First doc/)).toHaveAttribute('aria-selected', 'true');
      contentAppearsUnder(row(/Second doc/), 302, 203);
      expect(row(/First doc/)).toHaveAttribute('aria-selected', 'true');
    });

    it('still lets a real move highlight a row, arrow keys move on from it, and a click opens the clicked row', async () => {
      hookState.sections = [docsSection([first, second])];
      const onSelect = vi.fn();
      const user = userEvent.setup();
      render(palette({ onSelect }));

      await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'doc');
      fireEvent.mouseMove(row(/Second doc/), { clientX: 300, clientY: 200 });
      fireEvent.mouseMove(row(/Second doc/), { clientX: 304, clientY: 206 });
      expect(row(/Second doc/)).toHaveAttribute('aria-selected', 'true');

      await user.keyboard('{ArrowUp}');
      expect(row(/First doc/)).toHaveAttribute('aria-selected', 'true');

      fireEvent.mouseDown(row(/Second doc/), { button: 0 });
      await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
      expect(onSelect.mock.calls[0][0]).toMatchObject({ id: second.node.id });
    });
  });

  it('ignores a right-click on a result row', async () => {
    hookState.sections = [docsSection([docResult('doc-1111111111111-aaaaaaaaa', 'First doc')])];
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(palette({ onSelect }));

    await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'doc');
    fireEvent.mouseDown(screen.getByRole('option', { name: /First doc/ }), { button: 2 });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('matches found only by meaning', () => {
  const meaningDoc = toSearchResult(
    serverHitToNode({
      node_id: 'doc-1111111111111-aaaaaaaaa',
      kind: 'doc',
      score: 0.01,
      channels: ['vector'],
      vectorSimilarity: 0.45,
      payload: { title: 'Nearby doc' },
    }),
    'server',
    ['vector']
  );
  const meaningFile: PaletteFileNodeItem = {
    type: 'file-node',
    nodeId: 'file-1111111111111-aaaaaaaaa',
    relativePath: 'notes/loose-ends.md',
    absolutePath: '/tmp/project/notes/loose-ends.md',
    projectId: 'project-1',
    sizeBytes: 512,
    updatedAt: '2026-01-01T00:00:00.000Z',
    score: 0.42,
  };

  function palette(handlers: { onSelect?: () => void; onOpenFile?: () => void } = {}) {
    return (
      <CommandPalette
        open
        onClose={vi.fn()}
        onSelect={handlers.onSelect ?? vi.fn()}
        onOpenThreadAgent={vi.fn()}
        onOpenThreadWithFocusMessage={vi.fn()}
        onOpenTool={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenFile={handlers.onOpenFile ?? vi.fn()}
      />
    );
  }

  it('lists them in the normal result sections and opens them', async () => {
    hookState.sections = [
      { id: 'server-doc', label: 'Docs', origin: 'server', results: [meaningDoc] },
    ];
    hookState.fileResults = [meaningFile];
    const onSelect = vi.fn();
    const onOpenFile = vi.fn();
    const user = userEvent.setup();
    render(palette({ onSelect, onOpenFile }));

    await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'zzqv');

    const rows = screen.getAllByRole('option');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Nearby doc');
    expect(rows[1]).toHaveTextContent('notes/loose-ends.md');
    expect(screen.getByText('Docs')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 results across 1 kind');

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onOpenFile).toHaveBeenCalledWith(meaningFile);

    await user.keyboard('{ArrowUp}');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: 'doc-1111111111111-aaaaaaaaa' });
  });

  it('says there are no results when nothing matched at all', async () => {
    const user = userEvent.setup();
    render(palette());

    await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'zzqv');

    expect(screen.getByRole('option')).toHaveTextContent('No results for zzqv');
    expect(screen.getByText('open')).toBeInTheDocument();
  });
});

describe('what a result row says', () => {
  const devDefault = import.meta.env.DEV;
  afterEach(() => {
    vi.stubEnv('DEV', devDefault);
  });

  const backups: SearchResult = {
    ...toSearchResult(
      {
        kind: 'doc',
        id: 'doc-1111111111111-aaaaaaaaa',
        containerId: 'container-1111111111111-aaaaaaaaa',
        title: 'Backups',
        content: '',
        sortOrder: 0,
        createdAt: '2026-11-16T20:24:00.000Z',
        updatedAt: '2026-11-16T20:24:00.000Z',
      },
      'lexical'
    ),
    location: 'Onboarding / Features',
  };
  const bestMatches: SearchSection = {
    id: 'lexical',
    label: 'Best matches',
    origin: 'lexical',
    results: [backups],
  };

  function palette() {
    return (
      <CommandPalette
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onOpenThreadAgent={vi.fn()}
        onOpenThreadWithFocusMessage={vi.fn()}
        onOpenTool={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );
  }

  it('says where the result lives, not when it was created', async () => {
    hookState.sections = [bestMatches];
    const user = userEvent.setup();
    render(palette());

    await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'backup');

    const row = screen.getByRole('option', { name: /Backups/ });
    expect(within(row).getByTestId('result-meta')).toHaveTextContent('Onboarding / Features');
    expect(row).not.toHaveTextContent(/created/i);
    // The tooltip holds what the row may cut short.
    expect(row.getAttribute('title')).toMatch(/^Backups — Onboarding \/ Features/);
  });

  it('keeps search-engine internals out of a production build', async () => {
    vi.stubEnv('DEV', false);
    hookState.sections = [bestMatches];
    hookState.coverage = { doc: 'hybrid', thread: 'lexical' };
    const user = userEvent.setup();
    render(palette());

    await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'backup');

    expect(screen.getByText('Best matches')).toBeInTheDocument();
    expect(screen.queryByText('instant')).toBeNull();
    expect(screen.queryByText(/Hybrid: 1/)).toBeNull();
    expect(screen.getByRole('option', { name: /Backups/ }).getAttribute('title')).not.toMatch(
      /channel|lexical/i
    );
  });

  it('still shows them in development', async () => {
    vi.stubEnv('DEV', true);
    hookState.sections = [bestMatches];
    hookState.coverage = { doc: 'hybrid', thread: 'lexical' };
    const user = userEvent.setup();
    render(palette());

    await user.type(screen.getByRole('textbox', { name: 'Quick search' }), 'backup');

    expect(screen.getByText('instant')).toBeInTheDocument();
    expect(screen.getByText('Hybrid: 1 · Lexical: 1')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Backups/ }).getAttribute('title')).toMatch(
      /Lexical result/
    );
  });
});
