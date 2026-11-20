import { describe, expect, it } from 'vitest';
import type { ThreadMessageSubagentResult } from '@desktop/utils/api';
import {
  helperLabel,
  helperProblem,
  helperThreadSelection,
  helperThreadTitle,
  liveSubagentLabel,
  liveSubagentStatus,
  pausedUntilTime,
  subagentOutcome,
  subagentReport,
  subagentResultLabel,
} from './subagentText';

const FOLLOW_UP =
  '(To give Scout more work or answer it, call subagent op:send with name "Scout" during this turn; otherwise it is removed when this turn ends.)';

function result(over: Partial<ThreadMessageSubagentResult> = {}): ThreadMessageSubagentResult {
  return {
    subagentId: 'subagent-1',
    name: 'Scout',
    threadId: 'thread-helper-1',
    orchestratorAgentId: 'test-agent-a',
    orchestratorName: 'Agent A',
    status: 'finished',
    ...over,
  };
}

describe('subagent result copy', () => {
  it('names the orchestrator, the helper and how it ended', () => {
    const content = ['[subagent Scout finished]', 'Found 3 docs.', FOLLOW_UP].join('\n');
    expect(subagentResultLabel(result(), content)).toBe("Agent A's subagent Scout finished");
  });

  it('reads a finished reply that ends in a question as "asks"', () => {
    const content = ['[subagent Scout asks]', 'Which folder?', FOLLOW_UP].join('\n');
    expect(subagentOutcome(result(), content)).toBe('asks');
    expect(subagentResultLabel(result(), content)).toBe("Agent A's subagent Scout asks");
  });

  it('uses the row status for failed and stopped helpers', () => {
    const failed = ['[subagent Scout failed: model timed out]', '(no reply)', FOLLOW_UP].join('\n');
    expect(subagentResultLabel(result({ status: 'failed' }), failed)).toBe(
      "Agent A's subagent Scout failed"
    );
    const stopped = ['[subagent Scout stopped]', '(no reply)', FOLLOW_UP].join('\n');
    expect(subagentResultLabel(result({ status: 'stopped' }), stopped)).toBe(
      "Agent A's subagent Scout stopped"
    );
  });

  it('keeps only the report: no headline, no op:send note for the orchestrator', () => {
    const content = [
      '[subagent Scout finished]',
      '## Findings',
      '',
      '- one',
      '- two',
      FOLLOW_UP,
    ].join('\n');
    expect(subagentReport(content, 'Scout')).toEqual({
      error: null,
      report: '## Findings\n\n- one\n- two',
    });
  });

  it('pulls the failure reason out of the headline and drops the "(no reply)" placeholder', () => {
    const content = ['[subagent Scout failed: model timed out]', '(no reply)', FOLLOW_UP].join(
      '\n'
    );
    expect(subagentReport(content, 'Scout')).toEqual({ error: 'model timed out', report: '' });
  });

  it('reads why a helper stopped, and keeps its work so far as the report', () => {
    const content = [
      '[subagent Scout stopped: the server restarted while it was working]',
      'Work so far:',
      'Read 3 of 10 files.',
      '(Only Snaglet writes [subagent …] lines. Scout (id subagent-1) is paused: … op:send …)',
    ].join('\n');
    expect(subagentReport(content, 'Scout')).toEqual({
      error: 'the server restarted while it was working',
      report: 'Work so far:\nRead 3 of 10 files.',
    });
    expect(subagentReport('[subagent Scout stopped]\n(no reply)', 'Scout').error).toBeNull();
  });

  it('words a failed or stopped helper for its tooltip, and nothing for a healthy one', () => {
    expect(helperProblem({ status: 'failed', error: 'rate limited' })).toBe('Failed: rate limited');
    expect(helperProblem({ status: 'stopped', error: 'Test User stopped its run' })).toBe(
      'Paused: Test User stopped its run'
    );
    expect(helperProblem({ status: 'stopped', error: null })).toBeNull();
    expect(helperProblem({ status: 'running', error: null })).toBeNull();
  });

  it('reads a notice as what was done to the helper, by whom and until when', () => {
    const clock = { now: new Date('2026-10-12T12:00:00.000Z'), timeZone: 'UTC' };
    const paused = result({ status: 'stopped', notice: 'paused', noticeBy: 'Test User' });
    const content = [
      '[subagent Scout paused by Test User]',
      '(Only Snaglet writes [subagent …] lines. Scout is paused: it keeps its thread, brief and work so far and does nothing until it gets op:send.)',
    ].join('\n');
    expect(subagentOutcome(paused, content)).toBe('paused');
    expect(subagentResultLabel(paused, content, clock)).toBe(
      "Agent A's subagent Scout paused by Test User"
    );
    expect(
      subagentResultLabel({ ...paused, resumeAt: '2026-10-12T15:00:00.000Z' }, content, clock)
    ).toBe("Agent A's subagent Scout paused by Test User until 3:00 PM");
    // The orchestrator's own action does not name it twice.
    expect(subagentResultLabel({ ...paused, noticeBy: 'Agent A' }, content, clock)).toBe(
      "Agent A's subagent Scout paused"
    );
    expect(subagentReport(content, 'Scout')).toEqual({ error: null, report: '' });

    const removed = result({ status: 'stopped', notice: 'removed', noticeBy: 'Test User' });
    const removal = [
      '[subagent Scout removed by Test User]',
      '(Only Snaglet writes [subagent …] lines. Scout is gone, with its thread and work.)',
    ].join('\n');
    expect(subagentResultLabel(removed, removal)).toBe(
      "Agent A's subagent Scout removed by Test User"
    );
    expect(subagentReport(removal, 'Scout')).toEqual({ error: null, report: '' });
  });

  it('leaves content without the server headline intact', () => {
    expect(subagentReport('plain text', 'Scout')).toEqual({ error: null, report: 'plain text' });
  });
});

describe('helper thread copy and navigation', () => {
  it('titles the helper thread the way the server does', () => {
    expect(helperThreadTitle('Agent A', 'Scout')).toBe('Agent A › Scout');
    expect(helperThreadTitle(null, 'Scout')).toBe('Scout');
  });

  it('labels the header with the orchestrator when known', () => {
    expect(helperLabel({ name: 'Scout', orchestratorName: 'Agent A' })).toBe(
      "Agent A's subagent Scout"
    );
    expect(helperLabel({ name: 'Scout', orchestratorName: null })).toBe('Subagent Scout');
  });

  it('counts a live run in the helper thread as running', () => {
    expect(liveSubagentStatus('finished', true)).toBe('running');
    expect(liveSubagentStatus('failed', false)).toBe('failed');
  });

  it('reads a stopped helper as paused, with the end of a timed pause in the viewer zone', () => {
    const clock = { now: new Date('2026-10-12T12:00:00.000Z'), timeZone: 'UTC' };
    expect(liveSubagentLabel('stopped')).toBe('paused');
    expect(liveSubagentLabel('stopped', '2026-10-12T15:00:00.000Z', clock)).toBe(
      'paused until 3:00 PM'
    );
    expect(
      pausedUntilTime('2026-10-12T15:00:00.000Z', { ...clock, timeZone: 'America/New_York' })
    ).toBe('11:00 AM');
    expect(pausedUntilTime('2026-10-13T09:30:00.000Z', clock)).toBe('tomorrow 9:30 AM');
    expect(pausedUntilTime('2026-10-16T09:30:00.000Z', clock)).toBe('Fri, Oct 16, 9:30 AM');
    // A running label ignores a stale timer.
    expect(liveSubagentLabel('running', '2026-10-12T15:00:00.000Z', clock)).toBe('running');
  });

  it('waits for the user while a tool approval is pending', () => {
    expect(liveSubagentStatus('running', true, true)).toBe('waiting');
    expect(liveSubagentLabel('waiting')).toBe('waiting for you');
    expect(liveSubagentLabel('running')).toBe('running');
  });

  it('opens a helper thread as a titled, helper-marked thread selection (it is never in the tree)', () => {
    expect(helperThreadSelection('thread-helper-1', 'Agent A › Scout', 'thread-parent-1')).toEqual({
      kind: 'thread',
      thread_id: 'thread-helper-1',
      node: expect.objectContaining({
        kind: 'thread',
        id: 'thread-helper-1',
        title: 'Agent A › Scout',
      }),
      helperParentThreadId: 'thread-parent-1',
    });
  });
});
