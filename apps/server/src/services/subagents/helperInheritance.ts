/**
 * Live tool-permission inheritance for subagent helpers.
 *
 * A helper can do exactly what its orchestrator can do in the parent thread,
 * right now: the orchestrator's access there (its participant override, else
 * its own row), its per-tool confirmation overrides, its trusted flag and its
 * MCP servers (with the orchestrator's parent-thread MCP delta). Nothing is
 * copied at start, so a permission granted to the orchestrator later reaches
 * its running helpers, one taken away is gone at their next resolution, and
 * one granted on a helper's prompt is written to the orchestrator (see
 * confirmation.ts). The helper row keeps only the narrowing chosen at start
 * (narrowToolAccess); its own MCP servers and anything set on its hidden
 * thread never widen what it inherits.
 */
import { Agents, type AgentRow } from '@snaglet/db/tables/agents';
import { appendAgentToolAllowList } from '@server/services/agentToolAllowList';
import { Subagents } from '@snaglet/db/tables/subagents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import {
  resolveEnabledMcpServers,
  type ToolAccessConfig,
  type ToolOverride,
} from '@snaglet/shared/types';
import { resolveThreadRuntimeConfig } from '@server/services/ConfigResolverService';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import {
  accessAllowsTool,
  agentToolAccess,
  EMPTY_TOOL_NAME_CATALOG,
  helperMcpLimit,
  isMcpToolEntry,
  narrowToolAccess,
  type ToolNameCatalog,
} from './toolAccess';

export interface HelperToolPolicy {
  /** The orchestrator's row: confirmation overrides, trusted flag, MCP servers. */
  orchestrator: AgentRow;
  parentThreadId: string;
  /** The orchestrator's own access in the parent thread, before narrowing. */
  baseAccess: ToolAccessConfig;
  /** Whether `baseAccess` is the orchestrator's participant override there. */
  fromThreadOverride: boolean;
  /** What the helper may use: `baseAccess` narrowed by the helper's own setting. */
  access: ToolAccessConfig;
  /** The orchestrator's per-tool overrides in the parent thread. */
  threadToolOverrides: Record<string, ToolOverride> | undefined;
  /**
   * The MCP servers the orchestrator can use in the parent thread: its own
   * enabled servers with its participant MCP delta there applied.
   */
  mcpServerIds: string[];
  /** The MCP tool ids the helper's own narrowing lists, or null for no limit. */
  mcpLimit: ReadonlySet<string> | null;
  /** The tool names entries were read against. */
  catalog: ToolNameCatalog;
}

/**
 * The registry's tools, for reading rule entries by display name and old id
 * as the permission engine does. Empty when the registry cannot load, which
 * only narrows: entries are then compared by id.
 */
export async function loadToolNameCatalog(): Promise<ToolNameCatalog> {
  try {
    await toolRegistry.load();
    return {
      activeToolIds: new Set(toolRegistry.getToolIds()),
      tools: Object.values(toolRegistry.getAllDefinitions()).map((definition) => ({
        id: definition.id,
        name: definition.name,
        aliases: definition.aliases ?? null,
      })),
    };
  } catch {
    return EMPTY_TOOL_NAME_CATALOG;
  }
}

/**
 * The inherited policy for `agentId`, or null when it is not a helper or its
 * orchestrator or subagents row is gone (agentToolPolicy then gives a helper
 * no tools beyond the always-available ones).
 */
export async function resolveHelperToolPolicy(
  agentId: string,
  helperRow?: AgentRow | null
): Promise<HelperToolPolicy | null> {
  const helper = helperRow ?? (await Agents.findById(agentId));
  if (!helper?.parentAgentId) return null;
  const [orchestrator, sub] = await Promise.all([
    Agents.findById(helper.parentAgentId),
    Subagents.findByAgentId(helper.id),
  ]);
  if (!orchestrator || !sub) return null;
  const runtime = await resolveThreadRuntimeConfig(sub.parentThreadId);
  const override = runtime?.agentOverrides.get(orchestrator.id);
  const baseAccess = override?.toolAccess ?? agentToolAccess(orchestrator);
  const own = agentToolAccess(helper);
  const catalog = await loadToolNameCatalog();
  return {
    orchestrator,
    parentThreadId: sub.parentThreadId,
    baseAccess,
    fromThreadOverride: override?.toolAccess !== undefined,
    access: narrowToolAccess(baseAccess, own, catalog),
    threadToolOverrides: override?.toolOverrides,
    mcpServerIds: resolveEnabledMcpServers(orchestrator.mcpServers, override?.mcpServers),
    mcpLimit: helperMcpLimit(own),
    catalog,
  };
}

/**
 * Where a grant the user gives on a helper's allow-list prompt is stored.
 * The gap is filled where it is: a tool the orchestrator lacks is granted to
 * the orchestrator (its row for "Always allow", its parent-thread entry for
 * "Allow for this thread"; "Always allow" also updates that entry when the
 * orchestrator's access there comes from it), and a helper narrowed by
 * `tools` also gets the tool added to its own list. Granting a tool the
 * orchestrator already has never touches the orchestrator, so its access
 * cannot be narrowed by a helper's prompt. An MCP tool reaches a helper
 * only from its orchestrator's enabled servers, so the orchestrator already
 * has it (allow lists do not gate MCP tools): only the helper's own list is
 * written, never the orchestrator's row.
 */
export async function grantHelperTool(
  policy: HelperToolPolicy,
  helperId: string,
  toolId: string,
  decision: 'allow_agent' | 'allow_thread'
): Promise<void> {
  if (!isMcpToolEntry(toolId) && !accessAllowsTool(policy.baseAccess, toolId, policy.catalog)) {
    const { orchestrator, parentThreadId, baseAccess } = policy;
    if (decision === 'allow_agent') {
      if (!(await appendAgentToolAllowList(orchestrator.id, toolId))) {
        throw new Error(`Agent not found: ${orchestrator.id}`);
      }
    }
    if (decision === 'allow_thread' || policy.fromThreadOverride) {
      const granted = await ThreadParticipants.grantToolAccess(
        parentThreadId,
        orchestrator.id,
        toolId,
        baseAccess.allowList,
        baseAccess.denyList
      );
      if (!granted)
        throw new Error(`Agent ${orchestrator.id} is not a participant in ${parentThreadId}`);
    }
  }
  const helper = await Agents.findById(helperId);
  if (helper?.toolAccessMode === 'allow_list') {
    await appendAgentToolAllowList(helperId, toolId);
  }
}
