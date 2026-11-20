import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import {
  buildScheduleFireEvent,
  extractNodeIds,
  extractNodeRefs,
  parseTriggersFromCode,
  TRIGGER_PARAM_SPECS,
} from './hookTestConsoleSupport';
import { HOOK_EVENT_NAMES } from './scaffold';

describe('extractNodeIds', () => {
  it('extracts ids from link and include chip markdown', () => {
    expect(
      extractNodeIds(
        'see [My doc](doc-1111111111111-a1yzyhggz) and ![](doc-2222222222222-b2xzyhggz)'
      )
    ).toEqual(['doc-1111111111111-a1yzyhggz', 'doc-2222222222222-b2xzyhggz']);
  });

  it('accepts a bare typed/pasted id and normalizes the legacy scheme form', () => {
    expect(extractNodeIds('thread-3333333333333-c3xzyhggz')).toEqual([
      'thread-3333333333333-c3xzyhggz',
    ]);
    // `page:` scheme bodies are bare UUIDs, so the DB id is the body itself.
    expect(extractNodeIds('[Old page](page:0a1b2c3d-1111-4222-8333-444455556666)')).toEqual([
      '0a1b2c3d-1111-4222-8333-444455556666',
    ]);
  });

  it('de-duplicates and ignores non-node text and malformed ids', () => {
    expect(
      extractNodeIds(
        '[A](doc-1111111111111-a1yzyhggz) again [A](doc-1111111111111-a1yzyhggz) ' +
          'plus [link](https://example.com) and doc-nonsense'
      )
    ).toEqual(['doc-1111111111111-a1yzyhggz']);
  });

  it('returns an empty list for plain text', () => {
    expect(extractNodeIds('just some words')).toEqual([]);
  });
});

describe('extractNodeRefs', () => {
  it('preserves the chip kind so callers can validate against the trigger', () => {
    expect(
      extractNodeRefs('[Hi](message-1111111111111-a1yzyhggz) [T](thread-2222222222222-b2xzyhggz)')
    ).toEqual([
      { kind: 'message', id: 'message-1111111111111-a1yzyhggz' },
      { kind: 'thread', id: 'thread-2222222222222-b2xzyhggz' },
    ]);
  });

  it('normalizes legacy task chips to doc (tasks are docs now)', () => {
    expect(extractNodeRefs('[T](task-1111111111111-a1yzyhggz)')).toEqual([
      { kind: 'doc', id: 'task-1111111111111-a1yzyhggz' },
    ]);
  });

  it('ignores ordinary markdown links (href goes through parseNodeRef)', () => {
    expect(extractNodeRefs('[link](https://example.com)')).toEqual([]);
  });
});

describe('parseTriggersFromCode', () => {
  it('reads a scalar on: trigger', () => {
    expect(parseTriggersFromCode(`defineHook({ on: 'message:create', async run() {} })`)).toEqual({
      events: ['message:create'],
      hasSchedule: false,
    });
  });

  it('reads an on: array in code order, deduplicated, across quote styles and lines', () => {
    const code = `export default defineHook({
      on: [
        'schedule:fire',
        "message:create",
        'message:create',
      ],
    })`;
    expect(parseTriggersFromCode(code).events).toEqual(['schedule:fire', 'message:create']);
  });

  it('filters unknown event names', () => {
    expect(parseTriggersFromCode(`on: ['message:create', 'not:an-event']`).events).toEqual([
      'message:create',
    ]);
  });

  it('detects a live schedule: but NOT the scaffold’s commented-out example', () => {
    const commented = `defineHook({
      on: 'message:create',
      // Optional durable time triggers:
      // schedule: [
      //   { every: 15, unit: 'minute' },
      // ],
    })`;
    expect(parseTriggersFromCode(commented).hasSchedule).toBe(false);

    const live = `defineHook({
      on: 'message:create',
      schedule: [{ every: 15, unit: 'minute' }],
    })`;
    expect(parseTriggersFromCode(live).hasSchedule).toBe(true);
  });

  it('recognizes underscored event names such as table_entry:update', () => {
    expect(
      parseTriggersFromCode(`defineHook({ on: ['table_entry:update', 'table_entry:delete'] })`)
        .events
    ).toEqual(['table_entry:update', 'table_entry:delete']);
  });

  it('returns nothing for code without an on: (fallback picker case)', () => {
    expect(parseTriggersFromCode('const x = 1;')).toEqual({ events: [], hasSchedule: false });
  });
});

describe('TRIGGER_PARAM_SPECS', () => {
  it('covers every hook event exactly', () => {
    expect(Object.keys(TRIGGER_PARAM_SPECS).sort()).toEqual([...HOOK_EVENT_NAMES].sort());
  });

  it('schedule needs nothing, run:end takes a raw id, entity events take chips', () => {
    expect(TRIGGER_PARAM_SPECS['schedule:fire'].param).toBe('none');
    expect(TRIGGER_PARAM_SPECS['run:end'].param).toBe('id');
    expect(TRIGGER_PARAM_SPECS['message:create']).toMatchObject({
      param: 'node',
      nodeKinds: ['message'],
    });
    expect(TRIGGER_PARAM_SPECS['agent:update']).toMatchObject({
      param: 'node',
      nodeKinds: ['agent'],
    });
  });

  it('table entry events take a table id and an entry id (rows are not nodes)', () => {
    for (const event of [
      'table_entry:create',
      'table_entry:update',
      'table_entry:delete',
      'table_entry:occurrence',
    ] as const) {
      expect(TRIGGER_PARAM_SPECS[event]).toMatchObject({
        param: 'table-entry',
        tableLabel: 'Table ID',
        entryLabel: 'Entry ID',
      });
    }
  });
});

describe('buildScheduleFireEvent', () => {
  it('uses the real schedule id when known and a due-now scheduledFor', () => {
    const event = buildScheduleFireEvent('schedule-1');
    expect(event.scheduleId).toBe('schedule-1');
    expect(event.runId).toMatch(/^test-\d+$/);
    expect(() => new Date(event.scheduledFor as string).toISOString()).not.toThrow();
  });

  it('falls back to the "test" schedule id when none is registered', () => {
    expect(buildScheduleFireEvent(null).scheduleId).toBe('test');
  });
});
