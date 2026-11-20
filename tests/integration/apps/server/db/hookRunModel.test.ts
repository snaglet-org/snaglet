import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { getDb, HookRuns } from '@snaglet/db';

const PREFIX = 'hook-run-ledger-test';
const RUN_ID = `${PREFIX}-1`;
const INTERRUPTED_ID = `${PREFIX}-interrupted`;

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.hook_runs WHERE id LIKE $1`, [`${PREFIX}%`]);
}

const RETENTION_POLICY = {
  keepLatestPerHook: 100,
  succeededRetention: '30 days',
  failureRetention: '90 days',
  batchSize: 500,
};

async function insertRecentFloor(hookName: string): Promise<void> {
  await getDb().query(
    `INSERT INTO public.hook_runs
       (id, hook_name, source, event_name, status, started_at, finished_at)
     SELECT $1 || '-recent-' || LPAD(value::text, 3, '0'),
            $2,
            'event',
            'message:create',
            'succeeded',
            NOW() - INTERVAL '1 day' + value * INTERVAL '1 second',
            NOW() - INTERVAL '1 day' + value * INTERVAL '1 second'
       FROM generate_series(1, 100) AS value`,
    [PREFIX, hookName]
  );
}

async function insertRetentionRow(input: {
  id: string;
  hookName: string;
  status: 'running' | 'succeeded' | 'failed' | 'timed_out';
  age: string;
}): Promise<void> {
  await getDb().query(
    `INSERT INTO public.hook_runs
       (id, hook_name, source, event_name, status, started_at, finished_at)
     VALUES ($1, $2, 'event', 'message:create', $3, NOW() - $4::interval,
             CASE WHEN $3 = 'running' THEN NULL ELSE NOW() - $4::interval END)`,
    [input.id, input.hookName, input.status, input.age]
  );
}

describe('HookRuns durable execution ledger', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('records, finishes, and reads a hook run through the typed model', async () => {
    const started = await HookRuns.start({
      id: RUN_ID,
      hookName: 'daily-digest',
      source: 'event',
      eventName: 'message:create',
      threadId: 'thread-1',
    });
    expect(started).toMatchObject({
      id: RUN_ID,
      hookName: 'daily-digest',
      status: 'running',
      source: 'event',
      eventName: 'message:create',
    });

    const finished = await HookRuns.finish(RUN_ID, {
      status: 'succeeded',
      durationMs: 42,
      exitCode: 0,
      stdout: 'done',
      stderr: '',
    });
    expect(finished).toMatchObject({
      id: RUN_ID,
      status: 'succeeded',
      durationMs: 42,
      exitCode: 0,
      stdout: 'done',
    });

    await expect(HookRuns.listByHook('daily-digest')).resolves.toEqual([
      expect.objectContaining({ id: RUN_ID }),
    ]);
  });

  it('fails an orphaned running row during restart cleanup', async () => {
    await HookRuns.start({
      id: INTERRUPTED_ID,
      hookName: 'daily-digest',
      source: 'schedule',
      eventName: 'schedule:fire',
    });

    expect(await HookRuns.markInterrupted()).toBe(1);
    expect(await HookRuns.findById(INTERRUPTED_ID)).toMatchObject({
      status: 'failed',
      stderr: 'Snaglet stopped during this run',
    });
  });

  it('prunes only aged terminal rows beyond the latest-100 floor', async () => {
    const hookName = `${PREFIX}-retention`;
    await insertRecentFloor(hookName);
    await insertRetentionRow({
      id: `${PREFIX}-success-old`,
      hookName,
      status: 'succeeded',
      age: '31 days',
    });
    await insertRetentionRow({
      id: `${PREFIX}-failed-old`,
      hookName,
      status: 'failed',
      age: '91 days',
    });
    await insertRetentionRow({
      id: `${PREFIX}-timeout-old`,
      hookName,
      status: 'timed_out',
      age: '91 days',
    });
    await insertRetentionRow({
      id: `${PREFIX}-failed-boundary`,
      hookName,
      status: 'failed',
      age: '89 days',
    });
    await insertRetentionRow({
      id: `${PREFIX}-running-old`,
      hookName,
      status: 'running',
      age: '365 days',
    });

    const result = await HookRuns.pruneTerminal(RETENTION_POLICY);

    expect(result.ids.sort()).toEqual(
      [`${PREFIX}-failed-old`, `${PREFIX}-success-old`, `${PREFIX}-timeout-old`].sort()
    );
    const remaining = await getDb().query<{ id: string; status: string }>(
      `SELECT id, status FROM public.hook_runs WHERE hook_name=$1 ORDER BY id`,
      [hookName]
    );
    expect(remaining.rows).toHaveLength(102);
    expect(remaining.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `${PREFIX}-failed-boundary`, status: 'failed' }),
        expect.objectContaining({ id: `${PREFIX}-running-old`, status: 'running' }),
      ])
    );
  });

  it('uses started_at DESC, id DESC ties and honors a bounded batch', async () => {
    const hookName = `${PREFIX}-ties`;
    await getDb().query(
      `INSERT INTO public.hook_runs
         (id, hook_name, source, event_name, status, started_at, finished_at)
       SELECT $1 || '-tie-' || LPAD(value::text, 3, '0'),
              $2,
              'event',
              'message:create',
              'succeeded',
              NOW() - INTERVAL '60 days',
              NOW() - INTERVAL '60 days'
         FROM generate_series(0, 101) AS value`,
      [PREFIX, hookName]
    );

    const first = await HookRuns.pruneTerminal({ ...RETENTION_POLICY, batchSize: 1 });
    const second = await HookRuns.pruneTerminal({ ...RETENTION_POLICY, batchSize: 1 });
    const exhausted = await HookRuns.pruneTerminal({ ...RETENTION_POLICY, batchSize: 1 });

    expect(first.ids).toEqual([`${PREFIX}-tie-000`]);
    expect(second.ids).toEqual([`${PREFIX}-tie-001`]);
    expect(exhausted.deleted).toBe(0);
    await expect(HookRuns.listByHook(hookName, 100)).resolves.toHaveLength(100);
  });
});
