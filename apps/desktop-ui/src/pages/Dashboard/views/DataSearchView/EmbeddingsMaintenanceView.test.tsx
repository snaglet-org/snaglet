import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { EmbeddingsMaintenanceView } from './EmbeddingsMaintenanceView';
const api = vi.hoisted(() => ({
  listMaintenanceModels: vi.fn(),
  getMaintenanceStatus: vi.fn(),
  startMaintenanceJob: vi.fn(),
  status: vi.fn(),
  semanticOverview: vi.fn(),
  setSemanticSearch: vi.fn(),
}));
vi.mock('@desktop/utils/api', () => ({
  embeddingsApi: api,
  workersApi: { status: api.status },
  tablesApi: { semanticOverview: api.semanticOverview, setSemanticSearch: api.setSemanticSearch },
}));
// Each interval by its period: the pane's 1.5 s refresh and the table list's 3 s one.
const polling = vi.hoisted(() => ({
  ticks: new Map<number, { tick: () => Promise<void>; enabled: boolean }>(),
}));
vi.mock('@desktop/hooks/useGuardedInterval', () => ({
  useGuardedInterval: (
    tick: () => Promise<void>,
    opts: { intervalMs: number; enabled: boolean }
  ) => {
    polling.ticks.set(opts.intervalMs, { tick, enabled: opts.enabled });
  },
}));
const ESTIMATE = { rows: 12, bytes: 52_800, label: '~52 KB' };
const TABLES = [
  {
    tableId: 'table-1111111111111-aaaaaaaaa',
    tableName: 'notes',
    projectName: 'Pets',
    enabled: true,
    rows: 12,
    rowsCapped: false,
    needsConfirmation: false,
    indexed: 12,
    state: 'ready',
    estimate: ESTIMATE,
  },
  {
    tableId: 'table-1111111111111-bbbbbbbbb',
    tableName: 'web_log',
    projectName: null,
    enabled: false,
    rows: 10_006,
    rowsCapped: false,
    needsConfirmation: true,
    indexed: 0,
    state: 'off',
    estimate: { rows: 10_006, bytes: 44_026_400, label: '~42 MB' },
  },
];
const coverage = [
  { nodeType: 'doc', fresh: 2, missing: 0, stale: 1 },
  { nodeType: 'table_entry', fresh: 3, missing: 2, stale: 0 },
  { nodeType: 'file', fresh: 1, missing: 0, stale: 0 },
];
beforeEach(() => {
  vi.clearAllMocks();
  api.listMaintenanceModels.mockResolvedValue([{ id: 'local', nodeTypeCoverage: coverage }]);
  api.getMaintenanceStatus.mockResolvedValue({ running: false });
  api.startMaintenanceJob.mockResolvedValue({ running: true, total: 3, processed: 0 });
  api.status.mockResolvedValue({
    automaticLocalIntelligenceEnabled: true,
    policy: { envEnabled: true, embeddingsEnabled: false, active: false },
  });
  api.semanticOverview.mockResolvedValue({ tables: TABLES });
  polling.ticks.clear();
});
describe('simplified embeddings pane', () => {
  it('shows one overall bar and table-semantic counts without ledger or maintenance card', async () => {
    render(<EmbeddingsMaintenanceView />);
    expect(await screen.findByText('6 of 9 indexed')).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    expect(screen.getByText('Table entries')).toBeInTheDocument();
    expect(screen.queryByText(/ledger|maintenance job/i)).not.toBeInTheDocument();
  });
  it('unifies stale-only and table missing scopes and works with workers off', async () => {
    render(<EmbeddingsMaintenanceView />);
    await screen.findByText('Table entries');
    fireEvent.click(screen.getByRole('button', { name: 'Backfill documents' }));
    await waitFor(() =>
      expect(api.startMaintenanceJob).toHaveBeenCalledWith({
        operation: 'backfill',
        modelId: 'local',
        nodeType: 'doc',
      })
    );
  });
  it('links directly to actual worker controls', async () => {
    const listener = vi.fn();
    window.addEventListener('snaglet:open-worker-controls', listener);
    render(<EmbeddingsMaintenanceView />);
    await screen.findByText('Table entries');
    fireEvent.click(screen.getByRole('button', { name: 'Worker controls' }));
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener('snaglet:open-worker-controls', listener);
  });
  it('disables complete kind with a reason', async () => {
    render(<EmbeddingsMaintenanceView />);
    await screen.findByText('Files');
    const button = screen.getByRole('button', { name: 'Backfill files' });
    expect(button).toBeDisabled();
    expect(button.parentElement).toHaveAttribute('title', 'Nothing missing or stale');
  });
  it('backfill all uses same progress state', async () => {
    api.getMaintenanceStatus.mockResolvedValue({ running: true, total: 9, processed: 3 });
    render(<EmbeddingsMaintenanceView />);
    expect(await screen.findByText('Backfilling 3 of 9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Backfill all' })).toBeDisabled();
  });
  it('updates the same overall bar from live polling coverage', async () => {
    render(<EmbeddingsMaintenanceView />);
    await screen.findByText('6 of 9 indexed');
    api.listMaintenanceModels.mockResolvedValue([
      {
        id: 'local',
        nodeTypeCoverage: coverage.map((row) => ({
          ...row,
          fresh: row.fresh + row.missing + row.stale,
          missing: 0,
          stale: 0,
        })),
      },
    ]);
    await act(async () => {
      await polling.ticks.get(1500)?.tick();
    });
    expect(screen.getByText('9 of 9 indexed')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '9');
  });
  it('says the built-in model is not active only once the list has loaded without it', async () => {
    api.listMaintenanceModels.mockResolvedValue([]);
    render(<EmbeddingsMaintenanceView />);
    expect(screen.queryByText(/built-in embedding model is not active/)).not.toBeInTheDocument();
    expect(
      await screen.findByText(
        'The built-in embedding model is not active in the models catalog. Restart Snaglet to restore it.'
      )
    ).toBeInTheDocument();
  });
});
describe('search by meaning per table', () => {
  it('states the rule and lists every table with its project, status line and switch', async () => {
    render(<EmbeddingsMaintenanceView />);
    expect(
      await screen.findByText(
        'Tables up to 10,000 rows are indexed automatically; bigger ones are off until you turn them on.'
      )
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Tables' });
    expect(list).toHaveTextContent('notes');
    expect(list).toHaveTextContent('Pets · 12 of 12 rows indexed · ~52 KB');
    expect(list).toHaveTextContent(
      'Off · 10,006 rows, more than the 10,000 indexed automatically (~42 MB)'
    );
    expect(screen.getByRole('switch', { name: 'Search by meaning in notes' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('switch', { name: 'Search by meaning in web_log' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it("turns a table off through its row's switch and shows the answer", async () => {
    api.setSemanticSearch.mockResolvedValue({
      ...TABLES[0],
      enabled: false,
      indexed: 0,
      state: 'off',
      rowCap: 10_000,
      cardFields: [],
      excludedByName: [],
      warning: '',
    });
    render(<EmbeddingsMaintenanceView />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Search by meaning in notes' }));
    await waitFor(() =>
      expect(api.setSemanticSearch).toHaveBeenCalledWith('table-1111111111111-aaaaaaaaa', {
        enabled: false,
      })
    );
    expect(await screen.findByText('Pets · Off · 12 rows')).toBeInTheDocument();
  });

  it('a table over the cap asks in-line before turning on with confirm', async () => {
    api.setSemanticSearch.mockResolvedValue({
      ...TABLES[1],
      enabled: true,
      state: 'indexing',
      rowCap: 10_000,
      cardFields: [],
      excludedByName: [],
      warning: '',
    });
    render(<EmbeddingsMaintenanceView />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Search by meaning in web_log' }));
    expect(api.setSemanticSearch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on anyway (~42 MB)' }));
    await waitFor(() =>
      expect(api.setSemanticSearch).toHaveBeenCalledWith('table-1111111111111-bbbbbbbbb', {
        enabled: true,
        confirm: true,
      })
    );
    expect(
      await screen.findByRole('switch', { name: 'Search by meaning in web_log' })
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('polls the list only while a table is building, and shows a pause reason once', async () => {
    api.semanticOverview.mockResolvedValue({
      tables: [{ ...TABLES[0], indexed: 3, state: 'indexing' }],
    });
    render(<EmbeddingsMaintenanceView />);
    await screen.findByText('Pets · Indexing… 3 of 12 rows · ~52 KB');
    expect(polling.ticks.get(3000)?.enabled).toBe(true);

    api.semanticOverview.mockResolvedValue({
      tables: [{ ...TABLES[0], indexed: 3, state: 'indexing', paused: 'Building is off.' }],
    });
    await act(async () => {
      await polling.ticks.get(3000)?.tick();
    });
    expect(screen.getByText('Building is off.')).toBeInTheDocument();
    expect(screen.getByText('Pets · 3 of 12 rows indexed · ~52 KB')).toBeInTheDocument();
    expect(polling.ticks.get(3000)?.enabled).toBe(false);
  });

  it('a table held at the cap says why in its row and confirms with "Turn on anyway"', async () => {
    const held = {
      ...TABLES[1],
      enabled: true,
      indexed: 6,
      state: 'indexing',
      awaitingConfirm: true,
      paused: 'Over 10,000 rows; turn on anyway to index all 10,006 rows (~42 MB).',
    };
    api.semanticOverview.mockResolvedValue({ tables: [held] });
    api.setSemanticSearch.mockResolvedValue({
      ...held,
      awaitingConfirm: undefined,
      paused: undefined,
      rowCap: 10_000,
      cardFields: [],
      excludedByName: [],
      warning: '',
    });
    render(<EmbeddingsMaintenanceView />);
    const list = await screen.findByRole('list', { name: 'Tables' });
    expect(list).toHaveTextContent('6 of 10,006 rows indexed · ~42 MB');
    expect(list).toHaveTextContent('Over 10,000 rows; turn on anyway to index all 10,006 rows');
    // Said in the row, not as the build-wide reason above the list.
    expect(
      screen.getAllByText('Over 10,000 rows; turn on anyway to index all 10,006 rows (~42 MB).')
    ).toHaveLength(1);
    expect(polling.ticks.get(3000)?.enabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on anyway (~42 MB)' }));
    await waitFor(() =>
      expect(api.setSemanticSearch).toHaveBeenCalledWith('table-1111111111111-bbbbbbbbb', {
        enabled: true,
        confirm: true,
      })
    );
    expect(await screen.findByText('Indexing… 6 of 10,006 rows · ~42 MB')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Turn on anyway/ })).not.toBeInTheDocument();
  });
});
