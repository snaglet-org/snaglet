import React, { Fragment, useState, useCallback, useEffect, useRef } from 'react';
import { FALLBACK_CREDENTIALS_FLAG } from '@snaglet/shared/types';
import { useFeatureFlag } from '@desktop/features/featureFlags/FeatureFlagsContext';
import type {
  Provider,
  ProviderCredential,
  MetadataField,
  ModelRow,
  ProviderAuthType,
  ProviderFallbackCredential,
} from '@desktop/utils/api';
import type {
  CredentialDraft,
  VerifyState,
  RetestState,
  ClaudeCodeLoginFlowState,
} from '../../types';
import { CredentialRow, type CredentialRotationRole } from '../CredentialRow/CredentialRow';
import { AddCredentialForm } from '../AddCredentialForm/AddCredentialForm';
import { ClaudeCodeLoginFlow } from '../ClaudeCodeLoginFlow/ClaudeCodeLoginFlow';
import { GITHUB_DEVICE_FLOW_HINT } from '../CopilotDeviceFlow/CopilotDeviceFlow';
import { ModelsPanel, type AddModelInput } from '../ModelsPanel/ModelsPanel';

import { Button, Stack, Section, Cluster } from '@desktop/components';
import styles from './DetailPanel.module.scss';
import {
  getDeviceFlowAuthType,
  getKeyAuthTypes,
  isKeylessProvider,
  isLocalCredentiallessProvider,
} from '../../utils';

type DropZone = 'primary' | 'fallback' | 'other';
const CREDENTIAL_DRAG_MIME = 'application/x-snaglet-provider-credential';

/** The Keys section opens one panel at a time below its header buttons. */
type KeysPanel = 'github-sign-in' | 'add-key';

/**
 * Which ways to connect a panel offers: all of them (the Providers view),
 * only the provider's sign-in (a subscription card in Get started), or only
 * key entry (an API-key card). It hides buttons; it never changes what they do.
 */
export type ConnectVia = 'all' | 'sign-in' | 'key';

/** Draft fields cleared when a panel switches the draft's auth type. */
const CLEARED_CREDENTIAL: Partial<CredentialDraft> = {
  secret: '',
  metadata: {},
  pasteMode: false,
  jsonPaste: '',
  jsonError: null,
};

interface DetailPanelProps {
  provider: Provider;
  providerCredentials: ProviderCredential[];
  fallbacks: ProviderFallbackCredential[];
  models: ModelRow[];
  usedModelIds: Set<string>;
  focusModelId?: string | null;
  /** Leave out the Models section. */
  hideModels?: boolean;
  /** Which ways to connect the Keys section offers (default: all). */
  connectVia?: ConnectVia;
  draft: CredentialDraft;
  selectedAuthType: ProviderAuthType | undefined;
  multiField: boolean;
  verify: VerifyState;
  error?: string | null;
  isTesting: boolean;
  isSaving: boolean;
  retestStates: Record<string, RetestState>;
  onPatchDraft: (patch: Partial<CredentialDraft>) => void;
  onApplyJsonPaste: (fields: MetadataField[], json: string) => void;
  onTest: () => void;
  onSave: () => void;
  /** One-click local CLI login import (Codex CLI). */
  onImportCli?: () => void;
  /**
   * Claude Code sign-in (Anthropic only). The flow renders in the Keys
   * section when `onStartClaudeCodeLogin` is provided.
   */
  claudeCodeLogin?: ClaudeCodeLoginFlowState;
  onStartClaudeCodeLogin?: () => void;
  onCancelClaudeCodeLogin?: () => void;
  onRetest: (credentialId: string) => void;
  onDelete: (credentialId: string) => void;
  onMoveCredential: (
    credentialId: string,
    currentZone: DropZone,
    targetZone: DropZone
  ) => Promise<void>;
  onEditCredential: (
    credentialId: string,
    patch: { label?: string; secret?: string; metadata?: Record<string, unknown> }
  ) => void;
  onAddModel: (input: AddModelInput) => Promise<boolean>;
  onUpdateModel: (
    modelId: string,
    patch: {
      displayName?: string;
      contextWindowTokens?: number | null;
      maxOutputTokens?: number | null;
    }
  ) => Promise<boolean>;
  onRemoveModel: (modelId: string) => void;
  onDiscoverModels: (providerId: string) => Promise<import('@desktop/utils/api').DiscoveryResult>;
  onImportModels: (
    providerId: string,
    models: import('@desktop/utils/api').BulkModelInput[]
  ) => Promise<boolean>;
}

export const DetailPanel: React.FC<DetailPanelProps> = ({
  provider,
  providerCredentials,
  fallbacks,
  models,
  usedModelIds,
  focusModelId,
  hideModels = false,
  connectVia = 'all',
  draft,
  selectedAuthType,
  multiField,
  verify,
  error,
  isTesting,
  isSaving,
  retestStates,
  onPatchDraft,
  onApplyJsonPaste,
  onTest,
  onSave,
  onImportCli,
  claudeCodeLogin,
  onStartClaudeCodeLogin,
  onCancelClaudeCodeLogin,
  onRetest,
  onDelete,
  onMoveCredential,
  onEditCredential,
  onAddModel,
  onUpdateModel,
  onRemoveModel,
  onDiscoverModels,
  onImportModels,
}) => {
  const [dragOver, setDragOver] = useState<DropZone | null>(null);
  // Reveals the alternate-role drop targets only while a credential is being
  // dragged, so the collapsed Keys list stays clean at rest.
  const [dragActive, setDragActive] = useState(false);
  const [openPanel, setOpenPanel] = useState<KeysPanel | null>(null);
  // Primary/fallback rotation ships dark (`fallback_credentials`, fails closed).
  const rotationUi = useFeatureFlag(FALLBACK_CREDENTIALS_FLAG);

  const primaryCred =
    providerCredentials.find((c) => c.id === provider.primaryCredentialId) ?? null;
  const fallbackCredIds = new Set(fallbacks.map((f) => f.credentialId));

  const getAuthTypeLabel = (credential: ProviderCredential) =>
    provider.authTypes.find((a) => a.id === credential.authTypeId)?.name ?? credential.authTypeId;

  const sortedFallbacks = [...fallbacks].sort((a, b) => a.fallbackIndex - b.fallbackIndex);
  const fallbackCreds = sortedFallbacks
    .map((fb) => providerCredentials.find((c) => c.id === fb.credentialId))
    .filter(Boolean) as ProviderCredential[];

  const otherCreds = providerCredentials.filter(
    (c) => c.id !== provider.primaryCredentialId && !fallbackCredIds.has(c.id)
  );

  const getCredZone = (credId: string): DropZone => {
    if (credId === provider.primaryCredentialId) return 'primary';
    if (fallbackCredIds.has(credId)) return 'fallback';
    return 'other';
  };

  // In-memory mirror of the dragged credential id. Tauri's WKWebView hides
  // DataTransfer payloads at drop time (`getData` returns '' for data the
  // page set at dragstart), which silently broke credential drag-and-drop
  // on the desktop app. Same fix as the node-chip drags (`_activeDragChip`
  // in utils/nodeChip/payload.ts): write the id here at dragstart, fall
  // back to it on drop, clear on dragend so a stale id can't leak into an
  // unrelated drop.
  const dragCredIdRef = useRef<string | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, credId: string) => {
    dragCredIdRef.current = credId;
    try {
      e.dataTransfer.setData(CREDENTIAL_DRAG_MIME, credId);
      e.dataTransfer.setData('text/plain', credId);
    } catch {
      /* WKWebView may throw on setData — the ref fallback covers the drop. */
    }
    e.dataTransfer.effectAllowed = 'move';
    setDragActive(true);
  }, []);

  const handleDragEnd = useCallback(() => {
    dragCredIdRef.current = null;
    setDragActive(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, zone: DropZone) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(zone);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetZone: DropZone) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(null);
      setDragActive(false);
      // Trust the in-memory id first. WKWebView may replace `text/plain` with
      // selected row text even after setData, which made "Not in rotation"
      // drops call the API with a label instead of the credential id.
      let transferredId = '';
      try {
        transferredId =
          e.dataTransfer.getData(CREDENTIAL_DRAG_MIME) || e.dataTransfer.getData('text/plain');
      } catch {
        // The ref is the supported same-page fallback.
      }
      const credId = dragCredIdRef.current || transferredId;
      dragCredIdRef.current = null;
      if (!credId) return;

      const currentZone = getCredZone(credId);
      if (currentZone === targetZone) return;

      await onMoveCredential(credId, currentZone, targetZone);
    },
    [getCredZone, onMoveCredential]
  );

  const changeCredentialRotation = useCallback(
    (credentialId: string, currentZone: DropZone, targetRole: CredentialRotationRole) =>
      onMoveCredential(credentialId, currentZone, targetRole),
    [onMoveCredential]
  );

  const hasCredentials = providerCredentials.length > 0;
  const localConnection = isLocalCredentiallessProvider(provider.id);
  // A provider with nothing to enter (Apple On-Device) shows its state, not a Keys section.
  const keylessConnection = !localConnection && isKeylessProvider(provider);
  const acceptsCredentials =
    !localConnection && !keylessConnection && provider.authTypes.length > 0;
  const signInOffered = connectVia !== 'key';
  const showClaudeCodeLogin =
    signInOffered && provider.id === 'anthropic' && Boolean(onStartClaudeCodeLogin);
  const showCliImport = signInOffered && Boolean(onImportCli);

  // GitHub Copilot: Sign in with GitHub (the OAuth device flow) has its own
  // header button and panel, so Add key offers only the key auth types.
  const deviceFlowAuthType = acceptsCredentials ? getDeviceFlowAuthType(provider) : undefined;
  const showGitHubSignIn = signInOffered && Boolean(deviceFlowAuthType);
  const signInShown = showClaudeCodeLogin || showCliImport || showGitHubSignIn;
  // A sign-in card leaves key entry to the API-key cards, unless the provider
  // has no sign-in to offer.
  const showAddKey = connectVia !== 'sign-in' || !signInShown;
  // The buttons the empty Keys note names. Each panel has one primary action:
  // its sign-in when it offers one, else Add key.
  const connectActions = [
    showClaudeCodeLogin && 'Sign in with Claude Code',
    showCliImport && 'Use local CLI login',
    showGitHubSignIn && 'Sign in with GitHub',
    showAddKey && '+ Add key',
  ].filter((action): action is string => Boolean(action));
  const keyAuthTypes = getKeyAuthTypes(provider);
  const githubSignInOpen = openPanel === 'github-sign-in' && Boolean(deviceFlowAuthType);
  const addKeyOpen = openPanel === 'add-key';
  const keysPanelOpen = githubSignInOpen || addKeyOpen;
  const draftOnKeyAuthType =
    !deviceFlowAuthType || keyAuthTypes.some((authType) => authType.id === draft.authTypeId);

  const moveDraftToKeyAuthType = () => {
    const keyAuthTypeId = keyAuthTypes[0]?.id;
    // Drops any device-flow token so it never shows up as a typed key.
    if (keyAuthTypeId) onPatchDraft({ ...CLEARED_CREDENTIAL, authTypeId: keyAuthTypeId });
  };

  const toggleGitHubSignIn = () => {
    if (githubSignInOpen || !deviceFlowAuthType) {
      setOpenPanel(null);
      return;
    }
    // Every sign-in starts a fresh device flow on the OAuth auth type.
    onPatchDraft({ ...CLEARED_CREDENTIAL, authTypeId: deviceFlowAuthType.id });
    setOpenPanel('github-sign-in');
  };

  const toggleAddKey = () => {
    if (addKeyOpen) {
      setOpenPanel(null);
      return;
    }
    if (!draftOnKeyAuthType) moveDraftToKeyAuthType();
    setOpenPanel('add-key');
  };

  // Leaving the provider closes Sign in with GitHub, so coming back never
  // restarts a device flow nobody asked for.
  useEffect(() => {
    setOpenPanel((panel) => (panel === 'github-sign-in' ? null : panel));
  }, [provider.id]);

  // The Add key form can stay open across a provider switch and land on a
  // Copilot draft a sign-in left on the OAuth type; move it back.
  const addKeyDraftDrifted = addKeyOpen && !draftOnKeyAuthType;
  useEffect(() => {
    if (addKeyDraftDrifted) moveDraftToKeyAuthType();
  }, [addKeyDraftDrifted]);

  // Group labels only appear to disambiguate when more than one role bucket is
  // populated — so the common single-key case reads as one clean row, not a
  // key buried under empty zones.
  const populatedGroups =
    (primaryCred ? 1 : 0) + (fallbackCreds.length > 0 ? 1 : 0) + (otherCreds.length > 0 ? 1 : 0);
  const showGroupLabels = populatedGroups > 1;

  return (
    <div className={styles.detail}>
      {/* The single warm title strip: provider identity, one loud connection
          pill, plain subtitle. */}
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <h2 className={styles.name}>{provider.name}</h2>
          {provider.website && (
            <a className={styles.link} href={provider.website} target="_blank" rel="noreferrer">
              ↗
            </a>
          )}
        </div>
      </div>

      <Stack className={styles.body} gap={4}>
        {localConnection && (
          <Section
            label="Connection"
            actions={
              <Button variant="neutral" size="md" disabled={isTesting} onClick={onTest}>
                {isTesting ? 'Testing…' : 'Test connection'}
              </Button>
            }
          >
            <p className={styles.endpointHelp}>
              No API key is needed. Snaglet connects to your {provider.name} server. Configure a
              different server URL with{' '}
              <code>
                {provider.id === 'ollama' ? 'SNAGLET_OLLAMA_URL' : 'SNAGLET_LM_STUDIO_URL'}
              </code>
              .
            </p>
            {verify.status !== 'idle' && (
              <p role="status">{verify.message || (isTesting ? 'Testing connection…' : '')}</p>
            )}
          </Section>
        )}

        {keylessConnection && (
          <Section label="Connection">
            <p className={styles.endpointHelp} role="status">
              {hasCredentials
                ? 'Connected. No key is needed.'
                : 'Not connected yet. No key is needed: Snaglet connects it by itself when it is available.'}
            </p>
          </Section>
        )}

        {acceptsCredentials && (
          <Section
            label="Keys"
            actions={
              <Cluster gap={2}>
                {showClaudeCodeLogin && (
                  <ClaudeCodeLoginFlow
                    part="actions"
                    state={claudeCodeLogin ?? { status: 'idle', message: null, sessionId: null }}
                    providerCredentials={providerCredentials}
                    onStart={() => onStartClaudeCodeLogin?.()}
                    onCancel={() => onCancelClaudeCodeLogin?.()}
                  />
                )}
                {showCliImport && (
                  <Button
                    variant="primary"
                    size="md"
                    disabled={isSaving}
                    title="Import your local Codex CLI login (~/.codex/auth.json)"
                    onClick={onImportCli}
                  >
                    {isSaving ? 'Importing…' : 'Use local CLI login'}
                  </Button>
                )}
                {showGitHubSignIn && (
                  <Button
                    variant={githubSignInOpen ? 'ghost' : 'primary'}
                    size="md"
                    aria-pressed={githubSignInOpen}
                    title={githubSignInOpen ? undefined : GITHUB_DEVICE_FLOW_HINT}
                    onClick={toggleGitHubSignIn}
                  >
                    {githubSignInOpen ? '− Close' : 'Sign in with GitHub'}
                  </Button>
                )}
                {showAddKey && (
                  <Button
                    variant={addKeyOpen ? 'ghost' : signInShown ? 'neutral' : 'primary'}
                    size="md"
                    aria-pressed={addKeyOpen}
                    onClick={toggleAddKey}
                  >
                    {addKeyOpen ? '− Close' : '+ Add key'}
                  </Button>
                )}
              </Cluster>
            }
          >
            {/* Keep session feedback below the shared connection action row. */}
            {showClaudeCodeLogin && (
              <ClaudeCodeLoginFlow
                part="status"
                state={claudeCodeLogin ?? { status: 'idle', message: null, sessionId: null }}
                providerCredentials={providerCredentials}
                onStart={() => onStartClaudeCodeLogin?.()}
                onCancel={() => onCancelClaudeCodeLogin?.()}
              />
            )}

            {githubSignInOpen && (
              <div className={styles.addCard}>
                <AddCredentialForm
                  githubSignIn
                  provider={provider}
                  draft={draft}
                  selectedAuthType={deviceFlowAuthType}
                  multiField={false}
                  verify={verify}
                  error={error}
                  isTesting={isTesting}
                  isSaving={isSaving}
                  onPatchDraft={onPatchDraft}
                  onApplyJsonPaste={onApplyJsonPaste}
                  onTest={onTest}
                  onSave={onSave}
                />
              </div>
            )}

            {addKeyOpen && (
              <div className={styles.addCard}>
                <AddCredentialForm
                  provider={provider}
                  draft={draft}
                  selectedAuthType={selectedAuthType}
                  authTypes={keyAuthTypes}
                  multiField={multiField}
                  verify={verify}
                  error={error}
                  isTesting={isTesting}
                  isSaving={isSaving}
                  onPatchDraft={onPatchDraft}
                  onApplyJsonPaste={onApplyJsonPaste}
                  onTest={onTest}
                  onSave={onSave}
                  onGoogleConnected={() => {
                    // Credential already persisted server-side — just refresh the list and close the form
                    onSave();
                    setOpenPanel(null);
                  }}
                />
              </div>
            )}

            {!hasCredentials && !keysPanelOpen && connectActions.length > 0 && (
              <p className={styles.emptyCard}>
                No keys yet. Click{' '}
                {connectActions.map((action, index) => (
                  <Fragment key={action}>
                    {index > 0 && ' or '}
                    <strong>{action}</strong>
                  </Fragment>
                ))}{' '}
                to connect one.
              </p>
            )}

            {/* One Keys list: the three role buckets (primary / fallback /
                unassigned) read as a single continuous list. Each row carries
                its own role pill; the alternate drop targets only surface
                while a key is being dragged, so the one-key case reads as a
                single clean row. Moves are zone-based, with a WKWebView drag
                workaround. */}
            {hasCredentials && rotationUi && (
              <div className={styles.keys} data-dragging={dragActive || undefined}>
                <div
                  data-credential-zone="primary"
                  className={`${styles.zone} ${dragOver === 'primary' ? styles.zoneDragOver : ''}`}
                  onDragOver={(e) => handleDragOver(e, 'primary')}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, 'primary')}
                >
                  {primaryCred ? (
                    <CredentialRow
                      credential={primaryCred}
                      authTypeLabel={getAuthTypeLabel(primaryCred)}
                      authType={provider.authTypes.find((a) => a.id === primaryCred.authTypeId)}
                      isPrimary
                      isFallback={false}
                      retestState={retestStates[primaryCred.id]}
                      onChangeRotation={(targetRole) =>
                        changeCredentialRotation(primaryCred.id, 'primary', targetRole)
                      }
                      onRetest={() => onRetest(primaryCred.id)}
                      onDelete={() => onDelete(primaryCred.id)}
                      onEdit={(patch) => onEditCredential(primaryCred.id, patch)}
                      draggable
                      onDragStart={(e) => handleDragStart(e, primaryCred.id)}
                      onDragEnd={handleDragEnd}
                    />
                  ) : (
                    dragActive && <div className={styles.dropHint}>Drop here to make primary</div>
                  )}
                </div>

                <div
                  data-credential-zone="fallback"
                  className={`${styles.zone} ${dragOver === 'fallback' ? styles.zoneDragOver : ''}`}
                  onDragOver={(e) => handleDragOver(e, 'fallback')}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, 'fallback')}
                >
                  {fallbackCreds.length > 0 && (
                    <div className={styles.credList}>
                      {fallbackCreds.map((cred, i) => (
                        <CredentialRow
                          key={cred.id}
                          credential={cred}
                          authTypeLabel={getAuthTypeLabel(cred)}
                          authType={provider.authTypes.find((a) => a.id === cred.authTypeId)}
                          isPrimary={false}
                          isFallback
                          fallbackIndex={i}
                          retestState={retestStates[cred.id]}
                          onChangeRotation={(targetRole) =>
                            changeCredentialRotation(cred.id, 'fallback', targetRole)
                          }
                          onEdit={(patch) => onEditCredential(cred.id, patch)}
                          onRetest={() => onRetest(cred.id)}
                          onDelete={() => onDelete(cred.id)}
                          draggable
                          onDragStart={(e) => handleDragStart(e, cred.id)}
                          onDragEnd={handleDragEnd}
                        />
                      ))}
                    </div>
                  )}
                  {fallbackCreds.length === 0 && dragActive && (
                    <div className={styles.dropHint}>Drop here to add as fallback</div>
                  )}
                </div>

                <div
                  data-credential-zone="other"
                  className={`${styles.zone} ${dragOver === 'other' ? styles.zoneDragOver : ''}`}
                  onDragOver={(e) => handleDragOver(e, 'other')}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, 'other')}
                >
                  {showGroupLabels && otherCreds.length > 0 && (
                    <div className={styles.groupLabel}>Not in rotation</div>
                  )}
                  {otherCreds.length > 0 && (
                    <div className={styles.credList}>
                      {otherCreds.map((cred) => (
                        <CredentialRow
                          key={cred.id}
                          credential={cred}
                          authTypeLabel={getAuthTypeLabel(cred)}
                          authType={provider.authTypes.find((a) => a.id === cred.authTypeId)}
                          isPrimary={false}
                          isFallback={false}
                          retestState={retestStates[cred.id]}
                          onChangeRotation={(targetRole) =>
                            changeCredentialRotation(cred.id, 'other', targetRole)
                          }
                          onEdit={(patch) => onEditCredential(cred.id, patch)}
                          onRetest={() => onRetest(cred.id)}
                          onDelete={() => onDelete(cred.id)}
                          draggable
                          onDragStart={(e) => handleDragStart(e, cred.id)}
                          onDragEnd={handleDragEnd}
                        />
                      ))}
                    </div>
                  )}
                  {otherCreds.length === 0 && dragActive && (
                    <div className={styles.dropHint}>Drop here to unassign</div>
                  )}
                </div>
              </div>
            )}

            {/* With rotation off the Keys list is one plain list: no role
                buckets, drop targets, badges or rotation controls. */}
            {hasCredentials && !rotationUi && (
              <div className={`${styles.keys} ${styles.plainKeys}`}>
                {providerCredentials.map((cred) => (
                  <CredentialRow
                    key={cred.id}
                    credential={cred}
                    authTypeLabel={getAuthTypeLabel(cred)}
                    authType={provider.authTypes.find((a) => a.id === cred.authTypeId)}
                    isPrimary={cred.id === provider.primaryCredentialId}
                    isFallback={fallbackCredIds.has(cred.id)}
                    retestState={retestStates[cred.id]}
                    onEdit={(patch) => onEditCredential(cred.id, patch)}
                    onRetest={() => onRetest(cred.id)}
                    onDelete={() => onDelete(cred.id)}
                  />
                ))}
              </div>
            )}
          </Section>
        )}

        {!hideModels && (
          <Section label="Models">
            <ModelsPanel
              providerId={provider.id}
              models={models}
              usedModelIds={usedModelIds}
              onAddModel={onAddModel}
              onUpdateModel={onUpdateModel}
              onRemoveModel={onRemoveModel}
              onDiscoverModels={onDiscoverModels}
              onImportModels={onImportModels}
              focusModelId={focusModelId}
              // An open Keys panel shows the error itself.
              error={keysPanelOpen ? null : error}
            />
          </Section>
        )}
      </Stack>
    </div>
  );
};
