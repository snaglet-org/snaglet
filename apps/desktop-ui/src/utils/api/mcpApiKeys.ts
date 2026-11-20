/**
 * External MCP client connections — mint/list/rename/revoke keys for clients
 * entering Snaglet through the /mcp endpoint.
 */

import type { McpConnectInfo } from '@snaglet/shared/types';
import { fetchData, getApiUrl } from './core';

export interface McpApiKey {
  id: string;
  memberId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Mint response — `token` is the plaintext key, shown exactly once. */
export interface McpApiKeyMint {
  key: McpApiKey;
  token: string;
}

export const mcpApiKeysApi = {
  list: () => fetchData<McpApiKey[]>(getApiUrl('/mcp-keys')),

  mint: (name: string) =>
    fetchData<McpApiKeyMint>(getApiUrl('/mcp-keys'), {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  rename: (id: string, name: string) =>
    fetchData<McpApiKey>(getApiUrl(`/mcp-keys/${id}`), {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  revoke: (id: string) =>
    fetchData<McpApiKey>(getApiUrl(`/mcp-keys/${id}/revoke`), { method: 'POST' }),

  /** This Snaglet's home, profile, `snaglet` command and port for the Connect setup. No secrets. */
  connectInfo: () => fetchData<McpConnectInfo>(getApiUrl('/mcp-keys/connect-info')),
};
