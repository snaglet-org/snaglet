import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectsApi } from '@desktop/utils/api';
import type {
  ProjectEmbeddingsClearPreview,
  ProjectIndexingStatus,
} from '@desktop/utils/api/projects';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { EmbeddingsSection } from './EmbeddingsSection';

vi.mock('@desktop/utils/api', () => ({
  projectsApi: {
    getIndexingStatus: vi.fn(),
    getEmbeddingsClearPreview: vi.fn(),
    updateIndexConfig: vi.fn(),
    startEmbeddingsBackfill: vi.fn(),
    cancelEmbeddingsBackfill: vi.fn(),
    clearEmbeddings: vi.fn(),
    applyHeldRemovals: vi.fn(),
  },
}));

vi.mock('@desktop/components', () => ({
  Button: ({ children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => (
    <button {...props}>{children}</button>
  ),
  Light: () => <span data-testid="status-light" />,
  Modal: ({ children }: PropsWithChildren) => <div role="dialog">{children}</div>,
}));

const getIndexingStatus = vi.mocked(projectsApi.getIndexingStatus);
const getEmbeddingsClearPreview = vi.mocked(projectsApi.getEmbeddingsClearPreview);
const updateIndexConfig = vi.mocked(projectsApi.updateIndexConfig);
const startEmbeddingsBackfill = vi.mocked(projectsApi.startEmbeddingsBackfill);
const clearEmbeddings = vi.mocked(projectsApi.clearEmbeddings);
const applyHeldRemovals = vi.mocked(projectsApi.applyHeldRemovals);

const enabledStatus: ProjectIndexingStatus = {
  op: 'idle',
  activeExclusiveOp: null,
  backfill: null,
  lastCheckedAt: null,
  lastError: null,
  hasFolder: true,
  folderPath: '/tmp/proj',
  configStatus: 'present',
  workerEnabled: true,
  coverage: { embeddedFiles: 8, totalFiles: 10 },
  ownerProjectId: 'project-1',
};

const preview: ProjectEmbeddingsClearPreview = {
  fileCount: 10,
  uniqueContents: 9,
  sharedContents: 0,
  exclusiveContents: 9,
  vectorChunks: 24,
  linkedBytes: 3 * 1024 * 1024,
  reclaimableBytes: 3 * 1024 * 1024,
};

beforeEach(() => {
  getIndexingStatus.mockReset().mockResolvedValue(enabledStatus);
  getEmbeddingsClearPreview.mockReset().mockResolvedValue(preview);
  updateIndexConfig.mockReset().mockResolvedValue({
    hasFolder: true,
    folderPath: '/tmp/proj',
    configExists: true,
    parseError: false,
    enabled: false,
    includePaths: [],
    ignorePaths: [],
    ignoreFileTypes: [],
    defaults: { dirs: [], filenames: [], extensions: [] },
  });
  vi.mocked(projectsApi.cancelEmbeddingsBackfill)
    .mockReset()
    .mockResolvedValue({ cancelling: true });
  startEmbeddingsBackfill.mockReset().mockResolvedValue({ started: true });
  clearEmbeddings.mockReset().mockResolvedValue({ removedFiles: 10, removedChunks: 24 });
  applyHeldRemovals.mockReset().mockResolvedValue({ removed: 250, kept: 0, upserted: 0 });
});

describe('EmbeddingsSection', () => {
  it('shows the enabled worker status with coverage', async () => {
    render(<EmbeddingsSection projectId="project-1" />);

    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText(/periodically checks the folder/)).toBeInTheDocument();
    expect(screen.getByText(/8 of 10 indexed files vectorized · 80%/)).toBeInTheDocument();
    expect(screen.getByText(/2 missing or stale/)).toBeInTheDocument();
  });

  it('paused state says embeddings are preserved and keeps coverage visible', async () => {
    getIndexingStatus.mockResolvedValue({ ...enabledStatus, workerEnabled: false });
    render(<EmbeddingsSection projectId="project-1" />);

    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(
      screen.getByText(/Existing embeddings are preserved and remain searchable/)
    ).toBeInTheDocument();
    // Paused must not look like data loss — the coverage numbers stay.
    expect(screen.getByText(/8 of 10 indexed files vectorized/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable background indexing' })).toBeInTheDocument();
  });

  it('disabling the worker uses the reversible pause API, never the clear API', async () => {
    render(<EmbeddingsSection projectId="project-1" />);
    const disable = await screen.findByRole('button', { name: 'Disable background indexing' });

    fireEvent.click(disable);

    await waitFor(() =>
      expect(updateIndexConfig).toHaveBeenCalledWith('project-1', { enabled: false })
    );
    expect(clearEmbeddings).not.toHaveBeenCalled();
  });

  it('clear requires confirmation: modal shows honest numbers, cancel does nothing', async () => {
    render(<EmbeddingsSection projectId="project-1" />);
    const clearBtn = await screen.findByRole('button', { name: /Clear embeddings · 3 MB/ });

    fireEvent.click(clearBtn);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Clear embeddings for this project?');
    // Indexed file rows (10) and embeddings (24) are different counts and must
    // be stated separately — collapsing them contradicts the coverage line
    // whenever coverage is partial.
    expect(dialog).toHaveTextContent(/10 indexed files and 24 embeddings \(~3 MB\)/);
    expect(dialog).toHaveTextContent(/Your source files will not be changed/);
    expect(clearEmbeddings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(clearEmbeddings).not.toHaveBeenCalled();
  });

  it('confirming the modal calls the clear endpoint exactly once', async () => {
    render(<EmbeddingsSection projectId="project-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Clear embeddings · 3 MB/ }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Clear embeddings' }));

    await waitFor(() => expect(clearEmbeddings).toHaveBeenCalledTimes(1));
    expect(clearEmbeddings).toHaveBeenCalledWith('project-1');
    // Clearing must not silently change the worker preference.
    expect(updateIndexConfig).not.toHaveBeenCalled();
  });

  it('never presents shared content-addressed embeddings as reclaimed space', async () => {
    getEmbeddingsClearPreview.mockResolvedValue({
      ...preview,
      sharedContents: 4,
      exclusiveContents: 5,
      linkedBytes: 3 * 1024 * 1024,
      reclaimableBytes: 1024 * 1024,
    });
    render(<EmbeddingsSection projectId="project-1" />);

    // The action label carries the reclaimable size (1 MB), not linked (3 MB).
    fireEvent.click(await screen.findByRole('button', { name: /Clear embeddings · 1 MB/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/~1 MB/);
    expect(dialog).toHaveTextContent(/4 embedded contents are also referenced by other projects/);
    expect(dialog).toHaveTextContent(/will be kept/);
  });

  it('starts a backfill and shows live progress from runtime events', async () => {
    render(<EmbeddingsSection projectId="project-1" />);
    const backfillBtn = await screen.findByRole('button', { name: 'Backfill missing or stale' });

    fireEvent.click(backfillBtn);
    await waitFor(() => expect(startEmbeddingsBackfill).toHaveBeenCalledWith('project-1'));

    act(() =>
      emitLibraryEvent({
        type: 'file-indexing-status-changed',
        projectId: 'project-1',
        runtime: {
          op: 'embedding',
          activeExclusiveOp: 'backfill',
          backfill: { total: 40, processed: 12, embedded: 11, reused: 0, failed: 1 },
          lastCheckedAt: null,
          lastError: null,
        },
      })
    );

    expect(await screen.findByText('Embedding')).toBeInTheDocument();
    expect(screen.getByText(/Embedding 12 of 40/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    // Conflicting actions are disabled while the exclusive op runs.
    expect(screen.getByRole('button', { name: 'Backfill missing or stale' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Clear embeddings/ })).toBeDisabled();
  });

  it('surfaces a failed operation instead of a false complete state', async () => {
    render(<EmbeddingsSection projectId="project-1" />);
    await screen.findByText('Enabled');

    // Refreshes triggered by the idle transition must not clobber the error.
    getIndexingStatus.mockResolvedValue({
      ...enabledStatus,
      lastError: 'embedding provider unavailable',
    });
    act(() =>
      emitLibraryEvent({
        type: 'file-indexing-status-changed',
        projectId: 'project-1',
        runtime: {
          op: 'idle',
          activeExclusiveOp: null,
          backfill: null,
          lastCheckedAt: null,
          lastError: 'embedding provider unavailable',
        },
      })
    );

    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('embedding provider unavailable')).toBeInTheDocument();
  });

  it('ignores runtime events for other projects', async () => {
    render(<EmbeddingsSection projectId="project-1" />);
    await screen.findByText('Enabled');

    act(() =>
      emitLibraryEvent({
        type: 'file-indexing-status-changed',
        projectId: 'project-2',
        runtime: {
          op: 'clearing',
          activeExclusiveOp: 'clear',
          backfill: null,
          lastCheckedAt: null,
          lastError: null,
        },
      })
    );

    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.queryByText('Clearing')).not.toBeInTheDocument();
  });
});

describe('backfill cancellation', () => {
  it('cancels an active pass and shows preserved terminal progress with resume available', async () => {
    getIndexingStatus.mockResolvedValue({
      ...enabledStatus,
      op: 'embedding',
      activeExclusiveOp: 'backfill',
      backfill: { total: 20, processed: 3, embedded: 3, reused: 0, failed: 0 },
    });
    render(<EmbeddingsSection projectId="project-1" />);
    const cancel = await screen.findByRole('button', { name: 'Cancel backfill' });
    expect(screen.getByText('Folder: /tmp/proj')).toBeInTheDocument();
    getIndexingStatus.mockResolvedValue({
      ...enabledStatus,
      op: 'cancelled',
      backfill: { total: 20, processed: 4, embedded: 4, reused: 0, failed: 0 },
    });
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(projectsApi.cancelEmbeddingsBackfill).toHaveBeenCalledWith('project-1')
    );
    expect(await screen.findByText('Canceled')).toBeInTheDocument();
    expect(screen.getByText(/Canceled — processed 4 of 20/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Backfill missing or stale' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel backfill' })).not.toBeInTheDocument();
  });

  it('offers cancellation during scanning but not for a clear', async () => {
    getIndexingStatus.mockResolvedValue({
      ...enabledStatus,
      op: 'scanning',
      activeExclusiveOp: 'backfill',
    });
    const { unmount } = render(<EmbeddingsSection projectId="project-1" />);
    expect(await screen.findByRole('button', { name: 'Cancel backfill' })).toBeEnabled();
    unmount();
    getIndexingStatus.mockResolvedValue({
      ...enabledStatus,
      op: 'clearing',
      activeExclusiveOp: 'clear',
    });
    render(<EmbeddingsSection projectId="project-1" />);
    await screen.findByText('Clearing');
    expect(screen.queryByRole('button', { name: 'Cancel backfill' })).not.toBeInTheDocument();
  });
});

describe('held removals and indexing warnings', () => {
  const heldStatus: ProjectIndexingStatus = {
    ...enabledStatus,
    lastWarning:
      '250 of 251 indexed files are missing from the folder; Snaglet kept them in case this was a mistake (mass-removal backstop)',
    heldRemovals: { count: 250, total: 251, since: '2026-10-07T23:00:00.000Z' },
  };

  it('shows a plain-words banner and the release button only when something is held', async () => {
    getIndexingStatus.mockResolvedValue(heldStatus);
    render(<EmbeddingsSection projectId="project-1" />);
    const banner = await screen.findByTestId('held-removals-banner');
    expect(banner).toHaveTextContent(
      /250 files are missing from the folder; Snaglet kept them in case this was a mistake/
    );
    expect(screen.getByRole('button', { name: /Remove 250 missing files/ })).toBeEnabled();
  });

  it('shows lastWarning (e.g. unreadable folders) without a release button', async () => {
    getIndexingStatus.mockResolvedValue({
      ...enabledStatus,
      lastWarning: 'kept 3 file(s) under 1 folder(s) Snaglet could not read: locked (EACCES)',
    });
    render(<EmbeddingsSection projectId="project-1" />);
    expect(await screen.findByTestId('indexing-warning')).toHaveTextContent(/could not read/);
    expect(screen.queryByRole('button', { name: /missing file/ })).not.toBeInTheDocument();
  });

  it('shows no banner and no button when nothing is held or warned', async () => {
    render(<EmbeddingsSection projectId="project-1" />);
    await screen.findByText('Enabled');
    expect(screen.queryByTestId('held-removals-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('indexing-warning')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /missing file/ })).not.toBeInTheDocument();
  });

  it('the confirm names the folder and exact count; Keep them does nothing', async () => {
    getIndexingStatus.mockResolvedValue(heldStatus);
    render(<EmbeddingsSection projectId="project-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Remove 250 missing files/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/250 of 251 indexed files/);
    expect(dialog).toHaveTextContent('/tmp/proj');
    expect(dialog).toHaveTextContent(/Your files on disk are not touched/);
    expect(screen.getByRole('button', { name: 'Remove 250 missing files' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(applyHeldRemovals).not.toHaveBeenCalled();
  });

  it('confirming calls the release with the exact count the person saw', async () => {
    getIndexingStatus.mockResolvedValue(heldStatus);
    render(<EmbeddingsSection projectId="project-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Remove 250 missing files/ }));
    await screen.findByRole('dialog');
    getIndexingStatus.mockResolvedValue(enabledStatus);
    fireEvent.click(screen.getByRole('button', { name: 'Remove 250 missing files' }));
    await waitFor(() => expect(applyHeldRemovals).toHaveBeenCalledTimes(1));
    expect(applyHeldRemovals).toHaveBeenCalledWith('project-1', 250);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(clearEmbeddings).not.toHaveBeenCalled();
  });

  it('a refused release (folder changed) keeps the dialog open with the reason', async () => {
    getIndexingStatus.mockResolvedValue(heldStatus);
    applyHeldRemovals.mockRejectedValueOnce(
      new Error('The folder changed: 300 files are missing now, not 250 — nothing was removed')
    );
    render(<EmbeddingsSection projectId="project-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Remove 250 missing files/ }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Remove 250 missing files' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/folder changed/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
