import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DiscoveryResult } from '@desktop/utils/api';
import { DiscoverPanel } from './DiscoverPanel';

const discovered = (modelIds: string[], alreadyImported = false): DiscoveryResult => ({
  providerId: 'anthropic',
  models: modelIds.map((modelId) => ({
    modelId,
    displayName: modelId,
    alreadyImported,
  })) as DiscoveryResult['models'],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiscoverPanel failed imports', () => {
  it('keeps the discovered list and the selection when the import is refused', async () => {
    const onDiscover = vi.fn().mockResolvedValue(discovered(['model-a', 'model-b']));
    const onImport = vi.fn().mockResolvedValue(false);
    render(<DiscoverPanel providerId="anthropic" onDiscover={onDiscover} onImport={onImport} />);

    fireEvent.click(screen.getByRole('button', { name: 'Discover models' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2' }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    // The list stays open with both models still checked so Import can be retried.
    expect(await screen.findByRole('button', { name: 'Import 2' })).toBeInTheDocument();
    expect(screen.getAllByText('model-a').length).toBeGreaterThan(0);
  });

  it('closes the list after a successful import', async () => {
    const onDiscover = vi.fn().mockResolvedValue(discovered(['model-a']));
    const onImport = vi.fn().mockResolvedValue(true);
    render(<DiscoverPanel providerId="anthropic" onDiscover={onDiscover} onImport={onImport} />);

    fireEvent.click(screen.getByRole('button', { name: 'Discover models' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Import \d/ })).not.toBeInTheDocument()
    );
  });

  it('does not report a refused metadata refresh as success', async () => {
    const onDiscover = vi.fn().mockResolvedValue(discovered(['model-a'], true));
    const onImport = vi.fn().mockResolvedValue(false);
    render(<DiscoverPanel providerId="anthropic" onDiscover={onDiscover} onImport={onImport} />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh metadata' }));

    expect(await screen.findByText(/Refresh failed/)).toBeInTheDocument();
    expect(screen.queryByText(/Refreshed metadata/)).not.toBeInTheDocument();
  });
});

describe('DiscoverPanel after removing stale models', () => {
  const withStale = (modelIds: string[]): DiscoveryResult => ({
    ...discovered(modelIds),
    providerId: 'ollama',
    staleModels: [{ id: 'row-1', modelId: 'gone', name: 'Gone model' }],
  });

  it('ignores the re-read that follows a removal when a newer discovery has run since', async () => {
    const reread = deferred<DiscoveryResult>();
    const second = deferred<DiscoveryResult>();
    const onDiscover = vi
      .fn()
      .mockResolvedValueOnce(withStale(['kept']))
      .mockReturnValueOnce(reread.promise)
      .mockReturnValueOnce(second.promise);
    const onRemoveModels = vi.fn().mockResolvedValue(undefined);
    render(
      <DiscoverPanel
        providerId="ollama"
        onDiscover={onDiscover}
        onImport={vi.fn()}
        onRemoveModels={onRemoveModels}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Discover models' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Gone model/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1' }));
    await waitFor(() => expect(onDiscover).toHaveBeenCalledTimes(2)); // the re-read is pending

    fireEvent.click(screen.getByRole('button', { name: /Hide discovered/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Discover models' })); // newer discovery
    second.resolve(discovered(['newer-model']));
    expect(await screen.findAllByText('newer-model')).not.toHaveLength(0);

    reread.resolve(discovered(['older-model']));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getAllByText('newer-model')).not.toHaveLength(0);
    expect(screen.queryByText('older-model')).not.toBeInTheDocument();
  });
});
