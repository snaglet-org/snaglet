/**
 * calendar {op: "get_reminders" | "set_reminders"}: one item's reminder
 * settings, through the same functions the /api/reminders/settings routes
 * call (parse, assert the item exists, save or remove, refresh the
 * reminder-table set, emit `reminders:changed`). The item is an event
 * (`id`), a table row's date field (`table`, `entry_id`, `field`) or an
 * automation (`automation_id`). A row needs table read access; an
 * automation needs automation read access (access.ts), for get and set alike,
 * and an external MCP client's set also needs the curated automation write
 * (own-only by default).
 */
import { Reminders } from '@snaglet/db/tables/reminders';
import {
  DEFAULT_REMINDER_SOUND,
  type ReminderItemRef,
  type ReminderOffset,
  type ReminderSettings,
  type ReminderUnit,
} from '@snaglet/shared/types';
import {
  assertReminderItemExists,
  parseReminderItem,
  parseReminderSettings,
} from '@server/domains/reminders/reminderInput';
import { refreshReminderTables } from '@server/domains/reminders/upcomingReminders';
import { emitRemindersChanged } from '@server/realtime/surfaces/reminders';
import { badInput } from '@server/services/ToolService/tools/database/_shared/input';
import {
  assertAutomationAccess,
  assertAutomationWriteAccess,
  assertTableAccess,
  type CalendarCaller,
} from './access';
import { resolveRowTarget } from './rows';

type Input = Record<string, unknown>;

const UNIT_LETTERS: Record<ReminderUnit, string> = { minutes: 'm', hours: 'h', days: 'd' };
const BEFORE = /^(\d{1,3})\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i;

function given(input: Input, key: string): boolean {
  return input[key] !== undefined && input[key] !== null;
}

/** The item one call names: exactly one of id, automation_id, or table + entry_id + field. */
async function reminderItem(input: Input, caller: CalendarCaller): Promise<ReminderItemRef> {
  const row = given(input, 'table') || given(input, 'entry_id') || given(input, 'field');
  const named = [given(input, 'id'), given(input, 'automation_id'), row].filter(Boolean).length;
  if (named !== 1)
    throw badInput(
      'name one item: id (an event), automation_id, or table + entry_id + field (a row)'
    );
  if (given(input, 'id')) {
    if (typeof input.id !== 'string') throw badInput('id must be an event id');
    return parseReminderItem({ kind: 'event', eventId: input.id });
  }
  if (given(input, 'automation_id')) {
    if (typeof input.automation_id !== 'string')
      throw badInput('automation_id must be an automation id');
    await assertAutomationAccess(caller, 'Reminders on an automation');
    return parseReminderItem({ kind: 'automation', automationId: input.automation_id });
  }
  await assertTableAccess(caller, 'read', 'Reminders on a table row');
  const target = await resolveRowTarget(input);
  return parseReminderItem({
    kind: 'table_entry',
    tableId: target.tableId,
    entryId: target.entryId,
    fieldId: target.field.id,
  });
}

function beforeText(offset: ReminderOffset): string {
  return `${offset.amount}${UNIT_LETTERS[offset.unit]}`;
}

function beforeOffsets(value: unknown): ReminderOffset[] {
  if (!Array.isArray(value)) throw badInput('before must be a list like ["15m", "1d"]');
  return value.map((item, index) => {
    const match = typeof item === 'string' ? BEFORE.exec(item.trim()) : null;
    if (!match) throw badInput(`before[${index}] must be like "15m", "2h" or "1d"`);
    const letter = (match[2] ?? '').charAt(0).toLowerCase();
    const unit: ReminderUnit = letter === 'm' ? 'minutes' : letter === 'h' ? 'hours' : 'days';
    return { amount: Number(match[1]), unit };
  });
}

function settingsView(settings: ReminderSettings | null) {
  if (!settings) return null;
  return {
    enabled: settings.enabled,
    at_start: settings.atStart,
    before: settings.offsets.map(beforeText),
    sound: settings.sound,
    updated_at: settings.updatedAt,
  };
}

function itemView(item: ReminderItemRef) {
  if (item.kind === 'event') return { kind: 'event', id: item.eventId };
  if (item.kind === 'automation') return { kind: 'automation', automation_id: item.automationId };
  return {
    kind: 'table_row',
    table_id: item.tableId,
    entry_id: item.entryId,
    field_id: item.fieldId,
  };
}

export async function getRemindersOp(input: Input, caller: CalendarCaller): Promise<unknown> {
  const item = await reminderItem(input, caller);
  return { item: itemView(item), reminders: settingsView(await Reminders.get(item)) };
}

/**
 * Saves the item's settings: the fields given over the current ones (or
 * the defaults: on, at the start, no advance reminders, the default sound).
 * `before` overwrites the list. `clear` removes the settings.
 */
export async function setRemindersOp(input: Input, caller: CalendarCaller): Promise<unknown> {
  const item = await reminderItem(input, caller);
  if (item.kind === 'automation')
    await assertAutomationWriteAccess(
      caller,
      item.automationId,
      'Setting reminders on an automation'
    );
  if (input.clear !== undefined && input.clear !== null) {
    if (input.clear !== true) throw badInput('clear must be true (or left out)');
    if (['enabled', 'at_start', 'before', 'sound'].some((key) => given(input, key)))
      throw badInput('clear removes the reminders; pass it alone');
    if (await Reminders.remove(item)) {
      await refreshReminderTables();
      emitRemindersChanged();
    }
    return { item: itemView(item), reminders: null };
  }
  const current = await Reminders.get(item);
  const settings = parseReminderSettings({
    enabled: given(input, 'enabled') ? input.enabled : (current?.enabled ?? true),
    atStart: given(input, 'at_start') ? input.at_start : (current?.atStart ?? true),
    offsets: given(input, 'before') ? beforeOffsets(input.before) : (current?.offsets ?? []),
    sound: given(input, 'sound') ? input.sound : (current?.sound ?? DEFAULT_REMINDER_SOUND),
  });
  await assertReminderItemExists(item);
  const saved = await Reminders.save(item, settings);
  await refreshReminderTables();
  emitRemindersChanged();
  return { item: itemView(item), reminders: settingsView(saved) };
}
