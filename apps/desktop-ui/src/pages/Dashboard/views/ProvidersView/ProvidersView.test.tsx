import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const LOAD_ERROR = 'Could not load providers — is the server running?';

vi.mock('./Providers/hooks/useProviders', () => ({
  useProviders: () => ({
    providers: [],
    fallbacks: [],
    loading: false,
    error: LOAD_ERROR,
    selectedProviderId: null,
    savingProviderId: null,
    togglingProviderId: null,
    retestStates: {},
    verifyStates: {},
    providerModels: [],
    usedModelIds: new Set<string>(),
  }),
}));
vi.mock('./ProviderCatalogContext', () => ({
  useProviderCatalog: () => ({ refresh: vi.fn() }),
}));

import { ProvidersView } from './ProvidersView';

describe('ProvidersView', () => {
  it('shows why no provider can be selected when the providers fail to load', () => {
    render(<ProvidersView />);

    expect(screen.getByRole('alert')).toHaveTextContent(LOAD_ERROR);
    expect(screen.queryByText(/Select a provider/)).toBeNull();
  });
});
