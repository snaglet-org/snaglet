import { getErrorMessage } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { messagesDbPath, querySqliteJson, sqlStringLiteralBody } from './runners';

const handler: ToolHandler = async (params) => {
  const { contact, limit = 25 } = params as { contact: string; limit?: number };

  if (!contact || typeof contact !== 'string') {
    return JSON.stringify({ error: 'Missing required parameter: contact' });
  }

  const dbPath = messagesDbPath();
  // Normalize contact: strip spaces/dashes/parens for phone matching
  const normalized = sqlStringLiteralBody(contact.replace(/[\s\-()]/g, ''));
  const safeLimit = Math.min(Number(limit) || 25, 100);

  const sql =
    `SELECT ` +
    `datetime(m.date / 1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') AS sent_at, ` +
    `CASE m.is_from_me WHEN 1 THEN 'me' ELSE h.id END AS sender, ` +
    `m.text, m.is_from_me, m.service ` +
    `FROM message m ` +
    `JOIN chat_message_join cmj ON m.rowid = cmj.message_id ` +
    `JOIN chat c ON cmj.chat_id = c.rowid ` +
    `JOIN chat_handle_join chj ON c.rowid = chj.chat_id ` +
    `JOIN handle h ON chj.handle_id = h.rowid ` +
    `WHERE h.id LIKE '%${normalized}%' AND m.text IS NOT NULL ` +
    `ORDER BY m.date DESC LIMIT ${safeLimit};`;

  try {
    const stdout = await querySqliteJson(dbPath, sql);
    const rows: Array<{
      sent_at: string;
      sender: string;
      text: string;
      is_from_me: number;
      service: string;
    }> = stdout.trim() ? JSON.parse(stdout) : [];

    if (rows.length === 0) {
      return JSON.stringify({
        contact,
        messages: [],
        note: `No messages found for contact: ${contact}. Verify the contact string matches a handle in chat.db.`,
      });
    }

    return JSON.stringify({
      contact,
      count: rows.length,
      messages: rows.map((r) => ({
        sent_at: r.sent_at,
        sender: r.sender,
        text: r.text,
        is_from_me: r.is_from_me === 1,
        service: r.service,
      })),
    });
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    return JSON.stringify({
      error: `Failed to read messages: ${msg}`,
      detail:
        'Ensure Full Disk Access is granted to the Snaglet server process in System Settings \u2192 Privacy & Security \u2192 Full Disk Access, and that sqlite3 is installed (brew install sqlite).',
    });
  }
};

export default handler;
