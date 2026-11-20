/**
 * An automation's last run is the newest run of its schedules, found by the
 * schedule's action, so a deleted automation (whose kept schedule is
 * unlinked) still has one. With no schedule run at all (its schedule was
 * lost and a new one made) the list falls back to the newest wake the
 * automation posted (its seed message's `metadata.automation`).
 */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@snaglet/db/db', () => ({
  getDb: () => ({ query: jest.fn() }),
  transaction: jest.fn(),
}));

import { Automations } from '@snaglet/db/tables/automations';
import type { DbQueryable } from '@snaglet/db/db';

const baseRow = {
  id: 'automation-1111111111111-aaaaaaaaa',
  name: 'Morning check-in',
  prompt: 'Check the backlog',
  status: 'cancelled',
  when_kind: 'once',
  at: '2026-01-02T09:00:00.000Z',
  rrule: null,
  time_of_day: null,
  starts_on: null,
  every_ms: null,
  tz: 'UTC',
  calendar_id: null,
  thread_id: 'thread-1111111111111-aaaaaaaaa',
  agent_id: 'test-agent-a',
  schedule_id: null,
  created_by_agent_id: null,
  created_by_member_id: null,
  consecutive_failures: 0,
  paused_reason: null,
  created_run_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T10:00:00.000Z',
  agent_name: 'Test Agent A',
  thread_title: 'Test thread',
  calendar_title: null,
  next_run_at: null,
};

function runner(rows: unknown[]) {
  const query = jest.fn(async (_sql: string, _params?: ReadonlyArray<unknown>) => ({
    rows,
    rowCount: rows.length,
  }));
  return { query, db: { query } as unknown as DbQueryable };
}

describe('Automations.list last run', () => {
  it("falls back to the automation's newest posted wake when its schedule has no run", async () => {
    const { query, db } = runner([]);
    await Automations.list({ ids: [baseRow.id] }, db);
    const [sql] = query.mock.calls[0];

    // Schedule runs first (of the schedules the automation owns or kept);
    // the wake messages only when there is none.
    expect(sql).toMatch(/WHERE r\.schedule_id IN \(SELECT os\.id FROM public\.schedules os/);
    expect(sql).toContain("os.action_json->>'automationId' = a.id");
    expect(sql).toMatch(/FROM public\.messages m\s+WHERE lr\.status IS NULL/);
    expect(sql).toContain('m.thread_id = a.thread_id');
    expect(sql).toContain("m.metadata->'automation'->>'id' = a.id");
    expect(sql).toContain('COALESCE(lr.status, lw.status) AS last_status');
    expect(sql).toContain('COALESCE(lr.scheduled_for, lw.scheduled_for)');
  });

  it('reads a posted wake as a run that went', async () => {
    const { db } = runner([
      {
        ...baseRow,
        last_status: 'succeeded',
        last_scheduled_for: '2026-01-02T09:00:00.000Z',
        last_finished_at: '2026-01-02T09:00:01.000Z',
        last_error: null,
      },
    ]);
    const [row] = await Automations.list({ ids: [baseRow.id] }, db);
    expect(row?.status).toBe('cancelled');
    expect(row?.lastRun).toEqual({
      status: 'succeeded',
      scheduledFor: '2026-01-02T09:00:00.000Z',
      finishedAt: '2026-01-02T09:00:01.000Z',
      error: null,
    });
  });

  it('still reads "not run" when there is neither a run nor a posted wake', async () => {
    const { db } = runner([
      {
        ...baseRow,
        last_status: null,
        last_scheduled_for: null,
        last_finished_at: null,
        last_error: null,
      },
    ]);
    const [row] = await Automations.list({ ids: [baseRow.id] }, db);
    expect(row?.lastRun).toBeNull();
  });
});
