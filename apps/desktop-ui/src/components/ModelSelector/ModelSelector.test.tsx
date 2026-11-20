import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelData } from './ModelSelector';

const api = vi.hoisted(() => ({
  providers: vi.fn(),
  models: vi.fn(),
  credentials: vi.fn(),
}));

vi.mock('@desktop/utils/api/providers.js', () => ({
  providersApi: { list: api.providers, listCredentials: api.credentials },
}));
vi.mock('@desktop/utils/api/models.js', () => ({
  modelsApi: { list: api.models },
}));

const provider = { id: 'anthropic', type: 'llm', name: 'Anthropic' };
const model = (id: string) => ({ id, providerId: 'anthropic', modelId: id });
const credential = (id: string) => ({ id, providerId: 'anthropic', name: id });

describe('useModelData', () => {
  beforeEach(() => {
    api.providers.mockResolvedValue([provider]);
    api.models.mockResolvedValue([model('claude-sonnet-4-5')]);
    api.credentials.mockResolvedValue([credential('cred-1')]);
  });

  it('revalidates on every mount so options added in the Providers pane appear', async () => {
    const first = renderHook(() => useModelData());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.credentials).toHaveLength(1);
    first.unmount();

    // A new credential and model are saved in the Providers pane…
    api.credentials.mockResolvedValue([credential('cred-1'), credential('cred-2')]);
    api.models.mockResolvedValue([model('claude-sonnet-4-5'), model('claude-opus-5')]);

    // …then the user navigates to agent settings: the selector must refetch,
    // not serve the session-old cache (the original bug).
    const second = renderHook(() => useModelData());
    // Cached options render immediately — no loading flash on remount.
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.credentials).toHaveLength(1);
    await waitFor(() => expect(second.result.current.credentials).toHaveLength(2));
    expect(second.result.current.models).toHaveLength(2);
  });

  it('keeps the cached options when a revalidation fails', async () => {
    const seeded = renderHook(() => useModelData());
    await waitFor(() => expect(seeded.result.current.loading).toBe(false));
    seeded.unmount();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.providers.mockRejectedValue(new Error('server down'));
    const remount = renderHook(() => useModelData());
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(remount.result.current.loading).toBe(false);
    expect(remount.result.current.credentials.length).toBeGreaterThan(0);
    consoleError.mockRestore();
  });
});
