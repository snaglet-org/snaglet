import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SemanticStatus, TableCatalogEntry } from '@snaglet/shared/types';
import { TableSemanticControl } from './TableSemanticControl';

const api = vi.hoisted(() => ({
  semanticStatus: vi.fn(),
  setSemanticSearch: vi.fn(),
}));
vi.mock('@desktop/utils/api', () => ({ tablesApi: api }));

const polling = vi.hoisted(() => ({
  tick: null as null | ((signal: { canceled: boolean }) => Promise<void>),
  enabled: false,
}));
vi.mock('@desktop/hooks/useGuardedInterval', () => ({
  useGuardedInterval: (
    tick: (signal: { canceled: boolean }) => Promise<void>,
    opts: { enabled: boolean }
  ) => {
    polling.tick = tick;
    polling.enabled = opts.enabled;
  },
}));

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const TABLE: TableCatalogEntry = {
  id: TABLE_ID,
  name: 'notes',
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function status(overrides: Partial<SemanticStatus> = {}): SemanticStatus {
  return {
    tableId: TABLE_ID,
    tableName: 'notes',
    enabled: true,
    rows: 12,
    rowsCapped: false,
    rowCap: 10_000,
    needsConfirmation: false,
    indexed: 12,
    state: 'ready',
    estimate: { rows: 12, bytes: 52_800, label: '~52 KB' },
    cardFields: ['name'],
    excludedByName: [],
    warning: 'best-effort',
    ...overrides,
  };
}

async function openPanel(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Search by meaning: (On|Off)/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  polling.tick = null;
  polling.enabled = false;
});

describe('TableSemanticControl', () => {
  it('says On or Off on the trigger and shows the switch with one status line', async () => {
    api.semanticStatus.mockResolvedValue(status());
    render(<TableSemanticControl table={TABLE} />);
    await openPanel();
    expect(await screen.findByRole('switch', { name: 'Search by meaning' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByText('12 of 12 rows indexed · ~52 KB')).toBeInTheDocument();
  });

  it('says Indexing… while building and re-reads the status while the panel is open', async () => {
    api.semanticStatus.mockResolvedValue(status({ indexed: 4, state: 'indexing' }));
    render(<TableSemanticControl table={TABLE} />);
    await openPanel();
    expect(await screen.findByText('Indexing… 4 of 12 rows · ~52 KB')).toBeInTheDocument();
    await waitFor(() => expect(polling.enabled).toBe(true));
    api.semanticStatus.mockResolvedValue(status());
    await act(async () => {
      await polling.tick?.({ canceled: false });
    });
    expect(screen.getByText('12 of 12 rows indexed · ~52 KB')).toBeInTheDocument();
    expect(polling.enabled).toBe(false);
  });

  it('shows why building is paused instead of Indexing…, and does not poll', async () => {
    api.semanticStatus.mockResolvedValue(
      status({ indexed: 0, state: 'indexing', paused: 'Automatic local intelligence is off.' })
    );
    render(<TableSemanticControl table={TABLE} />);
    await openPanel();
    expect(await screen.findByText('0 of 12 rows indexed · ~52 KB')).toBeInTheDocument();
    expect(screen.getByText('Automatic local intelligence is off.')).toBeInTheDocument();
    expect(polling.enabled).toBe(false);
  });

  it('turns it off through the API and relabels the trigger', async () => {
    api.semanticStatus.mockResolvedValue(status());
    api.setSemanticSearch.mockResolvedValue(status({ enabled: false, state: 'off', indexed: 0 }));
    render(<TableSemanticControl table={TABLE} />);
    await openPanel();
    fireEvent.click(await screen.findByRole('switch', { name: 'Search by meaning' }));
    await waitFor(() =>
      expect(api.setSemanticSearch).toHaveBeenCalledWith(TABLE_ID, { enabled: false })
    );
    expect(await screen.findByText('Off · 12 rows')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Search by meaning: Off/ })).toBeInTheDocument();
  });

  it('a table over the cap asks in-line first, then turns on with confirm', async () => {
    const big = status({
      enabled: false,
      state: 'off',
      indexed: 0,
      rows: 10_006,
      needsConfirmation: true,
      estimate: { rows: 10_006, bytes: 44_026_400, label: '~42 MB' },
    });
    api.semanticStatus.mockResolvedValue(big);
    api.setSemanticSearch.mockResolvedValue({ ...big, enabled: true, state: 'indexing' });
    render(<TableSemanticControl table={TABLE} />);
    await openPanel();
    expect(
      await screen.findByText(
        'Off · 10,006 rows, more than the 10,000 indexed automatically (~42 MB)'
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Search by meaning' }));
    expect(api.setSemanticSearch).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /confirm/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on anyway (~42 MB)' }));
    await waitFor(() =>
      expect(api.setSemanticSearch).toHaveBeenCalledWith(TABLE_ID, {
        enabled: true,
        confirm: true,
      })
    );
    expect(
      await screen.findByRole('button', { name: /Search by meaning: On/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Turn on anyway/ })).not.toBeInTheDocument();
  });

  it('Cancel drops the second step without saving', async () => {
    api.semanticStatus.mockResolvedValue(
      status({ enabled: false, state: 'off', indexed: 0, needsConfirmation: true })
    );
    render(<TableSemanticControl table={TABLE} />);
    await openPanel();
    fireEvent.click(await screen.findByRole('switch', { name: 'Search by meaning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: /Turn on anyway/ })).not.toBeInTheDocument();
    expect(api.setSemanticSearch).not.toHaveBeenCalled();
  });

  it('shows the error in-line when the switch fails', async () => {
    api.semanticStatus.mockResolvedValue(status());
    api.setSemanticSearch.mockRejectedValue(new Error('Server unavailable'));
    render(<TableSemanticControl table={TABLE} />);
    await openPanel();
    fireEvent.click(await screen.findByRole('switch', { name: 'Search by meaning' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
  });

  it('never asks about a Snaglet table', async () => {
    const { container } = render(
      <TableSemanticControl table={{ ...TABLE, id: 'table-builtin-docs', origin: 'builtin' }} />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.semanticStatus).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('retries a failed first read once after 2 s, then shows the control', async () => {
    vi.useFakeTimers();
    try {
      api.semanticStatus
        .mockRejectedValueOnce(new Error('Server restarting'))
        .mockResolvedValue(status());
      render(<TableSemanticControl table={TABLE} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(api.semanticStatus).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: /Search by meaning/ })).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(api.semanticStatus).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: /Search by meaning: On/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays hidden when the retry fails too', async () => {
    vi.useFakeTimers();
    try {
      api.semanticStatus.mockRejectedValue(new Error('Not found'));
      const { container } = render(<TableSemanticControl table={TABLE} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(api.semanticStatus).toHaveBeenCalledTimes(2);
      expect(container).toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a table that grew past the cap shows why it waits and "Turn on anyway", which confirms', async () => {
    const held = status({
      rows: 10_006,
      indexed: 6,
      state: 'indexing',
      needsConfirmation: true,
      awaitingConfirm: true,
      paused: 'Over 10,000 rows; turn on anyway to index all 10,006 rows (~42 MB).',
      estimate: { rows: 10_006, bytes: 44_026_400, label: '~42 MB' },
    });
    api.semanticStatus.mockResolvedValue(held);
    api.setSemanticSearch.mockResolvedValue(
      status({
        rows: 10_006,
        indexed: 6,
        state: 'indexing',
        needsConfirmation: true,
        estimate: held.estimate,
      })
    );
    render(<TableSemanticControl table={TABLE} />);
    await openPanel();
    expect(await screen.findByText('6 of 10,006 rows indexed · ~42 MB')).toBeInTheDocument();
    expect(
      screen.getByText('Over 10,000 rows; turn on anyway to index all 10,006 rows (~42 MB).')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(polling.enabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on anyway (~42 MB)' }));
    await waitFor(() =>
      expect(api.setSemanticSearch).toHaveBeenCalledWith(TABLE_ID, {
        enabled: true,
        confirm: true,
      })
    );
    expect(await screen.findByText('Indexing… 6 of 10,006 rows · ~42 MB')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Turn on anyway/ })).not.toBeInTheDocument();
  });
});
