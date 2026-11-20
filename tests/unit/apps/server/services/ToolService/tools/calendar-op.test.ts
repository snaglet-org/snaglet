/**
 * calendar(op) — dispatch, the CALENDAR_OP_FIELDS refusal (a field that
 * belongs only to another op, or to no op, is refused before any handler
 * runs), the calendar_read / calendar_write family aliases through the real
 * alias registry and op rules, and the definition's shape (standard tier,
 * only delete_event confirm-gated).
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
const record = (op: string) =>
  jest.fn(async (input: Record<string, unknown>) => {
    calls.push({ op, input });
    return { op };
  });

jest.mock('@server/services/ToolService/handlers/calendar/access', () => ({
  calendarCaller: () => ({
    agentId: null,
    tableAccess: async () => ({ allowed: true }),
    automationAccess: async () => ({ allowed: true }),
    automationWriteAccess: async () => ({ allowed: true }),
  }),
}));
jest.mock('@server/services/ToolService/handlers/calendar/calendars', () => ({
  listCalendarsOp: record('list'),
  createCalendarOp: record('create_calendar'),
}));
jest.mock('@server/services/ToolService/handlers/calendar/query', () => ({
  queryOp: record('query'),
}));
jest.mock('@server/services/ToolService/handlers/calendar/focus', () => ({
  focusOp: record('focus'),
}));
jest.mock('@server/services/ToolService/handlers/calendar/dates', () => ({
  datesOp: record('dates'),
}));
jest.mock('@server/services/ToolService/handlers/calendar/events', () => ({
  getEventOp: record('get_event'),
  createEventOp: record('create_event'),
  updateEventOp: record('update_event'),
  deleteEventOp: record('delete_event'),
  restoreEventOp: record('restore_event'),
}));
jest.mock('@server/services/ToolService/handlers/calendar/occurrences', () => ({
  moveOccurrenceOp: record('move_occurrence'),
  completeOccurrenceOp: record('complete_occurrence'),
  skipOccurrenceOp: record('skip_occurrence'),
}));
jest.mock('@server/services/ToolService/handlers/calendar/reminders', () => ({
  getRemindersOp: record('get_reminders'),
  setRemindersOp: record('set_reminders'),
}));

import calendarTool, {
  CALENDAR_OP_FIELDS,
} from '@server/services/ToolService/tools/calendar/calendar/tool';
import definition from '@server/services/ToolService/tools/calendar/calendar/definition';
import {
  CALENDAR_READ_OPS,
  CALENDAR_WRITE_OPS,
  evaluateOpAccess,
  resolveToolId,
  transformToolAliasParams,
} from '@snaglet/shared/utils';

const run = (input: Record<string, unknown>) => calendarTool(input, {}, undefined);
const schema = definition.parameters_schema as {
  properties: Record<string, { enum?: string[] }>;
};
const OPS = schema.properties.op.enum!;

beforeEach(() => {
  calls.length = 0;
});

describe('calendar(op) dispatch', () => {
  it('hands each op its input and returns compact JSON', async () => {
    const out = await run({ op: 'query', range: 'today', kinds: ['events'] });
    expect(JSON.parse(out as string)).toEqual({ op: 'query' });
    expect(calls).toEqual([
      { op: 'query', input: { op: 'query', range: 'today', kinds: ['events'] } },
    ]);
  });

  it('routes every op in the enum to its own handler', async () => {
    for (const op of OPS) await run({ op });
    expect(calls.map((call) => call.op)).toEqual(OPS);
  });

  it('refuses a missing or unknown op', async () => {
    await expect(run({ range: 'today' })).rejects.toThrow('op is required');
    await expect(run({ op: 'read' })).rejects.toThrow('op is required');
    expect(calls).toEqual([]);
  });

  it.each([
    ['query', { move_to: '2026-10-16' }, /`move_to` belongs to op move_occurrence/],
    ['query', { rev: '3' }, /`rev` belongs to op/],
    ['list', { range: 'today' }, /`range` belongs to op query/],
    ['dates', { rev: '3' }, /`rev` belongs to op/],
    [
      'get_event',
      { title: 'x' },
      /`title` belongs to op create_calendar \| create_event \| update_event/,
    ],
    ['create_event', { rev: '1', title: 'x', start: '2026-10-15' }, /`rev` belongs to op/],
    ['create_event', { before: ['15m'], title: 'x' }, /`before` belongs to op set_reminders/],
    ['delete_event', { id: 'e1', rev: '1', title: 'x' }, /`title` belongs to op/],
    ['restore_event', { id: 'e1', rev: '1' }, /`rev` belongs to op/],
    ['create_calendar', { title: 'x', start: '2026-10-15' }, /`start` belongs to op/],
    ['create_event', { color: '#fff', title: 'x' }, /`color` belongs to op create_calendar/],
    ['skip_occurrence', { move_to: '2026-10-16' }, /`move_to` belongs to op move_occurrence/],
    ['complete_occurrence', { status: ['done'] }, /`status` belongs to op query/],
    ['get_reminders', { sound: 'bell' }, /`sound` belongs to op set_reminders/],
    ['set_reminders', { start: '2026-10-15' }, /`start` belongs to op/],
  ])('%s refuses another op’s field %j before anything runs', async (op, extra, message) => {
    await expect(run({ op, ...extra })).rejects.toThrow(message);
    await expect(run({ op, ...extra })).rejects.toThrow('Nothing was changed');
    expect(calls).toEqual([]);
  });

  it('refuses a field no op reads, naming the op’s own fields', async () => {
    await expect(run({ op: 'query', start_time: '09:00' })).rejects.toThrow(
      /`start_time` is not a calendar field \(query reads range, days, from, to/
    );
    expect(calls).toEqual([]);
  });

  it('ignores null for fields of other ops (nothing is meant by them)', async () => {
    await run({ op: 'list', id: null, rev: null });
    expect(calls).toHaveLength(1);
  });

  it('maps every op, and every op’s fields are schema properties (listed or unlisted)', () => {
    expect(Object.keys(CALENDAR_OP_FIELDS).sort()).toEqual([...OPS].sort());
    const unlisted = Object.keys(definition.unlisted_params ?? {});
    for (const field of unlisted) expect(schema.properties).not.toHaveProperty(field);
    const properties = new Set([...Object.keys(schema.properties), ...unlisted]);
    for (const fields of Object.values(CALENDAR_OP_FIELDS))
      for (const field of fields) expect(properties).toContain(field);
    const read = new Set(Object.values(CALENDAR_OP_FIELDS).flat());
    for (const property of properties) if (property !== 'op') expect(read).toContain(property);
  });
});

describe('calendar_read / calendar_write family aliases (real alias registry)', () => {
  const allowOnly = (entry: string) => ({ mode: 'allow_list', allowList: [entry], denyList: [] });
  const denyOnly = (entry: string) => ({ mode: 'deny_list', allowList: [], denyList: [entry] });
  const verdict = (access: ReturnType<typeof allowOnly>, op: string) =>
    evaluateOpAccess(access as never, 'calendar', op).decision;
  const opVia = (alias: string, params: Record<string, unknown>) =>
    transformToolAliasParams(resolveToolId(alias), params).op;

  it('the two families split the op enum exactly', () => {
    expect([...CALENDAR_READ_OPS, ...CALENDAR_WRITE_OPS].sort()).toEqual([...OPS].sort());
    expect(definition.aliases).toEqual(['calendar_read', 'calendar_write']);
  });

  it('both resolve to calendar with their op family', () => {
    expect(resolveToolId('calendar_read')).toMatchObject({
      id: 'calendar',
      ops: CALENDAR_READ_OPS,
    });
    expect(resolveToolId('calendar_write')).toMatchObject({
      id: 'calendar',
      ops: CALENDAR_WRITE_OPS,
    });
  });

  it('a call through an alias keeps an op of its family and cannot be steered out of it', () => {
    expect(opVia('calendar_read', {})).toBe('query');
    expect(opVia('calendar_read', { op: 'list' })).toBe('list');
    expect(opVia('calendar_read', { op: 'delete_event' })).not.toBe('delete_event');
    expect(opVia('calendar_write', { op: 'update_event' })).toBe('update_event');
    expect(opVia('calendar_write', {})).not.toMatch(/^(list|query|create_event)$/);
    expect(opVia('calendar_write', { op: 'query' })).not.toBe('query');
  });

  it('an op steered out of its family fails at the tool’s op check', async () => {
    const input = transformToolAliasParams(resolveToolId('calendar_read'), { op: 'delete_event' });
    await expect(run(input)).rejects.toThrow('op is required');
    expect(calls).toEqual([]);
  });

  it.each([
    ['calendar_read', CALENDAR_READ_OPS],
    ['calendar_write', CALENDAR_WRITE_OPS],
  ])('%s: an allow grants only its family, a deny blocks only its family', (alias, family) => {
    for (const op of OPS) {
      const inFamily = (family as readonly string[]).includes(op);
      expect(verdict(allowOnly(alias), op) === 'allow').toBe(inFamily);
      expect(verdict(denyOnly(alias), op)).toBe(inFamily ? 'deny' : 'allow');
    }
  });

  it('allow calendar (the canonical id) grants every op', () => {
    for (const op of OPS) expect(verdict(allowOnly('calendar'), op)).toBe('allow');
  });
});

describe('calendar definition', () => {
  it('is a standard tool (found through search_tools), usable with or without an agent', () => {
    expect(definition.id).toBe('calendar');
    expect(definition.tier).toBe('standard');
    expect(definition.contextRequirement).toBe('agent-optional');
    expect(definition.description.length).toBeLessThan(700);
  });

  it('confirm-gates destructive calendar removals (restore_event undoes delete_event)', () => {
    expect(definition.destructive).toBeUndefined();
    expect(definition.destructiveOps).toEqual(['delete_event']);
    expect(OPS).toContain('restore_event');
  });
});
