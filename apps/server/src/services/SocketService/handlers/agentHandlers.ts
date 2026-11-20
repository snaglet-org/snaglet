import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { wsService } from '@server/services/WebSocketService';
import { agentService } from '@server/services/AgentService';
import { logger } from '@server/config/logger';

export function registerAgentListHandler(): void {
  wsService.registerHandler<null>('socket:agents:list', async (_payload, meta) => {
    logger.info('[socket] agents:list requested');

    const agents = await agentService.list();
    const agentStatuses = await Promise.all(
      agents.map(async (agent) => {
        const hasCredential = !!(await providerCredentialService.getSecret(agent.provider));
        return {
          id: agent.id,
          label: agent.name,
          model: agent.modelId,
          status: (hasCredential ? 'online' : 'offline') as 'online' | 'offline',
        };
      })
    );

    wsService.sendToClient(meta.clientId, {
      type: 'socket:agents',
      payload: { agents: agentStatuses },
    });
  });
}
