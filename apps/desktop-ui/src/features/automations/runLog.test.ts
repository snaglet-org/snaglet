import { describe, expect, it } from 'vitest';
import type { AutomationRunRecord, HookRunRecord } from '@snaglet/shared/types';
import { formatRunDuration, mergeRunLog } from './runLog';

const automation = { id: 'automation-1111111111111-aaaaaaaaa', name: 'Morning check' };

function automationRun(over: Partial<AutomationRunRecord> & Pick<AutomationRunRecord, 'id'>) {
  return {
    automation,
    run: {
      scheduledFor: over.startedAt ?? '2026-11-05T09:00:00.000Z',
      startedAt: '2026-11-05T09:00:00.000Z',
      finishedAt: '2026-11-05T09:00:12.000Z',
      status: 'succeeded' as const,
      error: null,
      manual: false,
      ...over,
    },
  };
}

function scriptRun(over: Partial<HookRunRecord> & Pick<HookRunRecord, 'id'>): HookRunRecord {
  return {
    hookName: 'test-script',
    source: 'event',
    eventName: 'table_entry:update',
    status: 'succeeded',
    agentId: null,
    threadId: null,
    durationMs: 450,
    exitCode: 0,
    stdout: null,
    stderr: null,
    startedAt: '2026-11-05T09:00:00.000Z',
    finishedAt: '2026-11-05T09:00:00.450Z',
    ...over,
  };
}

describe('mergeRunLog', () => {
  it('merges both logs newest first, by instant', () => {
    const entries = mergeRunLog(
      [
        automationRun({ id: 'run-a1', startedAt: '2026-11-05T08:00:00.000Z' }),
        automationRun({ id: 'run-a2', startedAt: '2026-11-05T10:00:00.000Z' }),
      ],
      [
        scriptRun({ id: 'run-s1', startedAt: '2026-11-05T09:00:00.000Z' }),
        // Another way to write an instant still sorts by when it was.
        scriptRun({ id: 'run-s2', startedAt: '2026-11-05T10:30:00+01:00' }),
      ]
    );
    expect(entries.map((entry) => entry.key)).toEqual([
      'automation:run-a2',
      'script:run-s2',
      'script:run-s1',
      'automation:run-a1',
    ]);
  });

  it('says what ran, what started it, how it ended and how long it took', () => {
    const [automationEntry, scheduled, scriptEntry, manualScript] = mergeRunLog(
      [
        automationRun({
          id: 'run-a1',
          startedAt: '2026-11-05T12:00:00.000Z',
          finishedAt: '2026-11-05T12:00:12.000Z',
          manual: true,
        }),
        automationRun({
          id: 'run-a2',
          startedAt: '2026-11-05T11:00:00.000Z',
          finishedAt: null,
          status: 'running',
        }),
      ],
      [
        scriptRun({ id: 'run-s1', startedAt: '2026-11-05T10:00:00.000Z', status: 'failed' }),
        scriptRun({
          id: 'run-s2',
          startedAt: '2026-11-05T09:00:00.000Z',
          source: 'manual',
          status: 'timed_out',
          durationMs: 30_000,
        }),
      ]
    );
    expect(automationEntry).toMatchObject({
      kind: 'automation',
      ownerId: automation.id,
      name: 'Morning check',
      startedBy: 'Run now',
      result: 'Ran',
      durationMs: 12_000,
    });
    expect(scheduled).toMatchObject({ startedBy: 'Schedule', result: 'Running', durationMs: null });
    expect(scriptEntry).toMatchObject({
      kind: 'script',
      ownerId: 'test-script',
      name: 'test-script',
      startedBy: 'Row changed',
      result: 'Failed',
      durationMs: 450,
    });
    expect(manualScript).toMatchObject({ startedBy: 'Run now', result: 'Timed out' });
  });

  it('keeps at most `limit` lines and drops a run listed twice', () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      scriptRun({ id: `run-s${i}`, startedAt: `2026-11-05T0${i}:00:00.000Z` })
    );
    const entries = mergeRunLog([], [...runs, ...runs.slice(-1)], 3);
    expect(entries.map((entry) => entry.key)).toEqual([
      'script:run-s4',
      'script:run-s3',
      'script:run-s2',
    ]);
  });
});

describe('formatRunDuration', () => {
  it('reads milliseconds, seconds, minutes and hours', () => {
    expect(formatRunDuration(450)).toBe('450 ms');
    expect(formatRunDuration(1_240)).toBe('1.2 s');
    expect(formatRunDuration(42_000)).toBe('42 s');
    expect(formatRunDuration(185_000)).toBe('3 min 5 s');
    expect(formatRunDuration(120_000)).toBe('2 min');
    expect(formatRunDuration(7_800_000)).toBe('2 h 10 min');
  });
});
