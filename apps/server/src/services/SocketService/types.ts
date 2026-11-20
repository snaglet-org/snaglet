import type { ProviderMessage } from '../ProviderChatService';

export type Message = ProviderMessage;

export interface SocketSession {
  id: string;
  agentId: string;
  threadId: string;
  participantAgentIds: string[];
  createdAt: number;
}
