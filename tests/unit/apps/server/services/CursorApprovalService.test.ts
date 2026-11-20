jest.mock('@server/services/WebSocketService', () => ({ wsService: { broadcast: jest.fn() } }));

import { CursorApprovalService } from '@server/services/CursorApprovalService';

describe('CursorApprovalService', () => {
  let t = 0;
  let timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  let sent: Array<{ type: string; payload: unknown }> = [];
  const make = () =>
    new CursorApprovalService({
      now: () => t,
      broadcast: (m) => sent.push(m as never),
      setTimer: (fn, ms) => {
        const e = { fn, at: t + ms, live: true };
        timers.push(e);
        return e;
      },
      clearTimer: (e) => {
        (e as { live: boolean }).live = false;
      },
      timeoutMs: () => 45_000,
      sessionMs: () => 30 * 60_000,
    });
  const advance = (ms: number) => {
    t += ms;
    timers.filter((e) => e.live && e.at <= t).forEach((e) => ((e.live = false), e.fn()));
  };
  const req = {
    agentId: 'test-agent-a',
    name: 'Test User',
    flower: 'daisy' as never,
    color: '#fff',
  };
  const reqId = () => sent.find((m) => m.type === 'agent:cursor-request')!.payload.requestId;

  beforeEach(() => {
    t = 1000;
    timers = [];
    sent = [];
  });

  it('allow resolves and broadcasts both events', async () => {
    const s = make();
    const p = s.requestApproval(req);
    expect(sent[0].payload).toMatchObject({ agentId: 'test-agent-a', expiresAt: 46_000 });
    expect(s.resolveApproval(reqId(), 'allow')).toBe(true);
    expect(await p).toBe('allow');
    expect(sent[1]).toMatchObject({
      type: 'agent:cursor-request-resolved',
      payload: { decision: 'allow' },
    });
    expect(s.hasSessionGrant('test-agent-a')).toBe(false);
  });

  it('allow-session grants for 30 minutes then expires', async () => {
    const s = make();
    const p = s.requestApproval(req);
    s.resolveApproval(reqId(), 'allow-session');
    await p;
    expect(s.hasSessionGrant('test-agent-a')).toBe(true);
    expect(s.sessionGrants()[0].expiresInSec).toBe(1800);
    t += 30 * 60_000;
    expect(s.hasSessionGrant('test-agent-a')).toBe(false);
  });

  it('deny resolves deny', async () => {
    const s = make();
    const p = s.requestApproval(req);
    s.resolveApproval(reqId(), 'deny');
    expect(await p).toBe('deny');
  });

  it('times out after 45s and broadcasts resolved', async () => {
    const s = make();
    const p = s.requestApproval(req);
    advance(45_000);
    expect(await p).toBe('timeout');
    expect(sent[1].payload.decision).toBe('timeout');
  });

  it('a second request while pending shares the first', async () => {
    const s = make();
    const p1 = s.requestApproval(req);
    const p2 = s.requestApproval(req);
    expect(sent.filter((m) => m.type === 'agent:cursor-request')).toHaveLength(1);
    s.resolveApproval(reqId(), 'allow');
    expect(await Promise.all([p1, p2])).toEqual(['allow', 'allow']);
  });

  it('unknown or already-resolved id returns false', async () => {
    const s = make();
    expect(s.resolveApproval('nope', 'allow')).toBe(false);
    const p = s.requestApproval(req);
    const id = reqId();
    s.resolveApproval(id, 'allow');
    await p;
    expect(s.resolveApproval(id, 'allow')).toBe(false);
  });

  it('revokeAll clears grants and pending prompts', async () => {
    const s = make();
    const p = s.requestApproval(req);
    s.resolveApproval(reqId(), 'allow-session');
    await p;
    const p2 = s.requestApproval({ ...req, agentId: 'test-agent-b' });
    s.revokeAll();
    expect(await p2).toBe('deny');
    expect(s.hasSessionGrant('test-agent-a')).toBe(false);
  });
  it('browser requests carry kind and profile, and grants are per (agent, profile)', async () => {
    const s = make();
    const p = s.requestApproval({ ...req, kind: 'browser', profile: 'main' });
    expect(sent[0].payload).toMatchObject({ kind: 'browser', profile: 'main' });
    s.resolveApproval(reqId(), 'allow-session');
    await p;
    expect(s.hasSessionGrant('test-agent-a', 'main')).toBe(true);
    expect(s.hasSessionGrant('test-agent-a', 'work')).toBe(false);
    expect(s.hasSessionGrant('test-agent-a')).toBe(false);
    expect(s.sessionGrants()).toEqual([
      { agentId: 'test-agent-a', profile: 'main', expiresInSec: 1800 },
    ]);
    advance(30 * 60_000 + 1);
    expect(s.hasSessionGrant('test-agent-a', 'main')).toBe(false);
  });

  it('a pending cursor request does not swallow a browser request', () => {
    const s = make();
    void s.requestApproval(req);
    void s.requestApproval({ ...req, kind: 'browser', profile: 'main' });
    expect(sent.filter((m) => m.type === 'agent:cursor-request')).toHaveLength(2);
  });

  it('handoff carries kind and message, has its own timeout, and never grants a session', async () => {
    const s = make();
    const p = s.requestApproval({
      ...req,
      kind: 'handoff',
      reason: 'Enter the 2FA code',
      timeoutMs: 600_000,
    });
    expect(sent[0].payload).toMatchObject({
      kind: 'handoff',
      reason: 'Enter the 2FA code',
      expiresAt: 601_000,
    });
    s.resolveApproval(reqId(), 'allow-session');
    expect(await p).toBe('allow-session');
    expect(s.hasSessionGrant('test-agent-a')).toBe(false);
    expect(s.sessionGrants()).toEqual([]);
  });

  it('handoff times out after its own deadline and does not collide with browser/cursor requests', async () => {
    const s = make();
    const p = s.requestApproval({ ...req, kind: 'handoff', reason: 'x', timeoutMs: 120_000 });
    void s.requestApproval({ ...req, kind: 'browser', profile: 'main' });
    expect(sent.filter((m) => m.type === 'agent:cursor-request')).toHaveLength(2);
    advance(45_001);
    expect(s.isPending('test-agent-a')).toBe(true);
    advance(80_000);
    expect(await p).toBe('timeout');
  });
});
