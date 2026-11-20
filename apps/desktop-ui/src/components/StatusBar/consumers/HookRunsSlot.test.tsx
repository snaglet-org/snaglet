import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HookRunRecord } from '@snaglet/shared/types';
import {
  markAgentWorkFinished,
  markAgentWorkStarted,
  seedAgentWork,
} from '@desktop/utils/agentWorkState';
import { markHookRun, seedHookRuns } from '@desktop/utils/hookRunState';
import { StatusBar } from '../StatusBar';
import { StatusBarProvider } from '../StatusBarContext';
import { HookRunsSlot } from './HookRunsSlot';

function run(overrides: Partial<HookRunRecord> = {}): HookRunRecord {
  return {
    id: 'hook-run-1',
    hookName: 'daily-digest',
    source: 'event',
    eventName: 'message:create',
    status: 'succeeded',
    agentId: null,
    threadId: null,
    durationMs: 42,
    exitCode: 0,
    stdout: '',
    stderr: '',
    startedAt: '2026-07-29T12:00:00.000Z',
    finishedAt: '2026-07-29T12:00:00.042Z',
    ...overrides,
  };
}

function renderSlot() {
  return render(
    <StatusBarProvider>
      <HookRunsSlot />
      <StatusBar />
    </StatusBarProvider>
  );
}

describe('HookRunsSlot', () => {
  beforeEach(() => {
    seedAgentWork([]);
    seedHookRuns([]);
  });

  it('rests at zero and explains that the popover contains recent runs', () => {
    renderSlot();
    const trigger = screen.getByRole('button', { name: /^0 scripts running$/ });
    expect(trigger.title).toMatch(/recent runs/i);
    fireEvent.click(trigger);
    expect(screen.getByText('No scripts have run yet.')).toBeInTheDocument();
  });

  it('notifies while a hook is running and lists recent runs newest first', () => {
    seedHookRuns([
      run({ id: 'older', hookName: 'older-hook', startedAt: '2026-07-29T12:00:00.000Z' }),
      run({
        id: 'live',
        hookName: 'live-hook',
        status: 'running',
        durationMs: null,
        exitCode: null,
        finishedAt: null,
        startedAt: '2026-07-29T12:01:00.000Z',
      }),
    ]);
    seedAgentWork([
      {
        id: 'live',
        kind: 'hook-run',
        hookName: 'live-hook',
        startedAt: '2026-07-29T12:01:00.000Z',
      },
    ]);
    renderSlot();

    fireEvent.click(screen.getByRole('button', { name: /^1 script running$/ }));
    const list = screen.getByRole('list', { name: 'Recent script runs' });
    const rows = Array.from(list.querySelectorAll('li'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('live-hook');
    expect(rows[0]).toHaveTextContent('running');
    expect(rows[1]).toHaveTextContent('older-hook');
  });

  it('updates from start and finish events without polling', () => {
    renderSlot();

    act(() => {
      markHookRun(
        run({
          id: 'live',
          status: 'running',
          durationMs: null,
          exitCode: null,
          finishedAt: null,
        })
      );
      markAgentWorkStarted({
        id: 'live',
        kind: 'hook-run',
        hookName: 'daily-digest',
        startedAt: '2026-07-29T12:00:00.000Z',
      });
    });
    expect(screen.getByRole('button', { name: /^1 script running$/ })).toBeInTheDocument();

    act(() => {
      markHookRun(run({ id: 'live', status: 'succeeded' }));
      markAgentWorkFinished('live');
    });
    expect(screen.getByRole('button', { name: /^0 scripts running$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^0 scripts running$/ }));
    expect(screen.getByRole('list', { name: 'Recent script runs' })).toHaveTextContent('succeeded');
  });
});
