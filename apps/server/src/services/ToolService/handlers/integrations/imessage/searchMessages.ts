import { getErrorMessage } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { messagesDbPath, querySqliteJson, sqlStringLiteralBody } from './runners';

const handler: ToolHandler = async (params) => {
  const { query, limit = 20 } = params as { query: string; limit?: number };

  if (!query || typeof query !== 'string') {
    return JSON.stringify({ error: 'Missing required parameter: query' });
  }

  const dbPath = messagesDbPath();
  const safeQuery = sqlStringLiteralBody(query);
  const safeLimit = Math.min(Number(limit) || 20, 100);

  const sql =
    `SELECT ` +
    `datetime(m.date / 1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') AS sent_at, ` +
    `CASE m.is_from_me WHEN 1 THEN 'me' ELSE h.id END AS sender, ` +
    `m.text, m.is_from_me, m.service, ` +
    `c.display_name AS chat_name, ` +
    `group_concat(h2.id, ', ') AS participants ` +
    `FROM message m ` +
    `JOIN chat_message_join cmj ON m.rowid = cmj.message_id ` +
    `JOIN chat c ON cmj.chat_id = c.rowid ` +
    `LEFT JOIN handle h ON m.handle_id = h.rowid ` +
    `LEFT JOIN chat_handle_join chj2 ON c.rowid = chj2.chat_id ` +
    `LEFT JOIN handle h2 ON chj2.handle_id = h2.rowid ` +
    `WHERE m.text LIKE '%${safeQuery}%' AND m.text IS NOT NULL ` +
    `GROUP BY m.rowid ` +
    `ORDER BY m.date DESC ` +
    `LIMIT ${safeLimit};`;

  try {
    const stdout = await querySqliteJson(dbPath, sql);
    const rows: Array<{
      sent_at: string;
      sender: string;
      text: string;
      is_from_me: number;
      service: string;
      chat_name: string | null;
      participants: string | null;
    }> = stdout.trim() ? JSON.parse(stdout) : [];

    return JSON.stringify({
      query,
      count: rows.length,
      results: rows.map((r) => ({
        sent_at: r.sent_at,
        sender: r.sender,
        text: r.text,
        is_from_me: r.is_from_me === 1,
        service: r.service,
        chat_name: r.chat_name ?? null,
        participants: r.participants ? r.participants.split(', ') : [],
      })),
    });
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    return JSON.stringify({
      error: `Failed to search messages: ${msg}`,
      detail:
        'Ensure Full Disk Access is granted to the Snaglet server process in System Settings \u2192 Privacy & Security \u2192 Full Disk Access, and that sqlite3 is installed.',
    });
  }
};

export default handler;
