import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { embeddingWorkState } from '@desktop/utils/embeddingWorkState';
import { StatusBar } from '../StatusBar';
import { StatusBarProvider } from '../StatusBarContext';
import { EmbeddingSlot } from './EmbeddingSlot';

const apiMocks = vi.hoisted(() => ({ getMaintenanceStatus: vi.fn() }));

vi.mock('@desktop/utils/api', () => ({
  embeddingsApi: { getMaintenanceStatus: apiMocks.getMaintenanceStatus },
}));

const idleStatus = {
  running: false,
  jobId: null,
  operation: null,
  modelId: null,
  providerId: null,
  modelKey: null,
  requestedNodeType: null,
  startedAt: null,
  finishedAt: null,
  cancelledAt: null,
  cancelRequested: false,
  total: 0,
  processed: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  deleted: 0,
  estimatedTokensTotal: 0,
  estimatedTokensProcessed: 0,
  currentNodeType: null,
  currentNodeId: null,
  lastError: null,
};

const renderSlot = () =>
  render(
    <StatusBarProvider>
      <EmbeddingSlot />
      <StatusBar />
    </StatusBarProvider>
  );

describe('EmbeddingSlot', () => {
  beforeEach(async () => {
    apiMocks.getMaintenanceStatus.mockResolvedValue(idleStatus);
    embeddingWorkState.finishEmbed('doc-1', 'doc');
    embeddingWorkState.finishEmbed('doc-1', 'task');
    await embeddingWorkState.refreshMaintenance();
  });

  afterEach(() => vi.clearAllMocks());

  it('shows a muted idle chip and lists a manual embed while it is active', async () => {
    renderSlot();
    expect(await screen.findByRole('button', { name: '0 embeddings' })).toHaveAttribute(
      'title',
      'No embeddings in progress'
    );

    act(() => embeddingWorkState.startEmbed('doc-1', 'doc', 'Quarterly plan'));
    const active = await screen.findByRole('button', { name: 'Embedding' });
    fireEvent.click(active);
    expect(screen.getByText('Embedding Quarterly plan')).toBeInTheDocument();
    expect(screen.getByText(/doc · \d+s elapsed/)).toBeInTheDocument();
  });

  it('tracks same-ID nodes of different types independently', async () => {
    renderSlot();

    act(() => {
      embeddingWorkState.startEmbed('doc-1', 'doc', 'Document title');
      embeddingWorkState.startEmbed('doc-1', 'task', 'Task title');
      embeddingWorkState.finishEmbed('doc-1', 'doc');
    });

    const active = await screen.findByRole('button', { name: 'Embedding' });
    fireEvent.click(active);
    expect(screen.queryByText('Embedding Document title')).not.toBeInTheDocument();
    expect(screen.getByText('Embedding Task title')).toBeInTheDocument();
    expect(screen.getByText(/task · \d+s elapsed/)).toBeInTheDocument();
  });

  it('shows maintenance progress and errors', async () => {
    apiMocks.getMaintenanceStatus.mockResolvedValue({
      ...idleStatus,
      running: true,
      operation: 'backfill',
      startedAt: new Date().toISOString(),
      total: 500,
      processed: 142,
      succeeded: 139,
      failed: 3,
      currentNodeType: 'doc',
      currentNodeId: 'doc-current',
    });

    renderSlot();
    const active = await screen.findByRole('button', { name: 'Embedding' });
    fireEvent.click(active);
    await waitFor(() => expect(screen.getByText('Backfill')).toBeInTheDocument());
    expect(screen.getByText('142/500 processed')).toBeInTheDocument();
    expect(screen.getByText('3 errors')).toBeInTheDocument();
    expect(screen.getByText('Embedding doc doc-current')).toBeInTheDocument();
  });

  it('counts a single failure as one error, not "1 errors"', async () => {
    apiMocks.getMaintenanceStatus.mockResolvedValue({
      ...idleStatus,
      running: true,
      operation: 'backfill',
      startedAt: new Date().toISOString(),
      total: 10,
      processed: 4,
      succeeded: 3,
      failed: 1,
    });

    renderSlot();
    fireEvent.click(await screen.findByRole('button', { name: 'Embedding' }));
    await waitFor(() => expect(screen.getByText('Backfill')).toBeInTheDocument());
    expect(screen.getByText('1 error')).toBeInTheDocument();
  });
});
