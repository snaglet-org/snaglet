import React, { useEffect, useRef, useState } from 'react';
import type {
  Provider,
  ProviderCredential,
  MetadataField,
  ProviderAuthType,
} from '@desktop/utils/api';
import type { CredentialDraft, VerifyState, RetestState } from '../../types';
import { ProviderIcon } from '@desktop/components/ProviderIcon';
import { Button, Stack, Section } from '@desktop/components';
import { Switch } from '@desktop/components/controls/Switch/Switch';
import { CredentialRow } from '../CredentialRow/CredentialRow';
import { AddCredentialForm } from '../AddCredentialForm/AddCredentialForm';
import styles from './IntegrationDetailPanel.module.scss';

interface IntegrationDetailPanelProps {
  provider: Provider;
  providerCredentials: ProviderCredential[];
  draft: CredentialDraft;
  selectedAuthType: ProviderAuthType | undefined;
  multiField: boolean;
  verify: VerifyState;
  error?: string | null;
  isTesting: boolean;
  isSaving: boolean;
  isTogglingEnabled: boolean;
  retestStates: Record<string, RetestState>;
  onPatchDraft: (patch: Partial<CredentialDraft>) => void;
  onApplyJsonPaste: (fields: MetadataField[], json: string) => void;
  onTest: () => void;
  onSave: () => void;
  onRetest: (credentialId: string) => void;
  onDelete: (credentialId: string) => void;
  onEnabledChange: (enabled: boolean) => void;
  onEditCredential: (
    credentialId: string,
    patch: { label?: string; secret?: string; metadata?: Record<string, unknown> }
  ) => void;
}

export const IntegrationDetailPanel: React.FC<IntegrationDetailPanelProps> = ({
  provider,
  providerCredentials,
  draft,
  selectedAuthType,
  multiField,
  verify,
  error,
  isTesting,
  isSaving,
  isTogglingEnabled,
  retestStates,
  onPatchDraft,
  onApplyJsonPaste,
  onTest,
  onSave,
  onRetest,
  onDelete,
  onEnabledChange,
  onEditCredential,
}) => {
  const hasCredentials = providerCredentials.length > 0;
  const [showForm, setShowForm] = useState(!hasCredentials);
  const [highlightCredId, setHighlightCredId] = useState<string | null>(null);
  const credRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // When a Google OAuth round-trip just completed, the parent's credential list
  // refresh is async — wait for the row to appear, then scroll it into view and
  // clear the highlight after the flash animation finishes.
  useEffect(() => {
    if (!highlightCredId) return;
    const row = credRefs.current[highlightCredId];
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setHighlightCredId(null), 1800);
    return () => clearTimeout(t);
  }, [highlightCredId, providerCredentials]);

  const getAuthTypeLabel = (credential: ProviderCredential) =>
    provider.authTypes.find((a) => a.id === credential.authTypeId)?.name ?? credential.authTypeId;

  const subtitle = provider.description || `Connect ${provider.name} so agents can use its tools.`;

  return (
    <div className={styles.detail}>
      {/* The title strip keeps provider identity and the integration switch;
          credential state is already visible in the body below. */}
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <ProviderIcon providerId={provider.id} size={22} />
          <h2 className={styles.name}>{provider.name}</h2>
          <div className={styles.headerControls}>
            <Switch
              checked={provider.enabled}
              disabled={isTogglingEnabled}
              size="md"
              aria-label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
              onChange={onEnabledChange}
            />
            {provider.website && (
              <a className={styles.link} href={provider.website} target="_blank" rel="noreferrer">
                ↗
              </a>
            )}
          </div>
        </div>
        <p className={styles.subtitle}>{subtitle}</p>
      </div>

      <Stack className={styles.body} gap={4}>
        <Section
          label="Credentials"
          actions={
            <Button
              variant="neutral"
              size="md"
              aria-pressed={showForm}
              onClick={() => setShowForm((v) => !v)}
            >
              {showForm ? '− Close' : '+ Add'}
            </Button>
          }
        >
          {showForm && (
            <div className={styles.addCard}>
              <AddCredentialForm
                provider={provider}
                draft={draft}
                selectedAuthType={selectedAuthType}
                multiField={multiField}
                verify={verify}
                error={error}
                isTesting={isTesting}
                isSaving={isSaving}
                onPatchDraft={onPatchDraft}
                onApplyJsonPaste={onApplyJsonPaste}
                onTest={onTest}
                onSave={onSave}
                onGoogleConnected={(credId) => {
                  // Google credential already persisted server-side. Refresh
                  // the credential list, collapse the form so the new row is
                  // visible, and mark it for scroll + flash highlight.
                  onSave();
                  setShowForm(false);
                  setHighlightCredId(credId);
                }}
              />
            </div>
          )}

          {!hasCredentials && !showForm && (
            <p className={styles.emptyCard}>
              No credentials yet. Click <strong>+ Add</strong> to connect {provider.name}.
            </p>
          )}

          {hasCredentials && (
            <div className={styles.credList}>
              {providerCredentials.map((cred) => (
                <div
                  key={cred.id}
                  ref={(el) => {
                    credRefs.current[cred.id] = el;
                  }}
                  className={highlightCredId === cred.id ? styles.credRowHighlight : undefined}
                >
                  <CredentialRow
                    credential={cred}
                    authTypeLabel={getAuthTypeLabel(cred)}
                    authType={provider.authTypes.find((a) => a.id === cred.authTypeId)}
                    isPrimary={false}
                    isFallback={false}
                    retestState={retestStates[cred.id]}
                    onEdit={(patch) => onEditCredential(cred.id, patch)}
                    onRetest={() => onRetest(cred.id)}
                    onDelete={() => onDelete(cred.id)}
                  />
                </div>
              ))}
            </div>
          )}
        </Section>
      </Stack>
    </div>
  );
};
