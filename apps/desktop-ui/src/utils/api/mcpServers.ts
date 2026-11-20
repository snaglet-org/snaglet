import { fetchData, getApiUrl } from './core';
import type {
  McpServer,
  McpServerUpsert,
  McpTestResult,
  McpCredentialInput,
  McpInstallResult,
} from './types/mcp';

export const mcpServersApi = {
  list: () => fetchData<McpServer[]>(getApiUrl('/mcp/servers')),

  get: (id: string) => fetchData<McpServer>(getApiUrl(`/mcp/servers/${id}`)),

  create: (data: McpServerUpsert) =>
    fetchData<McpServer>(getApiUrl('/mcp/servers'), {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: McpServerUpsert) =>
    fetchData<McpServer>(getApiUrl(`/mcp/servers/${id}`), {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  setEnabled: (id: string, enabled: boolean) =>
    fetchData<McpServer>(getApiUrl(`/mcp/servers/${id}/enabled`), {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  remove: (id: string) =>
    fetchData<{ id: string; removed: boolean }>(getApiUrl(`/mcp/servers/${id}`), {
      method: 'DELETE',
    }),

  /** Undo a recent delete. The server holds the deleted config, so only the id is sent. */
  restore: (id: string) =>
    fetchData<{ id: string; restored: boolean; agentsRestored: number }>(
      getApiUrl(`/mcp/servers/${id}/restore`),
      { method: 'POST' }
    ),

  /** Test Connection — one-shot probe against the saved config. */
  test: (id: string) =>
    fetchData<McpTestResult>(getApiUrl(`/mcp/servers/${id}/test`), { method: 'POST' }),

  /** Update: reinstall an npx server's package (pinned or latest), restarting it if running. */
  install: (id: string) =>
    fetchData<McpInstallResult>(getApiUrl(`/mcp/servers/${id}/install`), { method: 'POST' }),

  saveCredential: (id: string, body: McpCredentialInput) =>
    fetchData<McpServer>(getApiUrl(`/mcp/servers/${id}/credential`), {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteCredential: (id: string) =>
    fetchData<McpServer>(getApiUrl(`/mcp/servers/${id}/credential`), { method: 'DELETE' }),

  /** Every agent and whether it may use this server. */
  listAgents: (id: string) => fetchData<McpServerAgent[]>(getApiUrl(`/mcp/servers/${id}/agents`)),

  /** Set exactly which agents may use this server; returns the new list. */
  setAgents: (id: string, agentIds: string[]) =>
    fetchData<McpServerAgent[]>(getApiUrl(`/mcp/servers/${id}/agents`), {
      method: 'PUT',
      body: JSON.stringify({ agentIds }),
    }),
};

export interface McpServerAgent {
  id: string;
  name: string;
  enabled: boolean;
}
