import React, { useState, useRef, useCallback, useEffect } from 'react';
import { getApiUrl } from '@desktop/utils/api/core';
import { providersApi } from '@desktop/utils/api/providers';
import { Button, TextInput, Stack, Cluster } from '@desktop/components';
import styles from './GoogleOAuthFlow.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';
import { isTauriEnv } from '@desktop/utils/tauriEnv';

interface GoogleOAuthFlowProps {
  /**
   * Called once a google-workspace credential is detected after the browser
   * flow completes. Receives the new credential id and the connected account
   * email (when available) so the form can update its state / save.
   */
  onConnected: (credentialId: string, accountEmail: string | null) => void;
  /** Called when the user cancels the in-progress flow. */
  onCancel?: () => void;
}

type FlowStatus = 'idle' | 'awaiting' | 'connected' | 'error';
type ClientConfigStatus =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'configured'; clientId: string }
  | { kind: 'editing' };

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const CLIENT_HINT =
  'Create a Google OAuth client with application type "Desktop app", then paste its Client ID and Client Secret here. No redirect URI setup is required.';

/**
 * Open the Google consent screen. Inside the Tauri webview `window.open`
 * can't spawn a browser window, so we go through the shell's `open_url`
 * command (system default browser). Google then redirects the browser to
 * the server's loopback callback page — never back into the webview —
 * and the app detects completion by polling the credentials list.
 */
async function openConsentUrl(url: string): Promise<void> {
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

/**
 * OAuth connect flow for Google Workspace.
 *
 *   1. Client-config gate — the Desktop app OAuth Client ID + Secret from
 *      Google Cloud Console must exist before `/oauth/start` can build the
 *      consent URL.
 *   2. Optional credential name — applied to the saved credential after the
 *      OAuth round-trip completes.
 *   3. Connect — opens the consent screen in the system browser and polls
 *      `/providers/credentials` for the new `google-workspace` row.
 */
export const GoogleOAuthFlow: React.FC<GoogleOAuthFlowProps> = ({ onConnected, onCancel }) => {
  const [status, setStatus] = useState<FlowStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [clientStatus, setClientStatus] = useState<ClientConfigStatus>({ kind: 'loading' });
  const [draftClientId, setDraftClientId] = useState('');
  const [draftClientSecret, setDraftClientSecret] = useState('');
  const [credentialName, setCredentialName] = useState('');
  const [saving, setSaving] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadlineRef = useRef<number>(0);
  const credentialNameRef = useRef('');
  credentialNameRef.current = credentialName;
  // Google credentials that already existed when Connect was pressed. The server
  // keeps one Google connection, so reconnecting replaces the existing row; only a
  // row that is not in this set is the connection the user just approved.
  const knownCredentialIdsRef = useRef<Set<string>>(new Set());
  // Bumped on every start, cancel and finished connect. A check that began under
  // an older value is stale and must not report anything.
  const flowRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flowRef.current += 1;
      stopPolling();
    };
  }, [stopPolling]);

  const refreshClientConfig = useCallback(async () => {
    try {
      const data = await providersApi.getGoogleClientConfig();
      if (data.configured && data.clientId) {
        setClientStatus({
          kind: 'configured',
          clientId: data.clientId,
        });
      } else {
        setClientStatus({ kind: 'missing' });
      }
    } catch (err) {
      setClientStatus({ kind: 'missing' });
      setError(getErrorMessage(err, 'Failed to load OAuth client config.'));
    }
  }, []);

  useEffect(() => {
    void refreshClientConfig();
  }, [refreshClientConfig]);

  const poll = useCallback(async () => {
    const flow = flowRef.current;
    try {
      const creds = await providersApi.listCredentials();
      if (flow !== flowRef.current) return;
      const found = creds.find(
        (c) => c.providerId === 'google-workspace' && !knownCredentialIdsRef.current.has(c.id)
      );
      if (found) {
        flowRef.current += 1;
        stopPolling();
        const email = (found.label && found.label.includes('@') ? found.label : null) ?? null;
        const name = credentialNameRef.current.trim();
        if (name) {
          // Rename before bubbling up so the parent's refresh shows it.
          await providersApi.updateCredential(found.id, { label: name }).catch((err: unknown) => {
            // Non-fatal: the credential still connects under its default label.
            console.error('GoogleOAuthFlow: failed to rename credential', err);
          });
        }
        if (!mountedRef.current) return;
        setStatus('connected');
        onConnected(found.id, email);
        return;
      }
      if (Date.now() > deadlineRef.current) {
        stopPolling();
        setStatus('error');
        setError('Timed out waiting for Google to connect. Close the browser tab and try again.');
      }
    } catch (err) {
      if (flow !== flowRef.current) return;
      stopPolling();
      setStatus('error');
      setError(getErrorMessage(err, 'Failed to check connection status.'));
    }
  }, [onConnected, stopPolling]);

  const handleConnect = useCallback(async () => {
    const flow = ++flowRef.current;
    setError(null);
    setStatus('awaiting');
    try {
      try {
        const existing = await providersApi.listCredentials();
        knownCredentialIdsRef.current = new Set(
          existing.filter((c) => c.providerId === 'google-workspace').map((c) => c.id)
        );
      } catch {
        // Without a snapshot a stored credential can't be told from a new one;
        // the poll then reports whatever it finds, as it did before.
        knownCredentialIdsRef.current = new Set();
      }
      if (flow !== flowRef.current) return;
      const res = await fetch(getApiUrl('/providers/google-workspace/oauth/start'));
      // The API error envelope is `{ error: { code, message } }` — reading
      // `body.error` directly stringified to "[object Object]" and hid the
      // one sentence that says what to fix.
      const body = (await res.json()) as {
        data?: { url?: string };
        error?: { message?: string } | string;
      };
      const url = body?.data?.url;
      if (!res.ok || !url) {
        const detail = typeof body?.error === 'string' ? body.error : body?.error?.message;
        throw new Error(
          detail ||
            'Could not start the Google OAuth flow. Enter the OAuth Client ID and Secret above first.'
        );
      }
      await openConsentUrl(url);
      deadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
      stopPolling();
      pollRef.current = setInterval(() => {
        void poll();
      }, POLL_INTERVAL_MS);
    } catch (err) {
      if (flow !== flowRef.current) return;
      setStatus('error');
      setError(getErrorMessage(err, 'Failed to start Google OAuth.'));
    }
  }, [poll, stopPolling]);

  const handleCancel = useCallback(() => {
    flowRef.current += 1;
    stopPolling();
    setStatus('idle');
    setError(null);
    onCancel?.();
  }, [onCancel, stopPolling]);

  const handleSaveClient = useCallback(async () => {
    if (!draftClientId.trim() || !draftClientSecret.trim()) {
      setError('Both Client ID and Client Secret are required.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const data = await providersApi.setGoogleClientConfig(
        draftClientId.trim(),
        draftClientSecret
      );
      setClientStatus({
        kind: 'configured',
        clientId: data.clientId,
      });
      setDraftClientId('');
      setDraftClientSecret('');
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save OAuth client credentials.'));
    } finally {
      setSaving(false);
    }
  }, [draftClientId, draftClientSecret]);

  const handleEditClient = useCallback(() => {
    setError(null);
    setDraftClientId(clientStatus.kind === 'configured' ? clientStatus.clientId : draftClientId);
    setDraftClientSecret('');
    setClientStatus({ kind: 'editing' });
  }, [clientStatus, draftClientId]);

  const handleCancelEdit = useCallback(() => {
    setError(null);
    setDraftClientId('');
    setDraftClientSecret('');
    void refreshClientConfig();
  }, [refreshClientConfig]);

  const handleClearClient = useCallback(async () => {
    setError(null);
    try {
      await providersApi.clearGoogleClientConfig();
      setClientStatus({ kind: 'missing' });
      setDraftClientId('');
      setDraftClientSecret('');
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to clear OAuth client credentials.'));
    }
  }, []);

  const showClientForm = clientStatus.kind === 'missing' || clientStatus.kind === 'editing';
  const connectDisabled =
    clientStatus.kind !== 'configured' || status === 'awaiting' || status === 'connected';

  return (
    <Stack gap={2}>
      <div className={styles.clientSection}>
        <div className={styles.clientHeader}>
          <span className={styles.clientTitle}>OAuth Client — Desktop app</span>
          {clientStatus.kind === 'configured' && <span className={styles.clientBadge}>saved</span>}
        </div>

        {clientStatus.kind === 'loading' && (
          <p className={styles.hint}>Loading OAuth client config…</p>
        )}

        {clientStatus.kind === 'configured' && (
          <div className={styles.configuredRow}>
            <span className={styles.configuredId} title={clientStatus.clientId}>
              {clientStatus.clientId}
            </span>
            <Cluster gap={2}>
              <Button variant="ghost" size="md" onClick={handleEditClient}>
                Edit
              </Button>
              <Button variant="ghost" size="md" onClick={() => void handleClearClient()}>
                Clear
              </Button>
            </Cluster>
          </div>
        )}

        {showClientForm && (
          <Stack gap={2}>
            <label className={styles.label}>
              <span>Client ID</span>
              <TextInput
                type="text"
                fullWidth
                value={draftClientId}
                onChange={(e) => setDraftClientId(e.target.value)}
                placeholder="123…apps.googleusercontent.com"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className={styles.label}>
              <span>Client Secret</span>
              <TextInput
                type="password"
                fullWidth
                value={draftClientSecret}
                onChange={(e) => setDraftClientSecret(e.target.value)}
                placeholder="GOCSPX-…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <Cluster gap={2}>
              <Button
                variant="primary"
                size="md"
                onClick={() => void handleSaveClient()}
                disabled={!draftClientId.trim() || !draftClientSecret.trim()}
                loading={saving}
                loadingText="Saving…"
              >
                Save
              </Button>
              {clientStatus.kind === 'editing' && (
                <Button variant="ghost" size="md" onClick={handleCancelEdit} disabled={saving}>
                  Cancel
                </Button>
              )}
            </Cluster>
            <p className={styles.hint}>{CLIENT_HINT}</p>
          </Stack>
        )}
      </div>

      <label className={styles.label}>
        <span>Credential name (optional)</span>
        <TextInput
          type="text"
          fullWidth
          value={credentialName}
          onChange={(e) => setCredentialName(e.target.value)}
          placeholder="e.g. Work Google account"
          autoComplete="off"
          spellCheck={false}
          disabled={status === 'connected'}
        />
      </label>

      <Cluster gap={2}>
        <Button
          variant="primary"
          size="md"
          onClick={() => void handleConnect()}
          disabled={connectDisabled}
          title={
            clientStatus.kind !== 'configured'
              ? 'Enter the OAuth Client ID and Secret first'
              : undefined
          }
        >
          {status === 'awaiting'
            ? 'Waiting for Google…'
            : status === 'connected'
              ? 'Connected ✓'
              : 'Connect Google'}
        </Button>
        {status === 'awaiting' && (
          <Button variant="ghost" size="md" onClick={handleCancel}>
            Cancel
          </Button>
        )}
      </Cluster>

      {status === 'awaiting' && (
        <p className={styles.hint}>
          Google sign-in opened in your browser. Approve access, then return here — we&apos;ll
          detect the connection automatically.
        </p>
      )}
      {status === 'connected' && (
        <p className={styles.success}>
          Google Workspace connected. Calendar &amp; Drive tools are now available.
        </p>
      )}
      {error && <p className={styles.error}>{error}</p>}
      {status === 'idle' && clientStatus.kind === 'configured' && !error && (
        <p className={styles.hint}>
          Connect your Google account to grant agents read access to Calendar and Drive.
        </p>
      )}
    </Stack>
  );
};
