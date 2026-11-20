import { agentService } from '@server/services/AgentService';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ToolHandler } from '@server/services/ToolService/types';

interface GetAgentParams {
  agent?: string;
  listAll?: boolean;
  includeArchived?: boolean;
}

const handler: ToolHandler = async (input) => {
  const { agent, listAll, includeArchived } = input as GetAgentParams;

  if (listAll) {
    const agents = await agentService.list({ includeArchived: includeArchived === true });
    return JSON.stringify({
      success: true,
      count: agents.length,
      agents: agents.map((a: SnagletAgent) => ({
        id: a.id,
        name: a.name,
        role: a.role ?? null,
        model: a.modelId ?? null,
        provider: a.provider ?? null,
        toolAccessMode: a.toolAccessMode ?? null,
      })),
    });
  }

  const key = (agent ?? '').trim();
  if (!key) {
    return JSON.stringify({
      success: false,
      error:
        "Provide 'agent' (id or name) to fetch one record, or set listAll=true for the roster.",
    });
  }

  let found = await agentService.get(key);
  if (!found) {
    const all = await agentService.list({ includeArchived: true });
    found = all.find((a: SnagletAgent) => a.name.toLowerCase() === key.toLowerCase());
  }

  if (!found) {
    return JSON.stringify({
      success: false,
      error: `No agent found matching '${key}' (by id or name).`,
    });
  }

  return JSON.stringify({
    success: true,
    agent: {
      id: found.id,
      name: found.name,
      role: found.role ?? null,
      model: found.modelId ?? null,
      provider: found.provider ?? null,
      toolAccessMode: found.toolAccessMode ?? null,
      toolAllowList: found.toolAccessAllowList ?? null,
      toolDenyList: found.toolAccessDenyList ?? null,
      systemPrompt: found.systemPrompt ?? null,
      identity: found.identity ?? null,
      createdAt: found.createdAt ?? null,
      updatedAt: found.updatedAt ?? null,
    },
  });
};

export default handler;
