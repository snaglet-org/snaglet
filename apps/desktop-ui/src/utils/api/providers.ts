import { fetchData, getApiUrl } from './core';
import type { ClaudeCodeLoginSnapshot } from '@snaglet/shared/types';
import type {
  Provider,
  ProviderCredential,
  ExportedProviderCredential,
  ProviderVerifyResult,
  ProviderFallbackCredential,
  ProviderDefaultModel,
} from './types';

/**
 * DELETE /providers/credentials/:id. Pins on the deleted credential (the
 * provider primary, agents, thread and summary-model overrides) move to the
 * provider's best remaining credential or are cleared; `message` says what
 * moved, or is null when nothing pointed at it.
 */
interface DeleteCredentialResponse {
  deleted: { id: string; providerId: string; label: string };
  message: string | null;
}

export const providersApi = {
  list: () => fetchData<Provider[]>(getApiUrl('/providers')),

  setPrimaryCredential: (providerId: string, credentialId: string | null) =>
    fetchData<Provider>(getApiUrl(`/providers/${providerId}/credential`), {
      method: 'PATCH',
      body: JSON.stringify({ credentialId }),
    }),

  setEnabled: (providerId: string, enabled: boolean) =>
    fetchData<Provider>(getApiUrl(`/providers/${providerId}/enabled`), {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  listCredentials: () => fetchData<ProviderCredential[]>(getApiUrl('/providers/credentials')),

  /** The model an agent with none would take now; null while nothing usable is connected. */
  defaultModel: () => fetchData<ProviderDefaultModel | null>(getApiUrl('/providers/default-model')),

  exportCredential: (id: string) =>
    fetchData<ExportedProviderCredential>(getApiUrl(`/providers/credentials/${id}/export`)),

  saveCredential: (data: {
    providerId: string;
    authTypeId: string;
    authType: string;
    label?: string;
    secret: string;
    metadata?: Record<string, unknown>;
  }) =>
    fetchData<ProviderCredential>(getApiUrl('/providers/credentials'), {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  /**
   * One-click import of a local CLI login. Server reads the Codex CLI's
   * ~/.codex/auth.json (providerId 'codex') or the Claude Code CLI's macOS
   * keychain entry (providerId 'anthropic'), verifies, and persists.
   */
  importCliCredential: (providerId: 'codex' | 'anthropic') =>
    fetchData<ProviderCredential>(getApiUrl('/providers/credentials/import-cli'), {
      method: 'POST',
      body: JSON.stringify({ providerId }),
    }),

  /**
   * Claude Code sign-in for Anthropic. `start` returns a `connected` snapshot
   * when the CLI keychain already holds a usable login, or a `waiting` session
   * (HTTP 202) to poll with `get` until its state is terminal. The snapshot
   * never carries token material.
   */
  startClaudeCodeLogin: () =>
    fetchData<ClaudeCodeLoginSnapshot>(getApiUrl('/providers/anthropic/claude-code/login'), {
      method: 'POST',
    }),

  getClaudeCodeLogin: (id: string) =>
    fetchData<ClaudeCodeLoginSnapshot>(
      getApiUrl(`/providers/anthropic/claude-code/login/${encodeURIComponent(id)}`)
    ),

  cancelClaudeCodeLogin: (id: string) =>
    fetchData<ClaudeCodeLoginSnapshot>(
      getApiUrl(`/providers/anthropic/claude-code/login/${encodeURIComponent(id)}`),
      { method: 'DELETE' }
    ),

  deleteCredential: (id: string) =>
    fetchData<DeleteCredentialResponse>(getApiUrl(`/providers/credentials/${id}`), {
      method: 'DELETE',
    }),

  updateCredential: (
    id: string,
    patch: { label?: string; secret?: string; metadata?: Record<string, unknown> }
  ) =>
    fetchData<ProviderCredential>(getApiUrl(`/providers/credentials/${id}`), {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  verifyCredential: (data: {
    providerId: string;
    secret: string;
    authType?: string;
    metadata?: Record<string, unknown>;
  }) =>
    fetchData<ProviderVerifyResult>(getApiUrl('/providers/verify'), {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  retestCredential: (credentialId: string) =>
    fetchData<ProviderVerifyResult>(getApiUrl(`/providers/credentials/${credentialId}/test`), {
      method: 'POST',
    }),

  /**
   * Google Workspace Desktop app OAuth client-config endpoints. The Client ID /
   * Secret come from Google Cloud Console → OAuth client type "Desktop app".
   * Users enter them once in the Integrations UI; we encrypt and store them in
   * `user_provider_credentials`. GET never returns the secret.
   */
  getGoogleClientConfig: () =>
    fetchData<{
      configured: boolean;
      clientId?: string;
      source?: 'db';
    }>(getApiUrl('/providers/google-workspace/client-config')),

  setGoogleClientConfig: (clientId: string, clientSecret: string) =>
    fetchData<{ configured: boolean; clientId: string; source: 'db' }>(
      getApiUrl('/providers/google-workspace/client-config'),
      {
        method: 'PUT',
        body: JSON.stringify({ clientId, clientSecret }),
      }
    ),

  clearGoogleClientConfig: () =>
    fetchData<null>(getApiUrl('/providers/google-workspace/client-config'), {
      method: 'DELETE',
    }),
};

export const providerFallbackCredentialsApi = {
  list: (providerId: string) =>
    fetchData<ProviderFallbackCredential[]>(
      getApiUrl(`/providers/${providerId}/fallback-credentials`)
    ),
  add: (providerId: string, credentialId: string, fallbackIndex?: number) =>
    fetchData<ProviderFallbackCredential>(
      getApiUrl(`/providers/${providerId}/fallback-credentials`),
      {
        method: 'POST',
        body: JSON.stringify({ credentialId, fallbackIndex }),
      }
    ),
  remove: (providerId: string, credentialId: string) =>
    fetchData<null>(getApiUrl(`/providers/${providerId}/fallback-credentials/${credentialId}`), {
      method: 'DELETE',
    }),
};
