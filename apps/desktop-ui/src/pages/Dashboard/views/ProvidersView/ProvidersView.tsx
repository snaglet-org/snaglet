import { type FC } from 'react';
import type { ProviderCredential } from '@desktop/utils/api';
import { useProviders } from './Providers/hooks/useProviders';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import { DetailPanel, type ConnectVia } from './Providers/components/DetailPanel/DetailPanel';
import { IntegrationDetailPanel } from './Providers/components/IntegrationDetailPanel/IntegrationDetailPanel';
import { isMultiField } from './Providers/utils';
import { useProviderCatalog } from './ProviderCatalogContext';
import styles from './ProvidersView.module.scss';

interface ProvidersViewProps {
  providerId?: string | null;
  focusModelId?: string | null;
  /** Leave out the Models section (the Get started pane shows only how to connect). */
  hideModels?: boolean;
  /** Which ways to connect the panel offers (default: all). */
  connectVia?: ConnectVia;
  /** A connection test passed for this provider. */
  onVerified?: (providerId: string) => void;
  /** The saved credentials changed and were read again. */
  onCredentialsChanged?: (credentials: ProviderCredential[]) => void;
}

export const ProvidersView: FC<ProvidersViewProps> = ({
  providerId = null,
  focusModelId = null,
  hideModels = false,
  connectVia = 'all',
  onVerified,
  onCredentialsChanged,
}) => {
  const { refresh: refreshCatalog } = useProviderCatalog();
  const {
    providers,
    fallbacks,
    loading,
    error,
    selectedProviderId,
    savingProviderId,
    togglingProviderId,
    retestStates,
    verifyStates,
    providerModels,
    usedModelIds,
    getDraft,
    getDefaultAuthTypeId,
    patchDraft,
    applyJsonPaste,
    credentialsForProvider,
    testCredential,
    saveCredential,
    importCliCredential,
    claudeCodeLogin,
    startClaudeCodeLogin,
    cancelClaudeCodeLogin,
    retestCredential,
    disconnectCredential,
    setProviderEnabled,
    moveCredential,
    editCredential,
    addModel,
    updateModel,
    removeModel,
    discoverModels,
    importModels,
  } = useProviders({
    providerId,
    onCatalogChange: refreshCatalog,
    onVerified,
    onCredentialsChanged,
  });

  const selectedProvider = selectedProviderId
    ? (providers.find((p) => p.id === selectedProviderId) ?? null)
    : null;

  if (loading) {
    return (
      <div className={styles.shell}>
        <StateHint>Loading providers…</StateHint>
      </div>
    );
  }

  // Build derived values for the selected provider
  const draft = selectedProvider ? getDraft(selectedProvider) : null;
  const selectedAuthType =
    selectedProvider && draft
      ? (selectedProvider.authTypes.find((a) => a.id === draft.authTypeId) ??
        selectedProvider.authTypes[0])
      : undefined;
  const verify = selectedProvider
    ? (verifyStates[selectedProvider.id] ?? { status: 'idle', message: '' })
    : { status: 'idle' as const, message: '' };
  const provCreds = selectedProvider ? credentialsForProvider(selectedProvider.id) : [];

  return (
    <div className={styles.shell}>
      {selectedProvider && draft ? (
        <div className={styles.detailWrapper}>
          {selectedProvider.type === 'integration' ? (
            <IntegrationDetailPanel
              provider={selectedProvider}
              providerCredentials={provCreds}
              draft={draft}
              selectedAuthType={selectedAuthType}
              multiField={isMultiField(selectedAuthType)}
              verify={verify}
              error={error}
              isTesting={verify.status === 'testing'}
              isSaving={savingProviderId === selectedProvider.id}
              isTogglingEnabled={togglingProviderId === selectedProvider.id}
              retestStates={retestStates}
              onPatchDraft={(patch) =>
                patchDraft(selectedProvider.id, patch, getDefaultAuthTypeId(selectedProvider))
              }
              onApplyJsonPaste={(fields, json) => applyJsonPaste(selectedProvider, fields, json)}
              onTest={() => testCredential(selectedProvider, selectedAuthType)}
              onSave={() => saveCredential(selectedProvider)}
              onRetest={retestCredential}
              onDelete={disconnectCredential}
              onEnabledChange={(enabled) => setProviderEnabled(selectedProvider.id, enabled)}
              onEditCredential={editCredential}
            />
          ) : (
            <DetailPanel
              provider={selectedProvider}
              providerCredentials={provCreds}
              fallbacks={fallbacks}
              models={providerModels}
              usedModelIds={usedModelIds}
              draft={draft}
              selectedAuthType={selectedAuthType}
              multiField={isMultiField(selectedAuthType)}
              verify={verify}
              error={error}
              isTesting={verify.status === 'testing'}
              isSaving={savingProviderId === selectedProvider.id}
              retestStates={retestStates}
              onPatchDraft={(patch) =>
                patchDraft(selectedProvider.id, patch, getDefaultAuthTypeId(selectedProvider))
              }
              onApplyJsonPaste={(fields, json) => applyJsonPaste(selectedProvider, fields, json)}
              onTest={() => testCredential(selectedProvider, selectedAuthType)}
              onSave={() => saveCredential(selectedProvider)}
              onImportCli={
                selectedProvider.id === 'codex' ? () => importCliCredential('codex') : undefined
              }
              claudeCodeLogin={claudeCodeLogin}
              onStartClaudeCodeLogin={() => void startClaudeCodeLogin()}
              onCancelClaudeCodeLogin={() => void cancelClaudeCodeLogin()}
              onRetest={retestCredential}
              onDelete={disconnectCredential}
              onMoveCredential={moveCredential}
              onEditCredential={editCredential}
              onAddModel={addModel}
              onUpdateModel={updateModel}
              onRemoveModel={removeModel}
              onDiscoverModels={discoverModels}
              onImportModels={importModels}
              focusModelId={focusModelId}
              hideModels={hideModels}
              connectVia={connectVia}
            />
          )}
        </div>
      ) : (
        <div className={styles.emptyState}>
          {/* With no providers loaded there is nothing to select; say why. */}
          {error ? (
            <span role="alert">{error}</span>
          ) : (
            <span>Select a provider from the Providers activity bar.</span>
          )}
        </div>
      )}
    </div>
  );
};
