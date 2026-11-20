import { fetchData, fetchJson, getApiUrl } from './core';
import { getPanelJsonHeaders } from '../panelToken';
import type { ToolRow, CreateToolInput, UpdateToolInput } from './types';

export interface AgentToolOverridePayload {
  toolId: string;
  settings?: Record<string, unknown>;
  requiresConfirmation?: boolean;
}

export interface AgentToolOverrideResponse {
  toolId: string;
  override: { settings?: Record<string, unknown>; requiresConfirmation?: boolean };
}

export interface BulkSetAgentToolsResponse {
  toolAccessMode: 'allow_list';
  toolAllowList: string[];
}

interface WorkspaceInfo {
  toolId: string;
  dir: string;
  files: string[];
  hasNodeModules: boolean;
  hasBuild: boolean;
  definition: Record<string, unknown> | null;
}

export interface WorkspaceFiles {
  'definition.json': string;
  'tool.ts': string;
  'TOOL.md': string;
}

interface BuildResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/**
 * `POST /tools/workspaces/:id/deploy`'s response shape. Unlike the rest of
 * this file's routes, its failure branch does NOT go through the shared
 * `ApiFailure` envelope (`error`/`details`/`timestamp`) — the route
 * (workspaces.routes.ts) responds HTTP 200 with a bespoke
 * `{ success: false, data: { step, output, error, durationMs } }` body for a
 * legitimate business failure (a bad tool.ts), reserving the standard
 * envelope for genuine transport/validation errors. This type models that
 * real wire shape so callers can branch on `.success` without losing detail.
 */
type WorkspaceDeployResult =
  | { success: true; tool: ToolRow; install: BuildResult; build: BuildResult }
  | {
      success: false;
      step: 'install' | 'build';
      output: string;
      error?: string;
      durationMs: number;
    };

export const toolWorkspacesApi = {
  list: () => fetchData<WorkspaceInfo[]>(getApiUrl('/tools/workspaces')),

  get: (toolId: string) => fetchData<WorkspaceInfo>(getApiUrl(`/tools/workspaces/${toolId}`)),

  save: (toolId: string, files: WorkspaceFiles) =>
    fetchData<{ workspace: WorkspaceInfo; tool: ToolRow }>(getApiUrl('/tools/workspaces'), {
      method: 'POST',
      body: JSON.stringify({ toolId, files }),
    }),

  updateFiles: (toolId: string, files: Partial<WorkspaceFiles>) =>
    fetchData<{ workspace: WorkspaceInfo; tool: ToolRow | null }>(
      getApiUrl(`/tools/workspaces/${toolId}/files`),
      { method: 'PUT', body: JSON.stringify(files) }
    ),

  install: (toolId: string) =>
    fetchData<BuildResult>(getApiUrl(`/tools/workspaces/${toolId}/install`), {
      method: 'POST',
    }),

  build: (toolId: string) =>
    fetchData<BuildResult>(getApiUrl(`/tools/workspaces/${toolId}/build`), {
      method: 'POST',
    }),

  deploy: async (toolId: string): Promise<WorkspaceDeployResult> => {
    // Not `fetchData`: an install/build failure is HTTP 200 with a non-standard
    // envelope (see WorkspaceDeployResult), and `fetchData` would reduce it to
    // "Request failed". `fetchJson` still throws on a non-2xx response.
    // The envelope's own `success` flag is the discriminant; `data` only
    // carries a `success` field on the failure branch.
    const body = await fetchJson<{
      success: boolean;
      data: Record<string, unknown>;
      timestamp: string;
    }>(getApiUrl(`/tools/workspaces/${toolId}/deploy`), { method: 'POST' });
    if (body.success) {
      return {
        success: true,
        ...(body.data as { tool: ToolRow; install: BuildResult; build: BuildResult }),
      };
    }
    return {
      success: false,
      ...(body.data as {
        step: 'install' | 'build';
        output: string;
        error?: string;
        durationMs: number;
      }),
    };
  },

  delete: (toolId: string) =>
    fetchData<null>(getApiUrl(`/tools/workspaces/${toolId}`), { method: 'DELETE' }),

  readFile: (toolId: string, fileName: string) =>
    fetchData<{ content: string }>(getApiUrl(`/tools/workspaces/${toolId}/files/${fileName}`)).then(
      (data) => data.content
    ),
};

export interface ToolExecuteResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export const toolsApi = {
  /**
   * List tools. By default returns only persisted tools (native builtins +
   * external custom tools). Pass `includeMcp: true` — used by the tool-access
   * settings pane — to also include every enabled MCP server's live tools, so
   * native and MCP tools appear in one grouped list.
   */
  list: (opts?: { includeMcp?: boolean }) =>
    fetchData<ToolRow[]>(getApiUrl(opts?.includeMcp ? '/tools?includeMcp=true' : '/tools')),
  /**
   * Execute a tool directly (panel Run). `actAsAgentId` threads an agent's
   * context (memory scoping, per-agent MCP routing) through the run while the
   * user stays the acting principal server-side. Required for tools whose
   * ToolRow.contextRequirement is 'agent-required', optional for
   * 'agent-optional', and omitted from the body otherwise.
   */
  execute: (name: string, input: Record<string, unknown> = {}, opts?: { actAsAgentId?: string }) =>
    fetchData<ToolExecuteResult>(getApiUrl('/tools/execute'), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
      body: JSON.stringify({
        name,
        input,
        ...(opts?.actAsAgentId ? { act_as_agent_id: opts.actAsAgentId } : {}),
      }),
    }),
  test: (code: string, input: Record<string, unknown> = {}) =>
    fetchData<ToolExecuteResult>(getApiUrl('/tools/execute/test'), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
      body: JSON.stringify({ code, input }),
    }),
  get: (id: string) => fetchData<ToolRow>(getApiUrl(`/tools/${id}`)),
  create: (data: CreateToolInput) =>
    fetchData<ToolRow>(getApiUrl('/tools'), {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: UpdateToolInput) =>
    fetchData<ToolRow>(getApiUrl(`/tools/${id}`), {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => fetchData<null>(getApiUrl(`/tools/${id}`), { method: 'DELETE' }),
  bulkSetForAgent: (agentId: string, toolIds: string[]) =>
    fetchData<BulkSetAgentToolsResponse>(getApiUrl(`/tools/agent/${agentId}`), {
      method: 'PUT',
      body: JSON.stringify({ toolIds }),
    }),
  assignToAgent: (agentId: string, data: AgentToolOverridePayload) =>
    fetchData<AgentToolOverrideResponse>(getApiUrl(`/tools/agent/${agentId}`), {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateAgentTool: (
    agentId: string,
    toolId: string,
    data: { settings?: Record<string, unknown>; requiresConfirmation?: boolean }
  ) =>
    fetchData<AgentToolOverrideResponse>(getApiUrl(`/tools/agent/${agentId}/${toolId}`), {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  removeFromAgent: (agentId: string, toolId: string) =>
    fetchData<void>(getApiUrl(`/tools/agent/${agentId}/${toolId}`), {
      method: 'DELETE',
    }),
  setEnabled: (id: string, enabled: boolean) =>
    fetchData<ToolRow>(getApiUrl(`/tools/${id}/enabled`), {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
};
