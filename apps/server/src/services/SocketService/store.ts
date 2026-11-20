import { SocketSessions } from '@snaglet/db/tables/socket_sessions';
import type { SocketSession } from './types';

export async function getSession(
  sessionId: string | null | undefined
): Promise<SocketSession | undefined> {
  if (!sessionId) return undefined;

  const row = await SocketSessions.findSocketSessionById(sessionId);
  if (!row) return undefined;

  return {
    id: row.id,
    agentId: row.agentId,
    threadId: row.threadId,
    participantAgentIds: row.participantAgentIds ?? [],
    createdAt: new Date(row.createdAt).getTime(),
  };
}

export async function setSession(session: SocketSession): Promise<void> {
  await SocketSessions.upsertSocketSession({
    id: session.id,
    agentId: session.agentId,
    threadId: session.threadId,
    participantAgentIds: session.participantAgentIds,
  });
}

export async function setSessionParticipants(
  sessionId: string,
  participantAgentIds: string[]
): Promise<void> {
  await SocketSessions.updateSocketSessionParticipants(sessionId, participantAgentIds);
}

async function deleteSession(sessionId: string): Promise<void> {
  await SocketSessions.deleteSocketSession(sessionId);
}
