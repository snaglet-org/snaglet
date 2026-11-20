import { describe, expect, it } from 'vitest';
import type { AgentCursorRequestEvent } from '@snaglet/shared/constants/agentCursor';
import {
  addRequest,
  approvalButtons,
  approvalPhrase,
  extractRequestMessage,
  markExpired,
  pruneExpiredRequests,
  resolveRequest,
} from './requestReducer';

const req = (over: Partial<AgentCursorRequestEvent> = {}): AgentCursorRequestEvent => ({
  requestId: 'r1',
  agentId: 'a1',
  name: 'Ada',
  flower: 'daisy',
  color: '#fff',
  expiresAt: 1000,
  ...over,
});

describe('request reducer', () => {
  it('adds and dedupes by requestId', () => {
    let l = addRequest([], req());
    l = addRequest(l, req({ reason: 'x' }));
    expect(l).toHaveLength(1);
    expect(l[0].reason).toBe('x');
  });
  it('stacks multiple requests in order', () => {
    const l = addRequest(addRequest([], req()), req({ requestId: 'r2' }));
    expect(l.map((r) => r.requestId)).toEqual(['r1', 'r2']);
  });
  it('resolve removes the matching request (answered elsewhere / timeout)', () => {
    const l = addRequest(addRequest([], req()), req({ requestId: 'r2' }));
    expect(resolveRequest(l, 'r1').map((r) => r.requestId)).toEqual(['r2']);
    expect(resolveRequest(l, 'nope')).toBe(l);
  });
  it('prunes expired requests', () => {
    const l = addRequest(addRequest([], req()), req({ requestId: 'r2', expiresAt: 5000 }));
    expect(pruneExpiredRequests(l, 2000).map((r) => r.requestId)).toEqual(['r2']);
    expect(pruneExpiredRequests(l, 10)).toBe(l);
  });
  it('keeps kind/profile and words browser requests differently', () => {
    const l = addRequest([], req({ kind: 'browser', profile: 'main' }));
    expect(l[0]).toMatchObject({ kind: 'browser', profile: 'main' });
    expect(approvalPhrase(l[0])).toBe('wants to use your signed-in browser');
    expect(approvalPhrase(req())).toBe('wants to use your cursor');
    expect(approvalPhrase(req({ kind: 'cursor' }))).toBe('wants to use your cursor');
  });
  it('handoff requests get their own phrase and Done / Cancel buttons', () => {
    const h = req({ kind: 'handoff', reason: 'Enter the 2FA code' });
    expect(approvalPhrase(h)).toBe('needs you to finish a step in the browser:');
    expect(approvalButtons(h)).toEqual({ allow: 'Done', session: null, deny: 'Cancel' });
    expect(approvalButtons(req()).session).toBe('Allow for this session');
    expect(addRequest([], h)[0]).toMatchObject({ kind: 'handoff', reason: 'Enter the 2FA code' });
  });
  it('marks expired', () => {
    expect(markExpired(addRequest([], req()), 'r1')[0].expired).toBe(true);
  });
  it('extracts request and resolved frames', () => {
    expect(extractRequestMessage({ type: 'agent:cursor-request', payload: req() })?.kind).toBe(
      'request'
    );
    expect(
      extractRequestMessage({
        payload: {
          type: 'agent:cursor-request-resolved',
          payload: { requestId: 'r1', decision: 'deny' },
        },
      })?.kind
    ).toBe('resolved');
    expect(extractRequestMessage({ type: 'other', payload: {} })).toBeNull();
  });
});
