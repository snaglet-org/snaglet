/**
 * missingToolLookup — what dispatch asks when a call names a tool the run's
 * tool map lacks. The map is built once, when the run starts, so a custom
 * tool the agent creates mid-run is not in it; and a tool the agent's access
 * hides is not in it either. This re-resolves the agent's tools with the
 * same inputs the run started from, only on such a miss:
 *
 *   - `reachable`: the tool is in the run's execution set now. Dispatch runs it
 *     with every usual check (allow-list escalation, confirmation, deny rules).
 *   - `blocked`: the tool exists for the agent (access mode All would reach
 *     it) but its effective access hides it. Dispatch says so, and where to
 *     allow it, instead of letting the model conclude the tool is gone.
 *   - `unknown`: neither. Dispatch tells the model to search.
 *
 * Any failure reads as `unknown`: the miss is refused either way.
 */

import {
  resolveAgentTools,
  resolveAgentToolsForExecution,
  SKILL_TOOL_ID,
  type ResolvedAgentTool,
  type ResolveAgentToolsOptions,
} from '@server/services/AgentToolResolver';
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { findResolvedAgentTool } from '@server/services/ToolService/lib/resolveAgentTool';
import { logger } from '@server/config/logger';

type MissingToolResult =
  | { kind: 'reachable'; tool: ResolvedAgentTool }
  /** `by`: whose access hides it, the agent's own or this thread's override. */
  | { kind: 'blocked'; tool: ToolRow; by: 'agent' | 'thread' }
  | { kind: 'unknown' };

export type MissingToolLookup = (name: string) => Promise<MissingToolResult>;

export interface MissingToolLookupOptions {
  /** The run's effective tool access (thread override ?? agent base). */
  access: ToolAccessConfig;
  /** Where `access` comes from, so a blocked tool names the right setting. Default agent. */
  accessFrom?: 'agent' | 'thread';
  threadOverrides?: ResolveAgentToolsOptions['threadOverrides'];
  mcpServerOverride?: ResolveAgentToolsOptions['mcpServerOverride'];
}

export function createMissingToolLookup(
  agentId: string,
  { access, accessFrom = 'agent', threadOverrides, mcpServerOverride }: MissingToolLookupOptions
): MissingToolLookup {
  const shared = { threadOverrides, mcpServerOverride };
  return async (name) => {
    try {
      // The execution set the run started from (contextAssembly): the whole
      // catalog in allow-list mode, where an unlisted tool asks a person.
      const execution =
        access.mode === 'allow_list'
          ? await resolveAgentToolsForExecution(agentId, shared)
          : await resolveAgentTools(agentId, { ...shared, access });
      const reachable = findResolvedAgentTool(execution, name);
      // `skill` is in the run's map only for agents with a skill; a late hit
      // means it was left out on purpose.
      if (reachable && reachable.tool.id !== SKILL_TOOL_ID)
        return { kind: 'reachable', tool: reachable };
      if (access.mode === 'allow_list') return { kind: 'unknown' };
      const everything = await resolveAgentToolsForExecution(agentId, shared);
      const blocked = findResolvedAgentTool(everything, name);
      if (blocked && blocked.tool.id !== SKILL_TOOL_ID)
        return { kind: 'blocked', tool: blocked.tool, by: accessFrom };
    } catch (err) {
      logger.warn('[toolDispatch] missing-tool lookup failed', {
        agentId,
        name,
        error: getErrorMessage(err),
      });
    }
    return { kind: 'unknown' };
  };
}
