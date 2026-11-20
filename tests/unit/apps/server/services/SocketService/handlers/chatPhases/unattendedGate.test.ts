/**
 * unattendedGate — the pure decision an unattended run (an automation or a
 * hook started it) makes for a tool call that would ask a person, and the
 * copy it produces. Wiring into dispatch is covered by toolDispatch.test.ts.
 */
import { describe, expect, it } from '@jest/globals';
import type { UnattendedWake } from '@snaglet/shared/types';
import {
  decideUnattendedCall,
  unattendedLineBody,
  unattendedSkipMessage,
  unattendedToolLabel,
} from '@server/services/SocketService/handlers/chatPhases/unattendedGate';

const wake = (policy: UnattendedWake['policy']): UnattendedWake => ({
  source: 'automation',
  id: 'automation-1111111111111-aaaaaaaaa',
  name: 'Test automation',
  policy,
  since: '2026-01-01T00:00:00.000Z',
});

describe('decideUnattendedCall', () => {
  it('skip: skips whatever made the call ask', () => {
    expect(decideUnattendedCall({ unattended: wake('skip'), accessAsks: false })).toEqual({
      action: 'skip',
      cause: 'policy',
    });
    expect(decideUnattendedCall({ unattended: wake('skip'), accessAsks: true })).toEqual({
      action: 'skip',
      cause: 'policy',
    });
  });

  it('auto-approve-allowed: approves a call that asks only because the tool asks first', () => {
    expect(
      decideUnattendedCall({ unattended: wake('auto-approve-allowed'), accessAsks: false })
    ).toEqual({ action: 'auto-approve' });
  });

  it('auto-approve-allowed: does not approve once a person has posted in the thread', () => {
    expect(
      decideUnattendedCall({
        unattended: wake('auto-approve-allowed'),
        accessAsks: false,
        personPresent: true,
      })
    ).toEqual({ action: 'skip', cause: 'person' });
  });

  it('auto-approve-allowed: still skips a call the access rules ask about', () => {
    expect(
      decideUnattendedCall({ unattended: wake('auto-approve-allowed'), accessAsks: true })
    ).toEqual({ action: 'skip', cause: 'access' });
  });
});

describe('unattendedToolLabel', () => {
  it('names the op of a merged tool', () => {
    expect(unattendedToolLabel('shell', { op: 'run', command: 'ls' })).toBe('shell (run)');
  });

  it('names a tool without an op by its id', () => {
    expect(unattendedToolLabel('file_read', { path: '/tmp/a' })).toBe('file_read');
  });
});

describe('unattendedSkipMessage', () => {
  it('says the call did not run and the run goes on', () => {
    const message = unattendedSkipMessage('shell (run)', 'policy');
    expect(message).toContain("Tool 'shell (run)' was not run");
    expect(message).toContain('needs a person to confirm; skipped (unattended run');
    expect(message).toContain('Carry on without it');
  });

  it('carries the access reason when the access rules asked', () => {
    expect(
      unattendedSkipMessage('shell (run)', 'access', 'Not covered by an allow rule: command `rm`.')
    ).toContain('(Not covered by an allow rule: command `rm`.)');
    expect(unattendedSkipMessage('file_read', 'access')).toContain(
      '(not allowed outright by your tool access)'
    );
  });
});

describe('unattendedLineBody', () => {
  it('reads as one [unattended] line per outcome', () => {
    expect(
      unattendedLineBody({
        decision: { action: 'auto-approve' },
        toolLabel: 'shell (run)',
        agentName: 'Test Agent A',
        unattended: wake('auto-approve-allowed'),
      })
    ).toBe('auto-approved shell (run) · Test Agent A · automation "Test automation"');
    expect(
      unattendedLineBody({
        decision: { action: 'skip', cause: 'policy' },
        toolLabel: 'shell (run)',
        agentName: 'Test Agent A',
        unattended: {
          source: 'hook',
          id: 'test-hook',
          name: 'test-hook',
          policy: 'skip',
          since: '2026-01-01T00:00:00.000Z',
        },
      })
    ).toBe('skipped shell (run) · Test Agent A · hook "test-hook" · needs a person to confirm');
    expect(
      unattendedLineBody({
        decision: { action: 'skip', cause: 'access' },
        toolLabel: 'file_read',
        agentName: 'Test Agent A',
        unattended: wake('auto-approve-allowed'),
      })
    ).toBe(
      'skipped file_read · Test Agent A · automation "Test automation" · not allowed outright by tool access'
    );
  });
});
