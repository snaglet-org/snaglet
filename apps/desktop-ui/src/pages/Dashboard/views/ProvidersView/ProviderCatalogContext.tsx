import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { modelsApi, providersApi, type ModelRow, type Provider } from '@desktop/utils/api';
import { subscribeModelsChanged } from '@desktop/utils/modelEvents';
import { getErrorMessage, sortModels } from '@snaglet/shared/utils';

interface ProviderCatalogContextValue {
  providers: Provider[];
  models: ModelRow[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const ProviderCatalogContext = createContext<ProviderCatalogContextValue | null>(null);

function sortProviders(providers: Provider[]): Provider[] {
  return [...providers].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)
  );
}

/**
 * Shared provider/model catalog for the activity tree and any open provider
 * pane, models in picker order. Model mutations and `models.changed` events
 * (models imported in the background after a key is saved or tested) refresh
 * it, so discoveries appear in the sidebar without a page reload.
 */
export const ProviderCatalogProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextProviders, nextModels] = await Promise.all([
        providersApi.list(),
        modelsApi.list(),
      ]);
      setProviders(sortProviders(nextProviders));
      setModels(sortModels(nextModels));
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not load providers'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeModelsChanged(() => void refresh());
  }, [refresh]);

  const value = useMemo(
    () => ({ providers, models, loading, error, refresh }),
    [providers, models, loading, error, refresh]
  );

  return (
    <ProviderCatalogContext.Provider value={value}>{children}</ProviderCatalogContext.Provider>
  );
};

export function useProviderCatalog(): ProviderCatalogContextValue {
  const value = useContext(ProviderCatalogContext);
  if (!value) {
    throw new Error('useProviderCatalog must be used inside ProviderCatalogProvider');
  }
  return value;
}
