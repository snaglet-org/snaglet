/**
 * SocketSessionModel — Model class for the socket_sessions table.
 *
 * Extends the base Model with socket-session-specific queries
 * (upsert, update participants, delete).
 */

import { Model } from '@snaglet/db/Model';

export interface SocketSessionRow {
  id: string;
  agentId: string;
  threadId: string;
  participantAgentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UpsertSocketSessionInput {
  id: string;
  agentId: string;
  threadId: string;
  participantAgentIds: string[];
}

class SocketSessionModelClass extends Model<SocketSessionRow, UpsertSocketSessionInput> {
  constructor() {
    super({ table: 'socket_sessions', primaryKey: 'id' });
  }

  async findSocketSessionById(id: string): Promise<SocketSessionRow | null> {
    return this.queryOne<SocketSessionRow>(`SELECT * FROM socket_sessions WHERE id = $1 LIMIT 1`, [
      id,
    ]);
  }

  async upsertSocketSession(input: UpsertSocketSessionInput): Promise<SocketSessionRow> {
    const row = await this.queryOne<SocketSessionRow>(
      `INSERT INTO socket_sessions (
         id, agent_id, thread_id, participant_agent_ids
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         agent_id = EXCLUDED.agent_id,
         thread_id = EXCLUDED.thread_id,
         participant_agent_ids = EXCLUDED.participant_agent_ids,
         updated_at = NOW()
       RETURNING *`,
      [input.id, input.agentId, input.threadId, input.participantAgentIds]
    );
    return row!;
  }

  async updateSocketSessionParticipants(id: string, participantAgentIds: string[]): Promise<void> {
    await this.pool.query(
      `UPDATE socket_sessions
       SET participant_agent_ids = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, participantAgentIds]
    );
  }

  async deleteSocketSession(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM socket_sessions WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }
}

export const SocketSessions = new SocketSessionModelClass();
