import {
  abortAgentRun,
  abortThread,
  clearAbortController,
  clearAgentAbortController,
  createAbortController,
  createAgentAbortController,
  isAgentTurnSuperseded,
  listActiveAgentRuns,
  readAgentAbortReason,
} from '@server/services/SocketService/abortStore';

describe('per-agent abort store', () => {
  it('aborts only the targeted child and preserves attribution', () => {
    const parent = new AbortController();
    const a = createAgentAbortController('session-1', 'thread-1', 'agent-a', parent.signal);
    const b = createAgentAbortController('session-1', 'thread-1', 'agent-b', parent.signal);

    const result = abortAgentRun('thread-1', 'agent-a', {
      actorKind: 'agent',
      actorId: 'agent-caller',
      actorName: 'Aster',
    });

    expect(result).toEqual({ aborted: true, sessionId: 'session-1' });
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(readAgentAbortReason(a.signal)).toMatchObject({
      targetAgentId: 'agent-a',
      abortedBy: { actorKind: 'agent', actorName: 'Aster' },
    });
    expect(listActiveAgentRuns('thread-1')).toEqual([
      { agentId: 'agent-b', sessionId: 'session-1' },
    ]);

    clearAgentAbortController('thread-1', 'agent-b', b);
  });

  it('inherits a thread-wide parent abort while inactive targets are clean no-ops', () => {
    const parent = new AbortController();
    const child = createAgentAbortController('session-2', 'thread-2', 'agent-a', parent.signal);

    expect(
      abortAgentRun('thread-2', 'missing', {
        actorKind: 'user',
        actorId: 'user-1',
        actorName: 'Test User',
      })
    ).toEqual({ aborted: false });
    expect(child.signal.aborted).toBe(false);

    parent.abort();
    expect(child.signal.aborted).toBe(true);
    clearAgentAbortController('thread-2', 'agent-a', child);
  });

  it('does not let stale cleanup unregister a replacement run', () => {
    const parent = new AbortController();
    const stale = createAgentAbortController(
      'session-old',
      'thread-replaced',
      'agent-a',
      parent.signal
    );
    const replacement = createAgentAbortController(
      'session-new',
      'thread-replaced',
      'agent-a',
      parent.signal
    );

    clearAgentAbortController('thread-replaced', 'agent-a', stale);

    expect(listActiveAgentRuns('thread-replaced')).toEqual([
      { agentId: 'agent-a', sessionId: 'session-new' },
    ]);
    expect(replacement.signal.aborted).toBe(false);
    clearAgentAbortController('thread-replaced', 'agent-a', replacement);
  });

  it('reports a turn as superseded only when a newer controller owns the agent slot', () => {
    const parent = new AbortController();
    const stale = createAgentAbortController('session-1', 'thread-owner', 'agent-a', parent.signal);
    expect(isAgentTurnSuperseded('thread-owner', 'agent-a', stale)).toBe(false);

    const replacement = createAgentAbortController(
      'session-1',
      'thread-owner',
      'agent-a',
      parent.signal
    );
    expect(isAgentTurnSuperseded('thread-owner', 'agent-a', stale)).toBe(true);
    expect(isAgentTurnSuperseded('thread-owner', 'agent-a', replacement)).toBe(false);

    // An empty slot is not "superseded" — the settling turn may clean up.
    clearAgentAbortController('thread-owner', 'agent-a', replacement);
    expect(isAgentTurnSuperseded('thread-owner', 'agent-a', stale)).toBe(false);
  });
});

describe('session abort controller ownership', () => {
  it('a stale run clearing its controller leaves a newer run on the reused session stoppable', () => {
    const stale = createAbortController('session-reused', 'thread-reused');
    // Reaper-style abort, then a newer run registers on the same session id.
    abortThread('thread-reused');
    const newer = createAbortController('session-reused', 'thread-reused');

    clearAbortController('session-reused', stale);

    expect(abortThread('thread-reused')).toBe(1);
    expect(newer.signal.aborted).toBe(true);
  });

  it('the owner clears its own controller', () => {
    const own = createAbortController('session-own', 'thread-own');
    clearAbortController('session-own', own);
    expect(abortThread('thread-own')).toBe(0);
    expect(own.signal.aborted).toBe(false);
  });
});
