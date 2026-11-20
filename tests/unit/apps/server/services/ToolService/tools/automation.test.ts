/**
 * The `automation` tool handler on its own (the service is mocked): `when`
 * sent as a JSON string is parsed, anything else that is not an object gets
 * an error naming the shapes, and every automation in a result carries its
 * zone and the next run in that zone (`next_run_at` alone is UTC). `run`
 * passes the agent as actor and says where the wake went in words; `runs`
 * gives each run's due time in UTC and in the automation's zone. `resume` and
 * `pause` are the plain ones: no undo token, and no op to undo one (that is
 * the app's).
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  AutomationRecord,
  AutomationRunNowResponse,
  AutomationRunsResponse,
} from '@snaglet/shared/types';

const mockCreate = jest.fn<(input: Record<string, unknown>) => Promise<AutomationRecord>>();
const mockUpdate =
  jest.fn<(id: string, patch: Record<string, unknown>) => Promise<AutomationRecord>>();
const mockList = jest.fn<() => Promise<AutomationRecord[]>>();
const mockRunNow =
  jest.fn<(id: string, actor: Record<string, unknown>) => Promise<AutomationRunNowResponse>>();
const mockGet = jest.fn<(id: string) => Promise<AutomationRecord>>();
const mockRuns = jest.fn<() => Promise<AutomationRunsResponse>>();
const mockResume = jest.fn<(id: string) => Promise<AutomationRecord>>();
const mockResumeWithUndo = jest.fn();
const mockUndoResume = jest.fn();
const mockPause = jest.fn<(id: string) => Promise<AutomationRecord>>();
const mockPauseWithUndo = jest.fn();
const mockUndoPause = jest.fn();
jest.mock('@server/services/automations/AutomationService', () => ({
  AUTOMATED_RUN_REFUSAL: 'refused',
  AUTOMATED_RUN_NOW_REFUSAL: 'run refused',
  automationService: {
    create: (input: Record<string, unknown>) => mockCreate(input),
    update: (id: string, patch: Record<string, unknown>) => mockUpdate(id, patch),
    list: () => mockList(),
    get: (id: string) => mockGet(id),
    runNow: (id: string, actor: Record<string, unknown>) => mockRunNow(id, actor),
    runs: () => mockRuns(),
    resume: (id: string) => mockResume(id),
    resumeWithUndo: (...args: unknown[]) => mockResumeWithUndo(...args),
    undoResume: (...args: unknown[]) => mockUndoResume(...args),
    pause: (id: string) => mockPause(id),
    pauseWithUndo: (...args: unknown[]) => mockPauseWithUndo(...args),
    undoPause: (...args: unknown[]) => mockUndoPause(...args),
  },
}));
jest.mock('@server/realtime/runContext', () => ({ getRunContext: () => undefined }));

import definition from '@server/services/ToolService/tools/automations/automation/definition';
import tool from '@server/services/ToolService/tools/automations/automation/tool';

const AGENT = { agentId: 'test-agent-a', threadId: 'thread-1111111111111-aaaaaaaaa' };
const ID = 'automation-1111111111111-aaaaaaaaa';
const LA = 'America/Los_Angeles';
const WHEN_NOT_OBJECT =
  'when must be an object: {"in":"30m"}, {"at":"2026-10-14T09:00"}, {"repeat":"FREQ=DAILY","at":"09:00"} or {"every":"1h"}.';

function record(over: Partial<AutomationRecord> = {}): AutomationRecord {
  return {
    id: ID,
    name: 'Check backlog',
    prompt: 'Check the backlog.',
    status: 'active',
    when: { kind: 'once', at: '2026-10-13T20:50:12.894Z', tz: LA },
    whenText: 'once on Tue, Oct 13, 1:50 PM',
    calendarId: 'calendar-1111',
    threadId: AGENT.threadId,
    agentId: AGENT.agentId,
    scheduleId: 'schedule-1111',
    createdByAgentId: AGENT.agentId,
    createdByMemberId: null,
    consecutiveFailures: 0,
    pausedReason: null,
    createdAt: '2026-10-13T20:48:12.894Z',
    updatedAt: '2026-10-13T20:48:12.894Z',
    nextRunAt: '2026-10-13T20:50:12.894Z',
    lastRun: null,
    agentName: 'Test Agent A',
    threadTitle: 'Test thread',
    calendarTitle: 'Default',
    running: false,
    runningSince: null,
    unattendedPolicy: 'skip',
    ...over,
  };
}

async function call(input: Record<string, unknown>) {
  return JSON.parse((await tool(input, {}, AGENT)) as string) as {
    automation: Record<string, unknown>;
    when_input?: unknown;
    automations?: Array<Record<string, unknown>>;
  };
}

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue(record());
  mockCreate.mockReset().mockResolvedValue(record());
  mockUpdate.mockReset().mockResolvedValue(record());
  mockList.mockReset().mockResolvedValue([record()]);
  mockRunNow
    .mockReset()
    .mockResolvedValue({ automation: record(), run: { status: 'succeeded', error: null } });
  mockRuns.mockReset().mockResolvedValue({ runs: [], nextCursor: null });
  mockResume.mockReset().mockResolvedValue(record());
  mockResumeWithUndo.mockReset();
  mockUndoResume.mockReset();
  mockPause.mockReset().mockResolvedValue(record({ status: 'paused', pausedReason: 'agent' }));
  mockPauseWithUndo.mockReset();
  mockUndoPause.mockReset();
});

describe('automation tool: when', () => {
  it('create parses a when sent as a JSON string and echoes the object', async () => {
    const out = await call({
      op: 'create',
      name: 'Check backlog',
      prompt: 'Check the backlog.',
      when: ' {"in": "2m"} ',
    });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ when: { in: '2m' } }));
    expect(out.when_input).toEqual({ in: '2m' });
  });

  it('create refuses a when that is not an object, naming the shapes', async () => {
    for (const when of ['in 2m', '{"in": "2m"', '["in"]', ['in'], 42, null, undefined]) {
      await expect(
        tool({ op: 'create', name: 'Check backlog', prompt: 'Check.', when }, {}, AGENT)
      ).rejects.toThrow(WHEN_NOT_OBJECT);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('leaves an object with zero or several shapes to the timing rules', async () => {
    await call({ op: 'create', name: 'Check backlog', prompt: 'Check.', when: {} });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ when: {} }));
  });

  it('update parses a JSON-string when, refuses a non-object, and leaves an omitted one out', async () => {
    const out = await call({ op: 'update', id: ID, when: '{"every":"1h"}' });
    expect(mockUpdate).toHaveBeenCalledWith(ID, { when: { every: '1h' } });
    expect(out.when_input).toEqual({ every: '1h' });

    await expect(tool({ op: 'update', id: ID, when: 'hourly' }, {}, AGENT)).rejects.toThrow(
      WHEN_NOT_OBJECT
    );
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    const renamed = await call({ op: 'update', id: ID, name: 'Renamed' });
    expect(mockUpdate).toHaveBeenLastCalledWith(ID, { name: 'Renamed' });
    expect(renamed).not.toHaveProperty('when_input');
  });
});

describe('automation tool: an interval with a daily window', () => {
  const windowed = { every: '5m', window_start: '05:05', window_end: '06:00', tz: LA };

  it('advertises window_start and window_end on when (a closed object)', () => {
    const when = (
      definition.parameters_schema as {
        properties: {
          when: { additionalProperties: boolean; properties: Record<string, { type: string }> };
        };
      }
    ).properties.when;
    expect(when.additionalProperties).toBe(false);
    expect(when.properties.window_start).toMatchObject({ type: 'string' });
    expect(when.properties.window_end).toMatchObject({ type: 'string' });
    expect(definition.description).toContain('{every:"30m"} (+ window_start/window_end)');
  });

  it('passes the window to the service on create and update, and echoes it', async () => {
    const made = await call({
      op: 'create',
      name: 'Stall watch',
      prompt: 'Check the show for stalls.',
      when: windowed,
    });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ when: windowed }));
    expect(made.when_input).toEqual(windowed);
    const changed = await call({ op: 'update', id: ID, when: JSON.stringify(windowed) });
    expect(mockUpdate).toHaveBeenCalledWith(ID, { when: windowed });
    expect(changed.when_input).toEqual(windowed);
  });

  it('says the window and its zone in when, and keeps it in the raw schedule', async () => {
    const stored = {
      kind: 'interval' as const,
      everyMs: 300_000,
      tz: LA,
      windowStart: '05:05',
      windowEnd: '06:00',
    };
    mockGet.mockResolvedValue(record({ when: stored, nextRunAt: '2026-10-14T12:05:00.000Z' }));
    const out = await call({ op: 'get', id: ID });
    expect(out.automation).toMatchObject({
      when: 'every 5 minutes from 5:05 AM to 6:00 AM (America/Los_Angeles)',
      schedule: stored,
      next_run_local: 'Wed, Oct 14, 5:05 AM PDT',
    });
  });
});

describe('automation tool: when Snaglet first opens that day', () => {
  const firstOpen = { first_open: true, after: '05:00', tz: LA };

  it('advertises first_open and after on when', () => {
    const when = (
      definition.parameters_schema as {
        properties: { when: { properties: Record<string, { type: string }> } };
      }
    ).properties.when;
    expect(when.properties.first_open).toMatchObject({ type: 'boolean' });
    expect(when.properties.after).toMatchObject({ type: 'string' });
    expect(definition.description).toContain('{first_open:true}');
  });

  it('passes it to the service on create and update, and echoes it', async () => {
    const made = await call({
      op: 'create',
      name: 'Morning show',
      prompt: 'Start the morning show.',
      when: firstOpen,
    });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ when: firstOpen }));
    expect(made.when_input).toEqual(firstOpen);
    const changed = await call({ op: 'update', id: ID, when: JSON.stringify(firstOpen) });
    expect(mockUpdate).toHaveBeenCalledWith(ID, { when: firstOpen });
    expect(changed.when_input).toEqual(firstOpen);
  });

  it('says it in words and gives the next run as when Snaglet first opens, from the earliest time', async () => {
    const stored = { kind: 'first_open' as const, after: '05:00', tz: LA };
    mockGet.mockResolvedValue(record({ when: stored, nextRunAt: '2026-10-14T12:00:00.000Z' }));
    const out = await call({ op: 'get', id: ID });
    expect(out.automation).toMatchObject({
      when: 'when Snaglet first opens, after 5:00 AM (America/Los_Angeles)',
      schedule: stored,
      next_run_at: '2026-10-14T12:00:00.000Z',
      next_run_local: 'when Snaglet first opens, from Wed, Oct 14, 5:00 AM PDT',
    });
  });
});

describe('automation tool: times carry their zone', () => {
  it('a once names its zone in when, tz and next_run_local; next_run_at stays ISO', async () => {
    const out = await call({ op: 'create', name: 'Check backlog', prompt: 'Check.', when: {} });
    expect(out.automation).toMatchObject({
      when: 'once on Tue, Oct 13, 1:50 PM PDT',
      tz: LA,
      next_run_at: '2026-10-13T20:50:12.894Z',
      next_run_local: 'Tue, Oct 13, 1:50 PM PDT',
    });
  });

  it('a repeat names its IANA zone, an interval stays in words, and no next run is null', async () => {
    mockList.mockResolvedValue([
      record({
        when: {
          kind: 'repeat',
          rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
          timeOfDay: '09:00',
          startsOn: '2026-10-14',
          tz: 'America/New_York',
        },
        nextRunAt: '2026-10-14T13:00:00.000Z',
      }),
      record({
        status: 'paused',
        pausedReason: 'user',
        when: { kind: 'interval', everyMs: 3_600_000, tz: 'UTC' },
        nextRunAt: null,
      }),
    ]);
    const { automations } = await call({ op: 'list' });
    expect(automations?.[0]).toMatchObject({
      when: 'every weekday at 9:00 AM (America/New_York)',
      tz: 'America/New_York',
      next_run_local: 'Wed, Oct 14, 9:00 AM EDT',
    });
    expect(automations?.[1]).toMatchObject({
      when: 'every hour',
      tz: 'UTC',
      next_run_at: null,
      next_run_local: null,
    });
  });
});

describe('automation tool: run and runs', () => {
  const runOut = async (input: Record<string, unknown>, context: Record<string, unknown> = AGENT) =>
    JSON.parse((await tool(input, {}, context)) as string) as {
      run: Record<string, unknown>;
      note: string;
    };

  it('run passes the agent as actor and says where the wake went, without its text', async () => {
    const own = await runOut({ op: 'run', id: ID });
    expect(mockRunNow).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ kind: 'agent', agentId: AGENT.agentId, threadId: AGENT.threadId })
    );
    expect(own.run).toEqual({ status: 'succeeded' });
    expect(own.note).toBe(
      "Posted the wake in “Test thread”. You'll get it as a new message once your current run ends; check runs afterward."
    );

    const elsewhere = await runOut(
      { op: 'run', id: ID },
      { agentId: AGENT.agentId, threadId: 'thread-1111111111111-bbbbbbbbb' }
    );
    expect(elsewhere.note).toBe(
      'Posted the wake in “Test thread” for Test Agent A; check runs afterward.'
    );

    mockRunNow.mockResolvedValue({
      automation: record(),
      run: { status: 'failed', error: 'Thread gone' },
    });
    const failed = await runOut({ op: 'run', id: ID });
    expect(failed.run).toEqual({ status: 'failed', error: 'Thread gone' });
    expect(failed.note).toBe('The wake failed: Thread gone.');
    for (const out of [own, elsewhere, failed]) expect(out.note).not.toContain('[automation');

    mockRunNow.mockClear();
    await expect(
      tool(
        { op: 'run', id: ID },
        {},
        { ...AGENT, wakeOrigin: { kind: 'automation', automationId: ID } }
      )
    ).rejects.toThrow('run refused');
    expect(mockRunNow).not.toHaveBeenCalled();
  });

  it('runs maps each run to UTC and local due times and passes the page through', async () => {
    mockRuns.mockResolvedValue({
      runs: [
        {
          id: 'schedule_run-1111111111111-aaaaaaaaa',
          scheduledFor: '2026-10-13T20:50:12.894Z',
          startedAt: '2026-10-13T20:50:12.900Z',
          finishedAt: '2026-10-13T20:50:13.000Z',
          status: 'failed',
          error: 'The run failed.',
          manual: false,
        },
      ],
      nextCursor: 'cursor-1',
    });
    const out = JSON.parse((await tool({ op: 'runs', id: ID }, {}, AGENT)) as string);
    expect(out).toEqual({
      id: ID,
      name: 'Check backlog',
      tz: LA,
      runs: [
        {
          due_at: '2026-10-13T20:50:12.894Z',
          due_local: 'Tue, Oct 13, 1:50 PM PDT',
          status: 'failed',
          error: 'The run failed.',
          manual: false,
        },
      ],
      next_cursor: 'cursor-1',
    });
  });
});

describe('automation tool: get', () => {
  it('advertises get with id, without an automation_id or extra access requirement', () => {
    const schema = definition.parameters_schema as {
      properties: { op: { enum: string[] }; id: unknown; automation_id?: unknown };
    };
    expect(schema.properties.op.enum).toContain('get');
    expect(schema.properties.id).toBeDefined();
    expect(schema.properties.automation_id).toBeUndefined();
    expect(definition.destructiveOps).not.toContain('get');
  });

  it('returns full detail with readable timing and raw schedule, without writing or waking', async () => {
    const source = record({
      lastRun: {
        status: 'failed',
        scheduledFor: '2026-10-13T19:50:12.894Z',
        finishedAt: '2026-10-13T19:51:12.894Z',
        error: 'The run failed.',
      },
    });
    mockGet.mockResolvedValue(source);
    const before = structuredClone(source);
    const out = await call({ op: 'get', id: ` ${ID} ` });
    expect(mockGet).toHaveBeenCalledWith(ID);
    expect(out.automation).toMatchObject({
      id: ID,
      name: source.name,
      prompt: source.prompt,
      agent_id: AGENT.agentId,
      agent_name: 'Test Agent A',
      thread_id: AGENT.threadId,
      thread_title: 'Test thread',
      when: 'once on Tue, Oct 13, 1:50 PM PDT',
      schedule: source.when,
      tz: LA,
      status: 'active',
      next_run_at: source.nextRunAt,
      next_run_local: 'Tue, Oct 13, 1:50 PM PDT',
      last_run: {
        status: 'failed',
        at: source.lastRun?.scheduledFor,
        finished_at: source.lastRun?.finishedAt,
        error: 'The run failed.',
      },
      schedule_id: source.scheduleId,
      calendar_id: source.calendarId,
      calendar_title: source.calendarTitle,
      created_by_agent_id: AGENT.agentId,
      created_by_member_id: null,
      created_at: source.createdAt,
      updated_at: source.updatedAt,
      paused_reason: null,
      consecutive_failures: 0,
      running: false,
      running_since: null,
      unattended_policy: 'skip',
    });
    expect(source).toEqual(before);
    for (const write of [mockCreate, mockUpdate, mockRunNow]) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(mockRuns).not.toHaveBeenCalled();
  });

  it.each(['active', 'paused', 'finished', 'cancelled'] as const)(
    'reads %s records, with explicit nulls when no next or last run exists',
    async (status) => {
      mockGet.mockResolvedValue(record({ status, nextRunAt: null }));
      expect((await call({ op: 'get', id: ID })).automation).toMatchObject({
        status,
        next_run_at: null,
        next_run_local: null,
        last_run: null,
      });
    }
  );

  it.each([
    { kind: 'interval', everyMs: 3_600_000, tz: 'UTC' } as const,
    {
      kind: 'repeat',
      rrule: 'FREQ=DAILY',
      timeOfDay: '09:00',
      startsOn: '2026-10-14',
      tz: LA,
    } as const,
  ])('returns the raw $kind schedule', async (when) => {
    mockGet.mockResolvedValue(record({ when }));
    expect((await call({ op: 'get', id: ID })).automation.schedule).toEqual(when);
  });

  it('allows a person-created automation that wakes the caller', async () => {
    mockGet.mockResolvedValue(record({ createdByAgentId: null }));
    expect((await call({ op: 'get', id: ID })).automation.agent_id).toBe(AGENT.agentId);
  });

  it('refuses another target agent even when the caller created the automation', async () => {
    mockGet.mockResolvedValue(record({ agentId: 'test-agent-b' }));
    await expect(tool({ op: 'get', id: ID }, {}, AGENT)).rejects.toMatchObject({
      message: 'You can only read automations that wake you.',
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });

  it('preserves the service not-found error', async () => {
    const error = new Error(`Automation ${ID} not found.`);
    mockGet.mockRejectedValue(error);
    await expect(tool({ op: 'get', id: ID }, {}, AGENT)).rejects.toBe(error);
  });

  it('requires id, not automation_id, before reading', async () => {
    for (const input of [{}, { id: ' ' }, { id: 42 }, { automation_id: ID }]) {
      await expect(tool({ op: 'get', ...input }, {}, AGENT)).rejects.toThrow('id is required.');
    }
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('is available in automated runs, like list', async () => {
    const context = { ...AGENT, wakeOrigin: { kind: 'automation' as const, automationId: ID } };
    await expect(tool({ op: 'get', id: ID }, {}, context)).resolves.toEqual(expect.any(String));
    expect(mockRunNow).not.toHaveBeenCalled();
  });

  it('lets people and bypass contexts read any target, matching existing actor handling', async () => {
    mockGet.mockResolvedValue(record({ agentId: 'test-agent-b' }));
    for (const context of [undefined, { ...AGENT, bypassToolAccess: true }]) {
      const out = JSON.parse((await tool({ op: 'get', id: ID }, {}, context)) as string);
      expect(out.automation.agent_id).toBe('test-agent-b');
    }
  });
});

describe('automation tool: resume', () => {
  it('resumes with no undo token in its output, and offers no op to undo it', async () => {
    const raw = (await tool({ op: 'resume', id: ID }, {}, AGENT)) as string;
    expect(mockResume).toHaveBeenCalledWith(ID);
    expect(JSON.parse(raw)).toEqual({ automation: expect.objectContaining({ id: ID }) });
    expect(raw).not.toMatch(/undo|token/i);
    expect(mockResumeWithUndo).not.toHaveBeenCalled();

    const schema = definition.parameters_schema as { properties: { op: { enum: string[] } } };
    expect(schema.properties.op.enum).toEqual([
      'create',
      'list',
      'get',
      'update',
      'disable',
      'enable',
      'cancel',
      'run',
      'runs',
    ]);
    for (const op of ['undo', 'undo_resume', 'resume_undo']) {
      await expect(tool({ op, id: ID, token: 'x' }, {}, AGENT)).rejects.toThrow(
        'op is required and must be one of create | list | get | update | disable | enable | cancel | run | runs.'
      );
    }
    expect(mockUndoResume).not.toHaveBeenCalled();
  });
});

describe('automation tool: pause', () => {
  it('pauses with no undo token in its output, and offers no op to undo it', async () => {
    const raw = (await tool({ op: 'pause', id: ID }, {}, AGENT)) as string;
    expect(mockPause).toHaveBeenCalledWith(ID);
    expect(JSON.parse(raw)).toEqual({ automation: expect.objectContaining({ id: ID }) });
    expect(raw).not.toMatch(/undo|token/i);
    expect(mockPauseWithUndo).not.toHaveBeenCalled();
    for (const op of ['undo_pause', 'pause_undo']) {
      await expect(tool({ op, id: ID, token: 'x' }, {}, AGENT)).rejects.toThrow(
        'op is required and must be one of create | list | get | update | disable | enable | cancel | run | runs.'
      );
    }
    expect(mockUndoPause).not.toHaveBeenCalled();
  });
});

describe('automation tool: enable and disable', () => {
  it('route to resume and pause, and the older names still work', async () => {
    await tool({ op: 'disable', id: ID }, {}, AGENT);
    expect(mockPause).toHaveBeenCalledTimes(1);
    await tool({ op: 'enable', id: ID }, {}, AGENT);
    expect(mockResume).toHaveBeenCalledTimes(1);
    await tool({ op: 'pause', id: ID }, {}, AGENT);
    await tool({ op: 'resume', id: ID }, {}, AGENT);
    expect(mockPause).toHaveBeenCalledTimes(2);
    expect(mockResume).toHaveBeenCalledTimes(2);
  });
});
