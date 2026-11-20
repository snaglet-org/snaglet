import { getErrorMessage } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { messagesDbPath, querySqliteJson } from './runners';

const handler: ToolHandler = async (params) => {
  const { limit = 20 } = params as { limit?: number };

  const dbPath = messagesDbPath();
  const safeLimit = Math.min(Number(limit) || 20, 100);

  const sql =
    `SELECT c.rowid AS chat_id, c.display_name, c.service_name, ` +
    `group_concat(h.id, ', ') AS participants, ` +
    `datetime(MAX(m.date) / 1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') AS last_activity, ` +
    `(SELECT text FROM message WHERE rowid = ` +
    `(SELECT message_id FROM chat_message_join WHERE chat_id = c.rowid ORDER BY message_id DESC LIMIT 1)) AS last_message_preview ` +
    `FROM chat c ` +
    `LEFT JOIN chat_handle_join chj ON c.rowid = chj.chat_id ` +
    `LEFT JOIN handle h ON chj.handle_id = h.rowid ` +
    `LEFT JOIN chat_message_join cmj ON c.rowid = cmj.chat_id ` +
    `LEFT JOIN message m ON cmj.message_id = m.rowid ` +
    `GROUP BY c.rowid ` +
    `ORDER BY MAX(m.date) DESC ` +
    `LIMIT ${safeLimit};`;

  try {
    const stdout = await querySqliteJson(dbPath, sql);
    const rows: Array<{
      chat_id: number;
      display_name: string | null;
      service_name: string;
      participants: string | null;
      last_activity: string;
      last_message_preview: string | null;
    }> = stdout.trim() ? JSON.parse(stdout) : [];

    return JSON.stringify({
      count: rows.length,
      conversations: rows.map((r) => ({
        chat_id: r.chat_id,
        display_name: r.display_name ?? null,
        service: r.service_name,
        participants: r.participants ? r.participants.split(', ') : [],
        last_activity: r.last_activity,
        last_message_preview: r.last_message_preview ? r.last_message_preview.slice(0, 120) : null,
      })),
    });
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    return JSON.stringify({
      error: `Failed to list conversations: ${msg}`,
      detail:
        'Ensure Full Disk Access is granted to the Snaglet server process in System Settings \u2192 Privacy & Security \u2192 Full Disk Access, and that sqlite3 is installed.',
    });
  }
};

export default handler;
