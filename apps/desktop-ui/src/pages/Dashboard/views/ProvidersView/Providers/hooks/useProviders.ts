import { useEffect, useState, useCallback, useRef } from 'react';
import {
  providersApi,
  providerFallbackCredentialsApi,
  modelsApi,
  agentsApi,
} from '@desktop/utils/api';
import type {
  Provider,
  ProviderCredential,
  MetadataField,
  ModelRow,
  ProviderAuthType,
  ProviderFallbackCredential,
} from '@desktop/utils/api';
import type { ClaudeCodeLoginSnapshot } from '@snaglet/shared/types';
import { CLAUDE_CODE_LOGIN_TERMINAL_STATES } from '@snaglet/shared/types';
import type { CredentialDraft, VerifyState, RetestState, ClaudeCodeLoginFlowState } from '../types';
import {
  resolveSecret,
  resolveMetadata,
  parseJsonPaste,
  validateCredentialFormat,
  isLocalCredentiallessProvider,
  getKeyAuthTypes,
} from '../utils';
import { getErrorMessage } from '@snaglet/shared/utils';
import { isTauriEnv } from '@desktop/utils/tauriEnv';
import { showToast } from '@desktop/utils/toast';

type CredentialZone = 'primary' | 'fallback' | 'other';

/** Post-save notice worded from the server's status — never `ok` on our own. */
function savedCredentialNotice(
  status: ProviderCredential['verificationStatus'] | undefined,
  action: string
): VerifyState {
  switch (status) {
    case 'ok':
      return { status: 'ok', message: `${action} — verified.` };
    case 'fail':
      return { status: 'fail', message: `${action} — last test failed. Use Retest to check it.` };
    default:
      return { status: 'untested', message: `${action} — not tested. Use Retest to verify.` };
  }
}

const CLAUDE_CODE_POLL_INTERVAL_MS = 2000;

const IDLE_CLAUDE_CODE_LOGIN: ClaudeCodeLoginFlowState = {
  status: 'idle',
  message: null,
  sessionId: null,
};

/**
 * Open the Claude authorization page. Inside the Tauri webview `window.open`
 * can't spawn a browser window, so we go through the shell's `open_url`
 * command (system default browser) — same approach as GoogleOAuthFlow.
 * Approval completes in the browser; the desktop learns about it by polling.
 */
async function openAuthorizationUrl(url: string): Promise<void> {
  if (isTauriEnv()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_url', { url });
      return;
    } catch {
      // fall through to window.open — better a maybe-blocked popup than nothing
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

interface UseProvidersOptions {
  providerId?: string | null;
  onCatalogChange?: () => Promise<void> | void;
  /** A connection test passed: a draft key, a local server, or a saved key's retest. */
  onVerified?: (providerId: string) => void;
  /** The saved credentials were read again after a change (save, import, retest, delete). */
  onCredentialsChanged?: (credentials: ProviderCredential[]) => void;
}

export function useProviders({
  providerId: requestedProviderId = null,
  onCatalogChange,
  onVerified,
  onCredentialsChanged,
}: UseProvidersOptions = {}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [fallbacks, setFallbacks] = useState<ProviderFallbackCredential[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(requestedProviderId);
  const [drafts, setDrafts] = useState<Record<string, CredentialDraft>>({});
  const [verifyStates, setVerifyStates] = useState<Record<string, VerifyState>>({});
  const [loading, setLoading] = useState(true);
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [togglingProviderId, setTogglingProviderId] = useState<string | null>(null);
  const [retestStates, setRetestStates] = useState<Record<string, RetestState>>({});
  const [error, setError] = useState<string | null>(null);
  const [providerModels, setProviderModels] = useState<ModelRow[]>([]);
  const [usedModelIds, setUsedModelIds] = useState<Set<string>>(new Set());
  const [claudeCodeLogin, setClaudeCodeLogin] =
    useState<ClaudeCodeLoginFlowState>(IDLE_CLAUDE_CODE_LOGIN);
  // Sign-in session plumbing lives in refs so the poll interval and Cancel
  // see the live session without re-creating closures on every render.
  const claudeCodePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const claudeCodeSessionRef = useRef<string | null>(null);
  const claudeCodeOpenedUrlRef = useRef<string | null>(null);
  const claudeCodePollBusyRef = useRef(false);
  const claudeCodeInFlightRef = useRef(false);
  // Bumped on every start, cancel and unmount; async work compares the value
  // it captured after each await so a stale response never touches state.
  const claudeCodeGenRef = useRef(0);
  const selectedProviderIdRef = useRef(selectedProviderId);
  selectedProviderIdRef.current = selectedProviderId;
  const onCredentialsChangedRef = useRef(onCredentialsChanged);
  onCredentialsChangedRef.current = onCredentialsChanged;

  const selectedProvider = providers.find((p) => p.id === selectedProviderId) ?? null;

  const credentialsForProvider = (providerId: string): ProviderCredential[] =>
    credentials
      .filter((c) => c.providerId === providerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // A draft starts on the first type the Add key form offers. Sign in with
  // GitHub sets its own auth type when it opens, so a reset after saving
  // never leaves the Add key form holding Copilot's OAuth type.
  const getDefaultAuthTypeId = (provider: Provider): string =>
    getKeyAuthTypes(provider)[0]?.id ?? provider.authTypes[0]?.id ?? '';

  const emptyDraft = (provider: Provider): CredentialDraft => ({
    authTypeId: getDefaultAuthTypeId(provider),
    label: '',
    secret: '',
    metadata: {},
    pasteMode: false,
    jsonPaste: '',
    jsonError: null,
  });

  const getDraft = (provider: Provider): CredentialDraft =>
    drafts[provider.id] ?? emptyDraft(provider);

  const patchDraft = (
    providerId: string,
    patch: Partial<CredentialDraft>,
    defaultAuthTypeId: string
  ): void => {
    setDrafts((prev) => ({
      ...prev,
      [providerId]: {
        ...(prev[providerId] ?? {
          authTypeId: defaultAuthTypeId,
          label: '',
          secret: '',
          metadata: {},
          pasteMode: false,
          jsonPaste: '',
          jsonError: null,
        }),
        ...patch,
      },
    }));
    const credentialKeys: Array<keyof CredentialDraft> = ['secret', 'metadata', 'authTypeId'];
    if (credentialKeys.some((k) => k in patch)) {
      setVerifyStates((prev) => ({ ...prev, [providerId]: { status: 'idle', message: '' } }));
    }
  };

  const applyJsonPaste = (provider: Provider, fields: MetadataField[], json: string) => {
    const { metadata, error: jsonError } = parseJsonPaste(json, fields);
    patchDraft(
      provider.id,
      { metadata, jsonError, jsonPaste: json },
      getDefaultAuthTypeId(provider)
    );
  };

  const refreshProviders = useCallback(async () => {
    const providerList = await providersApi.list();
    setProviders(providerList);
  }, []);

  const refreshCredentials = useCallback(async () => {
    const credentialRows = await providersApi.listCredentials();
    setCredentials(credentialRows);
    onCredentialsChangedRef.current?.(credentialRows);
    return credentialRows;
  }, []);

  const refreshFallbacks = useCallback(async (providerId: string) => {
    const fb = await providerFallbackCredentialsApi.list(providerId);
    setFallbacks(fb);
  }, []);

  const refreshSelectedProviderState = useCallback(async (providerId: string) => {
    const [providerList, fb] = await Promise.all([
      providersApi.list(),
      providerFallbackCredentialsApi.list(providerId),
    ]);
    const sorted = [...providerList].sort((a, b) => a.sortOrder - b.sortOrder);
    setProviders(sorted);
    setFallbacks(fb);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([providersApi.list(), providersApi.listCredentials()])
      .then(([providerList, credentialRows]) => {
        const sorted = [...providerList].sort((a, b) => a.sortOrder - b.sortOrder);
        setProviders(sorted);
        setCredentials(credentialRows);
        if (sorted.length > 0) {
          const requestedId = requestedProviderId
            ? sorted.find((provider) => provider.id === requestedProviderId)?.id
            : null;
          const firstId = requestedId ?? sorted[0].id;
          // The selection effect below loads fallbacks for whichever provider
          // ends up selected; fetching `firstId`'s here could land last and
          // show another provider's fallbacks when the selection was kept.
          setSelectedProviderId((prev) => {
            const currentStillExists = prev && sorted.some((provider) => provider.id === prev);
            return requestedId ?? (currentStillExists ? prev : firstId);
          });
        }
      })
      .catch(() => setError('Could not load providers — is the server running?'))
      .finally(() => setLoading(false));
  }, [requestedProviderId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (requestedProviderId) setSelectedProviderId(requestedProviderId);
  }, [requestedProviderId]);

  // Switching providers quickly must not let a slower read for the previous
  // provider land last and fill this one's fallbacks, models or usage.
  useEffect(() => {
    if (!selectedProviderId) return;
    let canceled = false;
    providerFallbackCredentialsApi
      .list(selectedProviderId)
      .then((fb) => {
        if (!canceled) setFallbacks(fb);
      })
      .catch((err: unknown) => {
        console.error('useProviders: failed to load fallback credentials', err);
      });
    modelsApi
      .listForProvider(selectedProviderId)
      .then((models) => {
        if (!canceled) setProviderModels(models);
      })
      .catch(() => {
        if (!canceled) setProviderModels([]);
      });
    agentsApi
      .list()
      .then((agentList) => {
        if (canceled) return;
        const used = new Set<string>();
        for (const a of agentList) {
          if (a.provider === selectedProviderId && a.modelId) {
            used.add(a.modelId);
          }
        }
        setUsedModelIds(used);
      })
      .catch((err: unknown) => {
        console.error('useProviders: failed to load agents for model usage', err);
      });
    return () => {
      canceled = true;
    };
  }, [selectedProviderId]);

  const testCredential = async (provider: Provider, authType: ProviderAuthType | undefined) => {
    const draft = getDraft(provider);
    const localConnection = isLocalCredentiallessProvider(provider.id);
    const secret = localConnection ? '' : resolveSecret(draft, authType);
    if (!secret && !localConnection) {
      setVerifyStates((prev) => ({
        ...prev,
        [provider.id]: { status: 'fail', message: 'Enter a credential value to test.' },
      }));
      return;
    }
    setVerifyStates((prev) => ({ ...prev, [provider.id]: { status: 'testing', message: '' } }));
    try {
      const metadata = localConnection ? undefined : resolveMetadata(draft, authType);
      const result = await providersApi.verifyCredential({
        providerId: provider.id,
        secret,
        authType: localConnection ? undefined : authType?.type,
        metadata,
      });
      setVerifyStates((prev) => ({
        ...prev,
        [provider.id]: { status: result.valid ? 'ok' : 'fail', message: result.message },
      }));
      if (result.valid) onVerified?.(provider.id);
    } catch (e) {
      setVerifyStates((prev) => ({
        ...prev,
        [provider.id]: { status: 'fail', message: getErrorMessage(e, 'Test failed') },
      }));
    }
  };

  const saveCredential = async (provider: Provider) => {
    const draft = getDraft(provider);
    if (!draft.authTypeId) {
      setError('Select an auth type before connecting.');
      return;
    }
    const authType = provider.authTypes.find((a) => a.id === draft.authTypeId);
    if (!authType) {
      setError('Invalid auth type selected.');
      return;
    }
    // Connect is independent of Test: only the offline shape check gates the
    // save, so a failed or skipped Test never blocks storing the credential.
    const formatError = validateCredentialFormat(provider, authType, draft);
    if (formatError) {
      setError(formatError);
      return;
    }
    const secret = resolveSecret(draft, authType);
    setError(null);
    setSavingProviderId(provider.id);
    let saved: ProviderCredential;
    try {
      saved = await providersApi.saveCredential({
        providerId: provider.id,
        authTypeId: authType.id,
        authType: authType.type,
        label: draft.label || undefined,
        secret,
        metadata: resolveMetadata(draft, authType),
      });
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to connect credential'));
      setSavingProviderId(null);
      return;
    }
    // The credential is stored now. Clear the draft before refreshing, so a
    // failed refresh is not reported as a failed Connect with the secret
    // still filled in, inviting a second, duplicate save.
    setDrafts((prev) => ({ ...prev, [provider.id]: emptyDraft(provider) }));
    // The server stores manual saves as `untested`; a draft Test result must
    // not carry over to the new row, so the notice comes from the response.
    setVerifyStates((prev) => ({
      ...prev,
      [provider.id]: savedCredentialNotice(saved.verificationStatus, 'Saved'),
    }));
    try {
      await Promise.all([refreshCredentials(), refreshProviders()]);
    } catch (e) {
      setError(getErrorMessage(e, 'Connected, but the credential list could not be refreshed'));
    } finally {
      setSavingProviderId(null);
    }
  };

  /**
   * One-click import of a local CLI login. The server does the read + verify
   * + persist; we just refresh on success. Anthropic uses
   * `startClaudeCodeLogin` below; the UI only offers this for Codex.
   */
  const importCliCredential = async (providerId: 'codex' | 'anthropic') => {
    setError(null);
    setSavingProviderId(providerId);
    let imported: ProviderCredential;
    try {
      imported = await providersApi.importCliCredential(providerId);
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to import CLI login'));
      setSavingProviderId(null);
      return;
    }
    // The credential is stored now. Record the import before refreshing, so a
    // failed refresh is not reported as a failed import, inviting a second,
    // duplicate import (the same split Connect makes in saveCredential).
    setVerifyStates((prev) => ({
      ...prev,
      [providerId]: savedCredentialNotice(
        imported.verificationStatus,
        'Imported from local CLI login'
      ),
    }));
    try {
      await Promise.all([refreshCredentials(), refreshProviders()]);
    } catch (e) {
      setError(getErrorMessage(e, 'Imported, but the credential list could not be refreshed'));
    } finally {
      setSavingProviderId(null);
    }
  };

  const stopClaudeCodePolling = useCallback(() => {
    if (claudeCodePollRef.current) {
      clearInterval(claudeCodePollRef.current);
      claudeCodePollRef.current = null;
    }
    claudeCodePollBusyRef.current = false;
  }, []);

  /** Forget the live session: stop polling and release the in-flight guard. */
  const finishClaudeCodeSession = useCallback(() => {
    stopClaudeCodePolling();
    claudeCodeInFlightRef.current = false;
    claudeCodeSessionRef.current = null;
  }, [stopClaudeCodePolling]);

  // Unmount invalidates every pending start/poll/cancel so a late response
  // can neither set state nor create a fresh interval after cleanup.
  useEffect(
    () => () => {
      claudeCodeGenRef.current += 1;
      finishClaudeCodeSession();
    },
    [finishClaudeCodeSession]
  );

  /**
   * Fold a login snapshot into state. Opens the authorization URL the first
   * time one appears (the CLI may only print it on a later poll), and on a
   * terminal state stops polling; `connected` also refreshes credentials,
   * providers and the Anthropic model catalog and words the notice from the
   * imported row's own verification status. `gen` is the generation this
   * work belongs to — after every await, a mismatch means the user canceled,
   * restarted or left, and the snapshot is dropped. Returns true once there is
   * nothing left to poll for.
   */
  const applyClaudeCodeSnapshot = useCallback(
    async (snapshot: ClaudeCodeLoginSnapshot, gen: number): Promise<boolean> => {
      const terminal = CLAUDE_CODE_LOGIN_TERMINAL_STATES.has(snapshot.state);
      claudeCodeSessionRef.current = terminal ? null : snapshot.id;
      setClaudeCodeLogin({
        status: snapshot.state,
        message: snapshot.message ?? null,
        sessionId: snapshot.id,
      });
      if (
        !terminal &&
        snapshot.authorizationUrl &&
        claudeCodeOpenedUrlRef.current !== snapshot.authorizationUrl
      ) {
        claudeCodeOpenedUrlRef.current = snapshot.authorizationUrl;
        await openAuthorizationUrl(snapshot.authorizationUrl);
        if (claudeCodeGenRef.current !== gen) return true;
      }
      if (!terminal) return false;

      finishClaudeCodeSession();
      if (snapshot.state !== 'connected') return true;

      const [credentialRows] = await Promise.all([refreshCredentials(), refreshProviders()]);
      if (claudeCodeGenRef.current !== gen) return true;
      const imported = credentialRows.find((c) => c.id === snapshot.credentialId);
      setVerifyStates((prev) => ({
        ...prev,
        anthropic: savedCredentialNotice(
          imported?.verificationStatus,
          'Signed in with Claude Code'
        ),
      }));
      // A fresh login may unlock models; refresh the catalog the panel shows.
      if (selectedProviderIdRef.current === 'anthropic') {
        try {
          const models = await modelsApi.listForProvider('anthropic');
          if (claudeCodeGenRef.current === gen) setProviderModels(models);
        } catch (err: unknown) {
          console.error('useProviders: failed to refresh models after Claude Code login', err);
        }
      }
      return true;
    },
    [finishClaudeCodeSession, refreshCredentials, refreshProviders]
  );

  const pollClaudeCodeLogin = useCallback(
    async (gen: number) => {
      const sessionId = claudeCodeSessionRef.current;
      if (claudeCodeGenRef.current !== gen || !sessionId || claudeCodePollBusyRef.current) return;
      claudeCodePollBusyRef.current = true;
      try {
        const snapshot = await providersApi.getClaudeCodeLogin(sessionId);
        if (claudeCodeGenRef.current !== gen) return;
        await applyClaudeCodeSnapshot(snapshot, gen);
      } catch (e) {
        // A stale rejection from a session the user already left belongs to
        // nobody. Otherwise a 404 means the server forgot the session
        // (restart, expiry) — either way there is nothing left to wait for.
        if (claudeCodeGenRef.current !== gen) return;
        finishClaudeCodeSession();
        setClaudeCodeLogin({
          status: 'failed',
          message: getErrorMessage(e, 'Lost track of the Claude Code sign-in. Try again.'),
          sessionId: null,
        });
      } finally {
        if (claudeCodeGenRef.current === gen) claudeCodePollBusyRef.current = false;
      }
    },
    [applyClaudeCodeSnapshot, finishClaudeCodeSession]
  );

  /**
   * Sign in to Anthropic with the Claude Code CLI's OAuth login. The server
   * always answers with a `checking` session; it settles on its own when the
   * keychain already holds a login, or moves through the browser sign-in.
   * Either way we poll until the state is terminal. Ignored while one is in
   * flight.
   */
  const startClaudeCodeLogin = async () => {
    if (claudeCodeInFlightRef.current) return;
    const gen = ++claudeCodeGenRef.current;
    claudeCodeInFlightRef.current = true;
    claudeCodeOpenedUrlRef.current = null;
    claudeCodeSessionRef.current = null;
    setClaudeCodeLogin({ status: 'checking', message: null, sessionId: null });
    try {
      const snapshot = await providersApi.startClaudeCodeLogin();
      if (claudeCodeGenRef.current !== gen) return;
      const settled = await applyClaudeCodeSnapshot(snapshot, gen);
      if (settled || claudeCodeGenRef.current !== gen) return;
      claudeCodePollRef.current = setInterval(() => {
        void pollClaudeCodeLogin(gen);
      }, CLAUDE_CODE_POLL_INTERVAL_MS);
    } catch (e) {
      if (claudeCodeGenRef.current !== gen) return;
      finishClaudeCodeSession();
      setClaudeCodeLogin({
        status: 'failed',
        message: getErrorMessage(e, 'Could not start the Claude Code sign-in.'),
        sessionId: null,
      });
    }
  };

  const cancelClaudeCodeLogin = async () => {
    const sessionId = claudeCodeSessionRef.current;
    const gen = ++claudeCodeGenRef.current;
    finishClaudeCodeSession();
    if (!sessionId) {
      // Start still in flight: the session id is unknown, so drop the attempt
      // locally; the late start response is ignored by the generation check.
      setClaudeCodeLogin({ status: 'cancelled', message: null, sessionId: null });
      return;
    }
    try {
      const snapshot = await providersApi.cancelClaudeCodeLogin(sessionId);
      if (claudeCodeGenRef.current !== gen) return;
      setClaudeCodeLogin({
        status: snapshot.state,
        message: snapshot.message ?? null,
        sessionId: snapshot.id,
      });
    } catch (e) {
      if (claudeCodeGenRef.current !== gen) return;
      // The session may already be gone server-side; the user still canceled.
      setClaudeCodeLogin({
        status: 'cancelled',
        message: getErrorMessage(e, 'Claude Code sign-in canceled.'),
        sessionId: null,
      });
    }
  };

  const retestCredential = async (credentialId: string) => {
    setRetestStates((prev) => ({
      ...prev,
      [credentialId]: { status: 'testing', message: 'Testing...' },
    }));
    try {
      const result = await providersApi.retestCredential(credentialId);
      setRetestStates((prev) => ({
        ...prev,
        [credentialId]: { status: result.valid ? 'ok' : 'fail', message: result.message },
      }));
      const retested = credentials.find((c) => c.id === credentialId);
      if (result.valid && retested) onVerified?.(retested.providerId);
      await refreshCredentials();
    } catch (e) {
      setRetestStates((prev) => ({
        ...prev,
        [credentialId]: {
          status: 'fail',
          message: getErrorMessage(e, 'Test failed'),
        },
      }));
    }
  };

  const disconnectCredential = async (id: string) => {
    try {
      setError(null);
      const { message } = await providersApi.deleteCredential(id);
      // The server moves pins off the deleted credential (agents, overrides,
      // the provider primary) and says where they went.
      if (message) showToast(message, { durationMs: 5000 });
      await Promise.all([refreshCredentials(), refreshProviders()]);
      if (selectedProviderId) {
        await refreshFallbacks(selectedProviderId);
      }
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to disconnect credential'));
    }
  };

  const setProviderEnabled = async (providerId: string, enabled: boolean) => {
    try {
      setError(null);
      setTogglingProviderId(providerId);
      const updated = await providersApi.setEnabled(providerId, enabled);
      setProviders((current) =>
        current.map((provider) => (provider.id === providerId ? updated : provider))
      );
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to update integration'));
    } finally {
      setTogglingProviderId(null);
    }
  };

  const moveCredential = async (
    credentialId: string,
    currentZone: CredentialZone,
    targetZone: CredentialZone
  ) => {
    if (!selectedProviderId || currentZone === targetZone) return;

    try {
      setError(null);

      if (currentZone === 'primary') {
        await providersApi.setPrimaryCredential(selectedProviderId, null);
      } else if (currentZone === 'fallback') {
        await providerFallbackCredentialsApi.remove(selectedProviderId, credentialId);
      }

      if (targetZone === 'primary') {
        await providersApi.setPrimaryCredential(selectedProviderId, credentialId);
        await providerFallbackCredentialsApi
          .remove(selectedProviderId, credentialId)
          .catch((err: unknown) => {
            // Usually benign: the credential may simply not be in the fallback list.
            console.error('useProviders: failed to remove credential from fallbacks', err);
          });
      } else if (targetZone === 'fallback') {
        await providerFallbackCredentialsApi.add(selectedProviderId, credentialId);
      }

      await refreshSelectedProviderState(selectedProviderId);
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to move credential'));
    }
  };

  const editCredential = async (
    credentialId: string,
    patch: { label?: string; secret?: string; metadata?: Record<string, unknown> }
  ) => {
    try {
      setError(null);
      await providersApi.updateCredential(credentialId, patch);
      await refreshCredentials();
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to update credential'));
    }
  };

  const addModel = async (input: {
    modelId: string;
    displayName?: string;
    metadata?: import('@snaglet/shared/types').ModelMetadata;
    contextWindowTokens?: number | null;
    maxOutputTokens?: number | null;
  }): Promise<boolean> => {
    if (!selectedProviderId) return false;
    try {
      setError(null);
      await modelsApi.create({ providerId: selectedProviderId, ...input });
      const updated = await modelsApi.listForProvider(selectedProviderId);
      setProviderModels(updated);
      await onCatalogChange?.();
      return true;
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to add model'));
      return false;
    }
  };

  const updateModel = async (
    modelId: string,
    patch: {
      displayName?: string;
      contextWindowTokens?: number | null;
      maxOutputTokens?: number | null;
    }
  ): Promise<boolean> => {
    if (!selectedProviderId) return false;
    try {
      setError(null);
      await modelsApi.update(modelId, patch);
      const updated = await modelsApi.listForProvider(selectedProviderId);
      setProviderModels(updated);
      await onCatalogChange?.();
      return true;
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to update model'));
      return false;
    }
  };

  const discoverModels = async (providerId: string) => {
    try {
      setError(null);
      return await modelsApi.discover(providerId);
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to discover models'));
      return { providerId, models: [], warning: 'Discovery failed' };
    }
  };

  /** Resolves true when the models were imported, false when the import was refused. */
  const importModels = async (
    providerId: string,
    models: import('@desktop/utils/api').BulkModelInput[]
  ): Promise<boolean> => {
    try {
      setError(null);
      await modelsApi.createBulk(providerId, models);
      if (providerId === selectedProviderId) {
        const updated = await modelsApi.listForProvider(providerId);
        setProviderModels(updated);
      }
      await onCatalogChange?.();
      return true;
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to import models'));
      return false;
    }
  };

  const removeModel = async (modelId: string) => {
    if (!selectedProviderId) return;
    try {
      setError(null);
      await modelsApi.remove(modelId);
      const updated = await modelsApi.listForProvider(selectedProviderId);
      setProviderModels(updated);
      await onCatalogChange?.();
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to remove model'));
    }
  };

  return {
    // State
    providers,
    credentials,
    fallbacks,
    selectedProviderId,
    selectedProvider,
    loading,
    error,
    savingProviderId,
    togglingProviderId,
    retestStates,
    verifyStates,
    providerModels,
    usedModelIds,
    claudeCodeLogin,

    // Draft helpers
    getDraft,
    getDefaultAuthTypeId,
    patchDraft,
    applyJsonPaste,
    credentialsForProvider,

    // Actions
    setSelectedProviderId,
    setError,
    testCredential,
    saveCredential,
    importCliCredential,
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
  };
}
