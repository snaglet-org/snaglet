import { Model } from '@snaglet/db/Model';
import type { NotificationRecord, NotificationType } from '@snaglet/shared/types';

export interface CreateNotificationInput {
  id: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  threadId?: string | null;
  agentId?: string | null;
  runId?: string | null;
}

class NotificationModelClass extends Model<NotificationRecord, CreateNotificationInput> {
  constructor() {
    super({
      table: 'notifications',
      primaryKey: 'id',
      updatedAtColumn: null,
      createdAtColumn: 'created_at',
    });
  }

  async insert(input: CreateNotificationInput): Promise<NotificationRecord> {
    return this.create({
      ...input,
      body: input.body ?? null,
      threadId: input.threadId ?? null,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
    });
  }

  async listRecent(limit = 50): Promise<NotificationRecord[]> {
    return this.query<NotificationRecord>(
      `SELECT * FROM notifications
       WHERE NOT dismissed
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)]
    );
  }

  async countUnread(): Promise<number> {
    const row = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notifications
       WHERE NOT read AND NOT dismissed`
    );
    return row ? parseInt(row.count, 10) : 0;
  }

  async markRead(id: string): Promise<NotificationRecord | null> {
    return this.queryOne<NotificationRecord>(
      `UPDATE notifications SET read = true WHERE id = $1 RETURNING *`,
      [id]
    );
  }

  async markAllRead(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE notifications SET read = true WHERE NOT read AND NOT dismissed`
    );
    return result.rowCount ?? 0;
  }

  async dismiss(id: string): Promise<NotificationRecord | null> {
    return this.queryOne<NotificationRecord>(
      `UPDATE notifications SET dismissed = true WHERE id = $1 RETURNING *`,
      [id]
    );
  }

  async dismissAll(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE notifications SET dismissed = true WHERE NOT dismissed`
    );
    return result.rowCount ?? 0;
  }

  /**
   * Dismiss every still-visible notification created before `createdBefore`
   * whose id starts with `prefix`. The server marks agent-ask notifications
   * by id prefix (no type of their own without a migration) and sweeps them
   * at boot: the asks they announced lived in memory and died with the
   * previous process.
   */
  async dismissByIdPrefix(prefix: string, createdBefore: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE notifications SET dismissed = true
       WHERE NOT dismissed AND left(id, length($1)) = $1 AND created_at < $2`,
      [prefix, createdBefore]
    );
    return result.rowCount ?? 0;
  }

  /**
   * Prune old dismissed notifications to prevent unbounded table growth.
   * Called periodically (e.g. on server start or via a schedule).
   */
  async pruneOld(olderThanDays = 30): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM notifications
       WHERE dismissed AND created_at < now() - ($1 || ' days')::interval`,
      [olderThanDays]
    );
    return result.rowCount ?? 0;
  }
}

export const Notifications = new NotificationModelClass();
