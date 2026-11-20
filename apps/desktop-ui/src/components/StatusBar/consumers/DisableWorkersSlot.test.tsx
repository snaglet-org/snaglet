import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerStatusResponse } from '@desktop/utils/api';
import { StatusBar } from '../StatusBar';
import { StatusBarProvider } from '../StatusBarContext';
import { DisableWorkersSlot } from './DisableWorkersSlot';

// Mock the workers API surface the slot touches.
const status = vi.fn();
const savePolicy = vi.fn();
vi.mock('@desktop/utils/api', () => ({
  workersApi: {
    status: () => status(),
    savePolicy: (patch: Record<string, boolean>) => savePolicy(patch),
  },
}));

function statusResponse(over: Partial<WorkerStatusResponse['policy']> = {}): WorkerStatusResponse {
  return {
    policy: {
      hooksEnabled: true,
      embeddingsEnabled: true,
      envEnabled: true,
      mode: 'auto',
      ...over,
    },
  } as WorkerStatusResponse;
}

const renderSlot = () =>
  render(
    <StatusBarProvider>
      <DisableWorkersSlot />
      <StatusBar />
    </StatusBarProvider>
  );

beforeEach(() => {
  status.mockReset();
  savePolicy.mockReset();
});
afterEach(() => vi.clearAllTimers());

describe('DisableWorkersSlot', () => {
  it('opens a popover with both disable switches', async () => {
    status.mockResolvedValue(statusResponse());
    renderSlot();
    // The bar shows a "Workers" toggle button.
    const button = await screen.findByText('Workers');
    fireEvent.click(button);
    expect(screen.getByLabelText('Disable scripts')).toBeInTheDocument();
    expect(screen.getByLabelText('Disable background embeddings workers')).toBeInTheDocument();
  });

  it('reflects a disabled process as a checked "Disable" box', async () => {
    status.mockResolvedValue(statusResponse({ hooksEnabled: false }));
    renderSlot();
    fireEvent.click(await screen.findByText('Workers'));
    await waitFor(() => {
      expect(screen.getByLabelText('Disable scripts')).toBeChecked();
    });
    // embeddings still enabled → its "Disable" box is unchecked.
    expect(screen.getByLabelText('Disable background embeddings workers')).not.toBeChecked();
  });

  it('checking "Disable scripts" persists hooksEnabled:false (inverted)', async () => {
    status.mockResolvedValue(statusResponse());
    savePolicy.mockResolvedValue({
      hooksEnabled: false,
      embeddingsEnabled: true,
      envEnabled: true,
      mode: 'auto',
    });
    renderSlot();
    fireEvent.click(await screen.findByText('Workers'));
    fireEvent.click(screen.getByLabelText('Disable scripts'));
    await waitFor(() => {
      expect(savePolicy).toHaveBeenCalledWith({ hooksEnabled: false });
    });
  });

  it('disables the switches when background work is off at the environment level', async () => {
    status.mockResolvedValue(statusResponse({ envEnabled: false }));
    renderSlot();
    fireEvent.click(await screen.findByText('Workers'));
    await waitFor(() => {
      expect(screen.getByLabelText('Disable scripts')).toBeDisabled();
    });
    expect(screen.getByLabelText('Disable background embeddings workers')).toBeDisabled();
  });
});

it('keeps a saved switch when a status read that began before the save lands after it', async () => {
  vi.useFakeTimers();
  try {
    let landStale: (value: WorkerStatusResponse) => void = () => {};
    status.mockResolvedValueOnce(statusResponse());
    status.mockImplementationOnce(
      () =>
        new Promise<WorkerStatusResponse>((resolve) => {
          landStale = resolve;
        })
    );
    savePolicy.mockResolvedValue(statusResponse({ hooksEnabled: false }).policy);
    renderSlot();
    await act(async () => {});
    fireEvent.click(screen.getByText('Workers'));
    // The 5s poll goes out and is still in flight when the switch is saved.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    fireEvent.click(screen.getByLabelText('Disable scripts'));
    await act(async () => {});
    expect(screen.getByLabelText('Disable scripts')).toBeChecked();

    await act(async () => landStale(statusResponse()));
    expect(screen.getByLabelText('Disable scripts')).toBeChecked();
  } finally {
    vi.useRealTimers();
  }
});

it('distinguishes the automatic environment gate from enabled worker switches', async () => {
  status.mockResolvedValue({ ...statusResponse(), automaticLocalIntelligenceEnabled: false });
  renderSlot();
  fireEvent.click(await screen.findByText('Workers'));
  expect(
    await screen.findByText(/Automatic indexing is off in this environment/)
  ).toBeInTheDocument();
  expect(screen.getByLabelText('Disable background embeddings workers')).not.toBeChecked();
});

it('opens actual worker switches from the embeddings pane link', async () => {
  status.mockResolvedValue(statusResponse());
  renderSlot();
  await screen.findByText('Workers');
  act(() => window.dispatchEvent(new Event('snaglet:open-worker-controls')));
  expect(screen.getByLabelText('Disable background embeddings workers')).toBeInTheDocument();
});
