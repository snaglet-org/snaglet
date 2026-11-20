import { useEffect, useState } from 'react';
import { sortModels } from '@snaglet/shared/utils';
import { providersApi } from '@desktop/utils/api/providers';
import { modelsApi } from '@desktop/utils/api/models';
import { subscribeModelsChanged } from '@desktop/utils/modelEvents';
import type { Provider, ProviderCredential, ModelRow } from '@desktop/utils/api/types';

interface ModelData {
  providers: Provider[];
  models: ModelRow[];
  credentials: ProviderCredential[];
  loading: boolean;
}

// Stale-while-revalidate: the cache exists only so a remount renders instantly
// without a loading flash. It is never trusted as current: every mount
// refetches, and so do a model catalog change (`models.changed`, e.g. models
// imported in the background after a key is saved) and the window regaining
// focus while a selector is shown (agent settings, thread agent settings,
// utility overrides and the Get started model step all read through here).
let cachedData: ModelData | null = null;
let inFlight: Promise<void> | null = null;
// Only the newest read lands, so a slow read can never replace a newer list.
let readTicket = 0;
const listeners = new Set<(data: ModelData) => void>();
let stopListening: (() => void) | null = null;

/**
 * Read providers, models (in picker order) and credentials, then hand the
 * result to every mounted selector. A read already under way is shared unless
 * `fresh` asks for a new one because the catalog changed after it started.
 */
function loadModelData(fresh = false): Promise<void> {
  if (inFlight && !fresh) return inFlight;
  const ticket = ++readTicket;
  const request = Promise.all([
    providersApi.list(),
    modelsApi.list(),
    providersApi.listCredentials(),
  ])
    .then(([providers, models, credentials]) => {
      if (ticket !== readTicket) return;
      const data = {
        providers: providers.filter((provider) => provider.type === 'llm'),
        models: sortModels(models),
        credentials,
        loading: false,
      };
      cachedData = data;
      for (const listener of listeners) listener(data);
    })
    .catch((error: unknown) => {
      // Keep whatever was rendered from cache; a failed revalidation must not
      // blank working options or strand a spinner.
      console.error('[ModelSelector] refreshing provider/model options failed', error);
      const cached = cachedData;
      if (cached) for (const listener of listeners) listener(cached);
    })
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
  return request;
}

/** Read the lists again now, e.g. when the person picks another provider. */
export function refreshModelData(): void {
  void loadModelData(true);
}

function listen(listener: (data: ModelData) => void): () => void {
  listeners.add(listener);
  if (!stopListening) {
    const unsubscribe = subscribeModelsChanged(refreshModelData);
    window.addEventListener('focus', refreshModelData);
    stopListening = () => {
      unsubscribe();
      window.removeEventListener('focus', refreshModelData);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopListening) {
      stopListening();
      stopListening = null;
    }
  };
}

export function useModelData(): ModelData {
  const [data, setData] = useState<ModelData>(
    cachedData ?? { providers: [], models: [], credentials: [], loading: true }
  );

  useEffect(() => {
    const stop = listen(setData);
    void loadModelData();
    return stop;
  }, []);

  return data;
}
