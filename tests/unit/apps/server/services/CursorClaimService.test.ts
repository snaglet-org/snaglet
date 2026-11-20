import { CursorClaimService, CURSOR_LEASE_MS } from '@server/services/CursorClaimService';

describe('CursorClaimService', () => {
  let t = 0;
  const make = () => new CursorClaimService(() => t);
  beforeEach(() => {
    t = 1000;
  });

  it('grants a free cursor', () => {
    const s = make();
    expect(s.claim('test-agent-a', 'Test User')).toEqual({
      ok: true,
      holder: 'you',
      expiresInSec: 120,
    });
    expect(s.holderAgentId()).toBe('test-agent-a');
  });

  it('reports busy to a second agent', () => {
    const s = make();
    s.claim('test-agent-a', 'Test User');
    const r = s.claim('test-agent-b', 'Other User');
    expect(r).toMatchObject({
      ok: false,
      busy: true,
      holder: 'Test User',
      message: 'Test User is using the cursor. Wait your turn.',
    });
    expect(s.busyFor('test-agent-b')).not.toBeNull();
    expect(s.busyFor('test-agent-a')).toBeNull();
  });

  it('expires the lease and renews it', () => {
    const s = make();
    s.claim('test-agent-a', 'Test User');
    t += CURSOR_LEASE_MS - 1;
    expect(s.renew('test-agent-a')).toBe(true);
    t += CURSOR_LEASE_MS - 1;
    expect(s.holderAgentId()).toBe('test-agent-a');
    t += 2;
    expect(s.holderAgentId()).toBeNull();
    expect(s.claim('test-agent-b', 'Other User').ok).toBe(true);
  });

  it('releases only for the holder', () => {
    const s = make();
    s.claim('test-agent-a', 'Test User');
    expect(s.release('test-agent-b')).toBe(false);
    expect(s.release('test-agent-a')).toBe(true);
    expect(s.holderAgentId()).toBeNull();
  });

  it('revokes whoever holds it', () => {
    const s = make();
    s.claim('test-agent-a', 'Test User');
    expect(s.revoke()).toEqual({ agentId: 'test-agent-a', name: 'Test User' });
    expect(s.holderAgentId()).toBeNull();
    expect(s.revoke()).toBeNull();
  });

  it('reports state: free, claimed with age, renewed, expired', () => {
    const s = make();
    expect(s.state()).toEqual({
      claimed: false,
      agentId: null,
      claimId: null,
      lastActionAgeMs: null,
    });
    s.claim('test-agent-a', 'Test User');
    expect(s.state()).toEqual({
      claimed: true,
      agentId: 'test-agent-a',
      claimId: 1,
      lastActionAgeMs: 0,
    });
    t += 5000;
    expect(s.state().lastActionAgeMs).toBe(5000);
    expect(s.state(t + 1000).lastActionAgeMs).toBe(6000);
    s.renew('test-agent-a');
    expect(s.state().lastActionAgeMs).toBe(0);
    t += CURSOR_LEASE_MS;
    expect(s.state()).toEqual({
      claimed: false,
      agentId: null,
      claimId: null,
      lastActionAgeMs: null,
    });
    expect(s.state(1000).claimed).toBe(true);
  });
});

describe('CursorClaimService claimId', () => {
  let t = 1000;
  it('increments on fresh claims only and shows in state()', () => {
    const s = new CursorClaimService(() => t);
    expect(s.state()).toEqual({
      claimed: false,
      agentId: null,
      claimId: null,
      lastActionAgeMs: null,
    });
    s.claim('test-agent-a', 'Test User');
    const first = s.state().claimId;
    expect(first).toEqual(expect.any(Number));
    s.claim('test-agent-a', 'Test User');
    s.renew('test-agent-a');
    expect(s.state().claimId).toBe(first);
    s.release('test-agent-a');
    expect(s.state().claimId).toBeNull();
    s.claim('test-agent-a', 'Test User');
    expect(s.state().claimId).toBe((first as number) + 1);
    t += CURSOR_LEASE_MS + 1;
    s.claim('test-agent-b', 'Other User');
    expect(s.state().claimId).toBe((first as number) + 2);
  });
});
