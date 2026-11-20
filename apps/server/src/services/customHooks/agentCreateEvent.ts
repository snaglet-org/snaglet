/**
 * agentCreateEvent — the single builder for the `agent:create` hook
 * payload, shared by the live emit site (AgentService.create) and the test
 * console's resolver so both deliver the same shape: the agent's identity,
 * role, provider/model, system prompt, tool-access situation (mode +
 * allow/deny lists), MCP servers, and truthful creator attribution.
 */
import { getDb } from '@snaglet/db';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { getCurrentActor } from '@server/realtime/actorContext';
import { hooks, type HookEventMap } from '@server/services/HookService';

type AgentCreateEvent = HookEventMap['agent:create'];
type AgentCreatedBy = AgentCreateEvent['createdBy'];

function currentCreatedBy(): AgentCreatedBy {
  const actor = getCurrentActor();
  return actor
    ? { kind: actor.actorKind, ...(actor.actorKind === 'system' ? {} : { id: actor.actorId }) }
    : { kind: 'system' };
}

export async function buildAgentCreateEvent(
  agentId: string,
  createdByOverride?: AgentCreatedBy
): Promise<AgentCreateEvent | null> {
  const { rows } = await getDb().query<{
    id: string;
    name: string;
    role: string | null;
    identity: string | null;
    system_prompt: string | null;
    provider_id: string | null;
    model_id: string | null;
    tool_access_mode: string | null;
    tool_access_allow_list: string[] | null;
    tool_access_deny_list: string[] | null;
    mcp_servers: string[] | null;
  }>(
    `SELECT id, name, role, identity, system_prompt, provider_id, model_id,
            tool_access_mode, tool_access_allow_list, tool_access_deny_list,
            mcp_servers
       FROM agents WHERE id=$1`,
    [agentId]
  );
  const row = rows[0];
  if (!row) return null;
  const createdBy = createdByOverride ?? currentCreatedBy();
  return {
    id: row.id,
    createdBy,
    name: row.name,
    role: row.role,
    identity: row.identity,
    providerId: row.provider_id,
    modelId: row.model_id,
    systemPrompt: row.system_prompt,
    toolAccess: {
      mode: row.tool_access_mode,
      allowList: row.tool_access_allow_list,
      denyList: row.tool_access_deny_list,
    },
    mcpServers: Array.isArray(row.mcp_servers) ? row.mcp_servers : [],
  };
}

/** Fire-and-forget emit — never throws, never blocks the create path. */
export function emitAgentCreate(agentId: string): void {
  // Capture before the fire-and-forget boundary so attribution never depends
  // on AsyncLocalStorage surviving the asynchronous row lookup.
  const createdBy = currentCreatedBy();
  void buildAgentCreateEvent(agentId, createdBy)
    .then((event) => {
      if (event) hooks.emit('agent:create', event);
    })
    .catch((err: unknown) => {
      logger.warn('agent:create hook emit failed', { agentId, error: getErrorMessage(err) });
    });
}
