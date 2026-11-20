/**
 * Reminder request parsing: the item from the query string, the settings
 * body, and the 404 when the item does not exist. Every refusal is a
 * readable 400 / 404 AppError.
 */
import { getDb } from '@snaglet/db/db';
import { Automations } from '@snaglet/db/tables/automations';
import { CalendarEvents } from '@snaglet/db/tables/calendar_events';
import { TableEntries } from '@snaglet/db/tables/table_entries';
import {
  ErrorCode,
  REMINDER_SOUNDS,
  REMINDER_UNITS,
  type ReminderItemRef,
  type ReminderOffset,
  type ReminderSoundId,
  type ReminderUnit,
  type UpdateReminderSettingsRequest,
} from '@snaglet/shared/types';
import { AppError, isRecord } from '@snaglet/shared/utils';

/** Most advance reminders one item keeps. */
const MAX_REMINDER_OFFSETS = 10;
/** Largest "N before" amount. */
const MAX_REMINDER_AMOUNT = 999;

const UNIT_MS: Record<ReminderUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export function reminderBadRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, 400);
}

function reminderNotFound(message: string): AppError {
  return new AppError(message, ErrorCode.NOT_FOUND, 404);
}

/** How long an offset is, in milliseconds. */
export function offsetMs(offset: ReminderOffset): number {
  return offset.amount * UNIT_MS[offset.unit];
}

function idParam(query: Record<string, unknown>, name: string): string {
  const value = query[name];
  if (typeof value !== 'string' || !value.trim())
    throw reminderBadRequest(`${name} is required for this kind.`);
  const id = value.trim();
  if (!ID.test(id)) throw reminderBadRequest(`${name} is not a valid id.`);
  return id;
}

/**
 * The item a request names: `kind=event&eventId=…`,
 * `kind=table_entry&tableId=…&entryId=…&fieldId=…` or
 * `kind=automation&automationId=…`.
 */
export function parseReminderItem(query: Record<string, unknown>): ReminderItemRef {
  const kind = query.kind;
  if (kind === 'event') return { kind, eventId: idParam(query, 'eventId') };
  if (kind === 'automation') return { kind, automationId: idParam(query, 'automationId') };
  if (kind === 'table_entry') {
    const tableId = idParam(query, 'tableId');
    const entryId = idParam(query, 'entryId').toLowerCase();
    if (!UUID.test(entryId)) throw reminderBadRequest('entryId must be a row id (a UUID).');
    return { kind, tableId, entryId, fieldId: idParam(query, 'fieldId') };
  }
  throw reminderBadRequest('kind must be event, table_entry or automation.');
}

/**
 * A PUT body: booleans, a sound from the shared list, and at most
 * {@link MAX_REMINDER_OFFSETS} offsets of whole 1–999 minutes / hours / days.
 * Offsets that name the same moment ("60 minutes" and "1 hour") keep the
 * first; the rest keep their order.
 */
export function parseReminderSettings(body: unknown): UpdateReminderSettingsRequest {
  if (!isRecord(body)) throw reminderBadRequest('Send the settings as a JSON object.');
  const { enabled, atStart, offsets, sound } = body;
  if (typeof enabled !== 'boolean') throw reminderBadRequest('enabled must be true or false.');
  if (typeof atStart !== 'boolean') throw reminderBadRequest('atStart must be true or false.');
  if (typeof sound !== 'string' || !(REMINDER_SOUNDS as readonly string[]).includes(sound))
    throw reminderBadRequest(`sound must be one of ${REMINDER_SOUNDS.join(', ')}.`);
  if (!Array.isArray(offsets)) throw reminderBadRequest('offsets must be a list.');
  const kept: ReminderOffset[] = [];
  const seen = new Set<number>();
  for (const raw of offsets) {
    if (!isRecord(raw)) throw reminderBadRequest('Each offset is {amount, unit}.');
    const { amount, unit } = raw;
    if (
      typeof amount !== 'number' ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > MAX_REMINDER_AMOUNT
    )
      throw reminderBadRequest(
        `Each offset amount must be a whole number from 1 to ${MAX_REMINDER_AMOUNT}.`
      );
    if (typeof unit !== 'string' || !(REMINDER_UNITS as readonly string[]).includes(unit))
      throw reminderBadRequest(`Each offset unit must be one of ${REMINDER_UNITS.join(', ')}.`);
    const offset: ReminderOffset = { amount, unit: unit as ReminderUnit };
    const ms = offsetMs(offset);
    if (seen.has(ms)) continue;
    seen.add(ms);
    kept.push(offset);
  }
  if (kept.length > MAX_REMINDER_OFFSETS)
    throw reminderBadRequest(`An item keeps at most ${MAX_REMINDER_OFFSETS} reminders before it.`);
  return { enabled, atStart, offsets: kept, sound: sound as ReminderSoundId };
}

/**
 * 404 unless the item exists: a live (not deleted) event, a non-canceled
 * automation, or a row of an active table with that date / datetime field.
 */
export async function assertReminderItemExists(item: ReminderItemRef): Promise<void> {
  if (item.kind === 'event') {
    const event = await CalendarEvents.findById(item.eventId);
    if (!event || event.archived) throw reminderNotFound('Event not found');
    return;
  }
  if (item.kind === 'automation') {
    const automation = await Automations.findById(item.automationId);
    if (!automation || automation.status === 'cancelled')
      throw reminderNotFound('Automation not found');
    if (automation.whenKind === 'first_open') {
      throw reminderBadRequest(
        `"${automation.name}" runs when Snaglet first opens, so it has no start time to remind before.`
      );
    }
    return;
  }
  const { rows } = await getDb().query<{ type: string }>(
    `SELECT f.type FROM public.table_fields f
       JOIN public.table_catalog t ON t.id = f.table_id
      WHERE f.id = $1 AND f.table_id = $2 AND f.state = 'active'
        AND t.state = 'active' AND t.origin = 'custom'`,
    [item.fieldId, item.tableId]
  );
  const field = rows[0];
  if (!field) throw reminderNotFound('Table field not found');
  if (field.type !== 'date' && field.type !== 'datetime')
    throw reminderBadRequest('Reminders need a date or datetime field.');
  try {
    await TableEntries.getEntry(item.tableId, item.entryId);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404)
      throw reminderNotFound('Row not found');
    throw error;
  }
}
