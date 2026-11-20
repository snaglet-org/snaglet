/**
 * Shared, fully deterministic fixtures for the SystemPromptComposer tests: no
 * timestamps, no live registry, no cwd. Tool lists are a fixed subset of the
 * registry, so composed prompts stay small and do not drift when a real tool is
 * added. Volatile service data (embeddings availability, peers, summary,
 * prior-run hint) is controlled by each test file's mocks.
 *
 * Not a `*.test.ts` file, so jest does not run it as a suite.
 */

import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { SnagletAgent } from '@server/services/AgentService';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';

type ToolOverrides = Partial<ToolRow> & { id: string };

/** Build a ResolvedAgentTool from a minimal override, filling deterministic defaults. */
export function makeTool(over: ToolOverrides): ResolvedAgentTool {
  const tool: ToolRow = {
    id: over.id,
    name: over.name ?? over.id,
    description: over.description ?? `Fixture tool ${over.id}.`,
    type: over.type ?? 'builtin',
    parametersSchema: over.parametersSchema ?? { type: 'object', properties: {}, required: [] },
    keywords: over.keywords ?? [],
    aliases: over.aliases ?? [],
    source: over.source ?? null,
    configJson: over.configJson ?? {},
    enabled: over.enabled ?? true,
    tier: over.tier ?? 'standard',
    categoryPath: over.categoryPath ?? 'workspace',
    providerId: over.providerId ?? null,
    sortOrder: over.sortOrder ?? 100,
    createdAt: '',
    updatedAt: '',
  };
  return { agentId: 'agent-self', tool, settings: {}, requiresConfirmation: false };
}

const obj = (props: string[], required: string[] = []) => ({
  type: 'object',
  required,
  properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])),
});

/**
 * Fixed tool subset. Tools included in MINIMAL_TOOLS are all members of the
 * stable advertised core. FULL_TOOLS adds more core tools plus one MCP tool
 * standing in for an explicit allow-list pin.
 */
export const TOOLS = {
  // core (inlined in the catalog; `action` is filtered out of the listing)
  action: makeTool({
    id: 'action',
    name: 'Action',
    tier: 'core',
    categoryPath: 'system',
    parametersSchema: obj(['tool', 'params'], ['tool']),
  }),
  tool: makeTool({
    id: 'tool',
    name: 'Tools',
    tier: 'core',
    categoryPath: 'system',
    parametersSchema: obj(['op', 'query', 'mode', 'name'], ['op']),
  }),
  workspace_search: makeTool({
    id: 'search',
    name: 'Search',
    tier: 'core',
    categoryPath: 'workspace',
    parametersSchema: obj(['kind', 'query', 'id', 'kinds', 'mode'], []),
  }),
  node: makeTool({
    id: 'node',
    name: 'Node',
    tier: 'core',
    categoryPath: 'workspace',
    parametersSchema: obj(['op', 'id', 'ids', 'parent_id', 'title'], ['op']),
  }),
  message_context: makeTool({
    id: 'message_context',
    name: 'Message Context Window',
    tier: 'core',
    categoryPath: 'threads',
    parametersSchema: obj(['message_id', 'before', 'after'], ['message_id']),
  }),
  get_current_datetime: makeTool({
    id: 'get_current_datetime',
    name: 'Get Current Datetime',
    tier: 'core',
    categoryPath: 'utilities',
    parametersSchema: obj([], []),
  }),
  get_clarification: makeTool({
    id: 'get_clarification',
    name: 'Triage',
    tier: 'core',
    categoryPath: 'system',
    parametersSchema: obj(['questions'], ['questions']),
  }),
  // pane(op): get_user_pane_layout + navigate_user_pane.
  pane: makeTool({
    id: 'pane',
    name: 'Pane',
    tier: 'core',
    categoryPath: 'workspace',
    parametersSchema: obj(['op', 'pane_key', 'target'], ['op']),
  }),

  // standard (discoverable only; not inlined)
  web_search: makeTool({ id: 'web_search', name: 'Web Search', categoryPath: 'web' }),
  memory_recall: makeTool({ id: 'memory_recall', name: 'Memory Recall', categoryPath: 'memories' }),
  memory_store: makeTool({ id: 'memory_store', name: 'Memory Store', categoryPath: 'memories' }),
  memory_forget: makeTool({ id: 'memory_forget', name: 'Memory Forget', categoryPath: 'memories' }),
  memory: makeTool({ id: 'memory', name: 'Memory', categoryPath: 'memory' }),
  run_history: makeTool({ id: 'run_history', name: 'Run History', categoryPath: 'agents' }),
  agent_recent_activity: makeTool({
    id: 'agent_recent_activity',
    name: 'Agent Recent Activity',
    categoryPath: 'agents',
  }),
  find_conversation: makeTool({
    id: 'find_conversation',
    name: 'Find Conversation',
    categoryPath: 'threads',
  }),
  // thread(op): gates runModeBlock's keep-the-room-small line.
  thread: makeTool({
    id: 'thread',
    name: 'Thread',
    tier: 'core',
    categoryPath: 'threads',
    parametersSchema: obj(['op', 'id', 'agent_ids'], ['op']),
  }),
  file: makeTool({ id: 'file', name: 'File', categoryPath: 'files' }),
  shell: makeTool({ id: 'shell', name: 'Shell', categoryPath: 'shell' }),

  // Native browser tool (forces the perception Browser section).
  browser: makeTool({ id: 'browser', name: 'Browser', categoryPath: 'system' }),

  // MCP (live; forces an MCP catalog group)
  mcp_linear_list_issues: makeTool({
    id: 'mcp__linear__list_issues',
    name: 'List Issues',
    type: 'mcp',
    providerId: 'linear',
    categoryPath: 'integrations/linear',
    parametersSchema: obj(['query'], ['query']),
  }),
} as const;

/** Minimal solo advertised set — core tools only, no MCP/triage/exec/UI (pane and orient are on-demand). */
export const MINIMAL_TOOLS: ResolvedAgentTool[] = [
  TOOLS.action,
  TOOLS.tool,
  TOOLS.workspace_search,
  TOOLS.node,
  TOOLS.get_current_datetime,
  TOOLS.memory,
  TOOLS.file,
  TOOLS.web_search,
];

/** Full advertised fixture — more core tools plus one explicitly pinned MCP tool. */
export const FULL_TOOLS: ResolvedAgentTool[] = [
  ...MINIMAL_TOOLS,
  TOOLS.get_clarification,
  TOOLS.shell,
  TOOLS.browser,
  TOOLS.mcp_linear_list_issues,
];

/**
 * The core table tool. Kept out of FULL_TOOLS; tests of blocks that gate on it
 * (perception's Structured data) add it.
 */
export const TABLE_TOOLS: ResolvedAgentTool[] = ['table'].map((id) =>
  makeTool({ id, tier: 'core', categoryPath: 'database' })
);

/** The core doc tool, which adds operatingContextBlock's Transclusions paragraph. */
export const DOC_TOOLS: ResolvedAgentTool[] = ['doc'].map((id) =>
  makeTool({ id, tier: 'core', categoryPath: 'workspace' })
);

function makeAgent(over: Partial<SnagletAgent> = {}): SnagletAgent {
  return {
    id: 'agent-self',
    name: 'Fixture Agent',
    role: 'test engineer',
    provider: 'anthropic',
    systemPrompt: '',
    rawSystemPrompt: null,
    ...over,
  } as unknown as SnagletAgent;
}

/** Pinned project + thread coordinates so operatingContextBlock is deterministic. */
export const PROJECT_RUN_PARAMS: Record<string, unknown> = {
  host_path: '/snaglet/host',
  thread_title: 'Rollout planning',
  thread_path: '/Snaglet/projects/vega/threads',
  thread_routing: 'all',
  thread_participants: 'Peer One, Peer Two',
  project_name: 'Vega',
  project_folder_path: '/repos/vega',
  project_gitrepo: 'git@example.com:snaglet/vega.git',
  parent_project_name: 'Snaglet',
};

export interface CtxOptions {
  isGroup?: boolean;
  agentTools?: ResolvedAgentTool[];
  runParams?: Record<string, unknown>;
  systemPrompt?: string;
  threadSystemPrompt?: string;
  dispatchMode?: 'all' | 'mentioned';
  participantAgentIds?: string[];
  /** Only used by blocks that read it directly; composeSystemPrompt overwrites it via the mock. */
  embeddingsEnabled?: boolean;
}

/** Build a full, deterministic SystemPromptContext. */
export function makeCtx(opts: CtxOptions = {}): SystemPromptContext {
  const agent = makeAgent();
  const runtimeAgent = makeAgent({ systemPrompt: opts.systemPrompt ?? '' });
  return {
    agent,
    runtimeAgent,
    threadAgentOverride: undefined,
    threadId: 'thread-fixture-1',
    threadRuntimeConfig: opts.threadSystemPrompt
      ? ({ systemPrompt: opts.threadSystemPrompt } as SystemPromptContext['threadRuntimeConfig'])
      : null,
    isGroup: opts.isGroup ?? false,
    dispatchMode: opts.dispatchMode ?? 'all',
    agentTools: opts.agentTools ?? MINIMAL_TOOLS,
    participantAgentIds: opts.participantAgentIds ?? ['agent-self'],
    replyAgentId: 'agent-self',
    mentionContext: undefined,
    agentSoftThresholdNotified: new Set<string>(),
    agentDispatchCount: new Map<string, number>(),
    runKind: 'realtime_thread',
    runParams: opts.runParams ?? { host_path: '/snaglet/host' },
    embeddingsEnabled: opts.embeddingsEnabled ?? false,
  } as unknown as SystemPromptContext;
}

/** Peer agents resolved by runModeBlock via agentService.get() in group contexts. */
export const GROUP_PARTICIPANTS = ['agent-self', 'agent-peer-1', 'agent-peer-2'];
export const GROUP_PEERS: Record<string, { id: string; name: string; role: string }> = {
  'agent-peer-1': { id: 'agent-peer-1', name: 'Peer One', role: 'engineer' },
  'agent-peer-2': { id: 'agent-peer-2', name: 'Peer Two', role: 'designer' },
};
