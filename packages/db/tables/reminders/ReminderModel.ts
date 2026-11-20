/**
 * Reminders: per-item settings (`reminder_settings`, one row per item,
 * keyed by the generated `item_key`) and the delivery ledger
 * (`reminder_deliveries`, one row per fired reminder key). Plain SQL; the
 * server's reminders domain validates input before it gets here.
 */
import { getDb, type DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import type {
  ReminderItemRef,
  ReminderOffset,
  ReminderSettings,
  ReminderSoundId,
} from '@snaglet/shared/types';

interface RawSettings {
  kind: ReminderItemRef['kind'];
  event_id: string | null;
  table_id: string | null;
  entry_id: string | null;
  field_id: string | null;
  automation_id: string | null;
  enabled: boolean;
  at_start: boolean;
  offsets: ReminderOffset[];
  sound: ReminderSoundId;
  updated_at: string;
}

const COLUMNS = `kind, event_id, table_id, entry_id::text AS entry_id, field_id, automation_id,
  enabled, at_start, offsets, sound,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;

/** The stable key of an item: the same text the database generates as `item_key`. */
export function reminderItemKey(item: ReminderItemRef): string {
  if (item.kind === 'event') return `event:${item.eventId}`;
  if (item.kind === 'automation') return `automation:${item.automationId}`;
  return `table_entry:${item.tableId}:${item.entryId}:${item.fieldId}`;
}

/**
 * What every delivery key of an item starts with: a delivery key is
 * `<item key>@<occurrence start>#<offset>` (upcomingReminders.ts).
 */
export function reminderDeliveryKeyPrefix(item: ReminderItemRef): string {
  return `${reminderItemKey(item)}@`;
}

function toItem(raw: RawSettings): ReminderItemRef {
  if (raw.kind === 'event') return { kind: 'event', eventId: raw.event_id! };
  if (raw.kind === 'automation') return { kind: 'automation', automationId: raw.automation_id! };
  return {
    kind: 'table_entry',
    tableId: raw.table_id!,
    entryId: raw.entry_id!,
    fieldId: raw.field_id!,
  };
}

function toSettings(raw: RawSettings): ReminderSettings {
  return {
    item: toItem(raw),
    enabled: raw.enabled,
    atStart: raw.at_start,
    offsets: Array.isArray(raw.offsets) ? raw.offsets : [],
    sound: raw.sound,
    updatedAt: raw.updated_at,
  };
}

/** The id columns of an item, in insert order. */
function itemColumns(item: ReminderItemRef): (string | null)[] {
  return [
    item.kind,
    item.kind === 'event' ? item.eventId : null,
    item.kind === 'table_entry' ? item.tableId : null,
    item.kind === 'table_entry' ? item.entryId : null,
    item.kind === 'table_entry' ? item.fieldId : null,
    item.kind === 'automation' ? item.automationId : null,
  ];
}

interface SaveReminderSettingsInput {
  enabled: boolean;
  atStart: boolean;
  offsets: readonly ReminderOffset[];
  sound: ReminderSoundId;
}

export const Reminders = {
  async get(
    item: ReminderItemRef,
    runner: DbQueryable = getDb()
  ): Promise<ReminderSettings | null> {
    const { rows } = await runner.query<RawSettings>(
      `SELECT ${COLUMNS} FROM public.reminder_settings WHERE item_key = $1`,
      [reminderItemKey(item)]
    );
    return rows[0] ? toSettings(rows[0]) : null;
  },

  /** Insert or replace an item's settings. */
  async save(
    item: ReminderItemRef,
    input: SaveReminderSettingsInput,
    runner: DbQueryable = getDb()
  ): Promise<ReminderSettings> {
    const { rows } = await runner.query<RawSettings>(
      `INSERT INTO public.reminder_settings
         (kind, event_id, table_id, entry_id, field_id, automation_id, enabled, at_start, offsets, sound)
       VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (item_key) DO UPDATE
         SET enabled = EXCLUDED.enabled, at_start = EXCLUDED.at_start,
             offsets = EXCLUDED.offsets, sound = EXCLUDED.sound, updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        ...itemColumns(item),
        input.enabled,
        input.atStart,
        JSON.stringify(input.offsets),
        input.sound,
      ]
    );
    return toSettings(rows[0]!);
  },

  /** Remove an item's settings; true when there were any. */
  async remove(item: ReminderItemRef, runner: DbQueryable = getDb()): Promise<boolean> {
    const result = await runner.query('DELETE FROM public.reminder_settings WHERE item_key = $1', [
      reminderItemKey(item),
    ]);
    return (result.rowCount ?? 0) > 0;
  },

  /** Every enabled item that fires something (at the start or an offset). */
  async listActive(runner: DbQueryable = getDb()): Promise<ReminderSettings[]> {
    const { rows } = await runner.query<RawSettings>(
      `SELECT ${COLUMNS} FROM public.reminder_settings
        WHERE enabled AND (at_start OR jsonb_array_length(offsets) > 0)
        ORDER BY item_key`
    );
    return rows.map(toSettings);
  },

  /**
   * Record a delivery. True when this call recorded it (the key was new), so
   * exactly one caller delivers each reminder.
   */
  async recordDelivery(
    key: string,
    deliveredAt: Date,
    runner: DbQueryable = getDb()
  ): Promise<boolean> {
    const { rows } = await runner.query<{ key: string }>(
      `INSERT INTO public.reminder_deliveries (key, delivered_at) VALUES ($1, $2::timestamptz)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, deliveredAt.toISOString()]
    );
    return rows.length > 0;
  },

  /** Drop the ledger rows of these items (items that are gone); the count removed. */
  async deleteDeliveriesOf(
    items: readonly ReminderItemRef[],
    runner: DbQueryable = getDb()
  ): Promise<number> {
    if (items.length === 0) return 0;
    const result = await runner.query(
      `DELETE FROM public.reminder_deliveries d
        WHERE EXISTS (
          SELECT 1 FROM unnest($1::text[]) AS p(prefix)
           WHERE left(d.key, length(p.prefix)) = p.prefix
        )`,
      [items.map(reminderDeliveryKeyPrefix)]
    );
    return result.rowCount ?? 0;
  },

  /** Drop ledger rows delivered before `before`; the count removed. */
  async pruneDeliveries(before: Date, runner: DbQueryable = getDb()): Promise<number> {
    const result = await runner.query(
      'DELETE FROM public.reminder_deliveries WHERE delivered_at < $1::timestamptz',
      [before.toISOString()]
    );
    return result.rowCount ?? 0;
  },

  /**
   * Remove row settings whose entry no longer exists (entries have no foreign
   * key). A table that is gone or not active is skipped: its purge cascades.
   */
  async pruneOrphanEntries(runner: DbQueryable = getDb()): Promise<number> {
    const { rows } = await runner.query<{ table_id: string; table_name: string }>(
      `SELECT DISTINCT s.table_id, t.table_name FROM public.reminder_settings s
         JOIN public.table_catalog t ON t.id = s.table_id AND t.origin = 'custom' AND t.state = 'active'
        WHERE s.kind = 'table_entry'`
    );
    let removed = 0;
    for (const row of rows) {
      const result = await runner.query(
        `DELETE FROM public.reminder_settings s
          WHERE s.kind = 'table_entry' AND s.table_id = $1
            AND NOT EXISTS (SELECT 1 FROM ONLY user_tables.${quoteIdentifier(row.table_name)} e
                             WHERE e.id = s.entry_id)`,
        [row.table_id]
      );
      removed += result.rowCount ?? 0;
    }
    return removed;
  },
};
