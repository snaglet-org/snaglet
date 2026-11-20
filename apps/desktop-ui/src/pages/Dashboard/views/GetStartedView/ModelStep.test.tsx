/**
 * The Get started "Choose a model" step lists the provider's models without a
 * reload: saving a key imports the provider's models in the background, the
 * server announces `models.changed`, and the step's picker reads the list
 * again. The list shows newest first, with an alias and its dated snapshot
 * labeled apart. The real picker and model-data hook run; only the REST calls
 * are stubbed.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ModelRow, Provider, ProviderCredential } from '@desktop/utils/api';
import { emitModelsChanged } from '@desktop/utils/modelEvents';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const server = vi.hoisted(() => ({
  providers: [] as Provider[],
  credentials: [] as ProviderCredential[],
  models: [] as Array<Partial<ModelRow>>,
}));

vi.mock('@desktop/utils/api/providers', () => ({
  providersApi: {
    list: async () => server.providers,
    listCredentials: async () => server.credentials,
  },
}));
vi.mock('@desktop/utils/api/models', () => ({
  modelsApi: { list: async () => server.models },
}));
vi.mock('../../selection/DashboardNavigationContext', () => ({
  useDashboardNavigation: () => null,
}));

import { ModelStep } from './ModelStep';

const anthropic: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  description: '',
  website: null,
  apiDocs: null,
  baseUrl: null,
  type: 'llm',
  enabled: true,
  sortOrder: 0,
  primaryCredentialId: 'cred-1',
  authTypes: [],
  defaultMetadata: {},
};

const key: ProviderCredential = {
  id: 'cred-1',
  providerId: 'anthropic',
  authTypeId: 'anthropic:api-key',
  authType: 'api_key',
  label: 'Test key',
  hasSecret: true,
  updatedAt: '2026-11-19T00:00:00Z',
  verificationStatus: 'ok',
};

const model = (modelId: string, displayName: string): Partial<ModelRow> => ({
  id: `anthropic:${modelId}`,
  providerId: 'anthropic',
  modelId,
  displayName,
  sortOrder: 999,
});

const patty = {
  id: 'patty',
  name: 'Patty',
  provider: 'anthropic',
  modelId: 'claude-fable-5',
  credentialId: 'cred-1',
} as unknown as SnagletAgent;

function renderStep() {
  return render(
    <ModelStep
      provider={{ kind: 'ready', providerId: 'anthropic' }}
      providers={[anthropic]}
      credentials={[key]}
      status="ready"
      error={null}
      agents={[patty]}
      others={[]}
      suggestion={null}
      saveModel={vi.fn(async () => {})}
    />
  );
}

const optionLabels = () =>
  [...(screen.getByLabelText('Model') as HTMLSelectElement).options].map((o) => o.textContent);

describe('ModelStep — the model list follows the catalog', () => {
  beforeEach(() => {
    server.providers = [anthropic];
    server.credentials = [key];
    // The built-in catalog before the key's models are imported, in database order.
    server.models = [
      model('claude-opus-4-5', 'Claude Opus 4.5'),
      model('claude-fable-5', 'Claude Fable 5'),
      model('claude-opus-4-5-20251101', 'Claude Opus 4.5'),
      model('claude-opus-5', 'Claude Opus 5'),
    ];
  });

  it('shows models imported in the background as soon as models.changed arrives', async () => {
    renderStep();
    await waitFor(() =>
      expect(optionLabels()).toEqual([
        'Claude Fable 5',
        'Claude Opus 5',
        'Claude Opus 4.5',
        'Claude Opus 4.5 (20251101)',
      ])
    );

    // Discovery imports the current generation after the key is saved.
    server.models = [
      ...server.models,
      model('claude-fable-5-1', 'Claude Fable 5.1'),
      model('claude-fable-5-2', 'Claude Fable 5.2'),
      model('claude-opus-5-5', 'Claude Opus 5.5'),
    ];
    act(() => emitModelsChanged());

    await waitFor(() =>
      expect(optionLabels()).toEqual([
        'Claude Fable 5.2',
        'Claude Fable 5.1',
        'Claude Fable 5',
        'Claude Opus 5.5',
        'Claude Opus 5',
        'Claude Opus 4.5',
        'Claude Opus 4.5 (20251101)',
      ])
    );
    // Patty keeps her model selected.
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('claude-fable-5');
  });

  it('reads the list again when the window regains focus', async () => {
    renderStep();
    await waitFor(() => expect(optionLabels()).toHaveLength(4));

    server.models = [...server.models, model('claude-fable-5-2', 'Claude Fable 5.2')];
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(optionLabels()[0]).toBe('Claude Fable 5.2'));
  });
});
