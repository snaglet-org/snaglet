/**
 * A message injected into a run that is already going: the run
 * acts on it inside that same run, so draining it raises the run's ambient
 * chain context to the merge of its own and the message's stamp. It never
 * lowers it, and a person's (unstamped) message leaves it unchanged.
 */
import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  currentChainDepth,
  currentHookChain,
  runAtChainDepth,
  runInOwnChainScope,
  runWithRunContext,
} from '@server/realtime/runContext';
import { raiseAmbientChain } from '@server/services/customHooks/chainStamp';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { drainInjectablePeerMessages } from '@server/services/SocketService/handlers/chatPhases/peerInjection';

const T = 'thread-inject-depth';
const A = 'agent-running';

/** What a tool call later in this run would see. */
function ambient(): { depth: number; hooks: readonly string[] } {
  return { depth: currentChainDepth(), hooks: currentHookChain() };
}

/** A run bound at `depth`/`hooks`, like runAgentTurnLoop's per-turn scope. */
function inRun<T>(depth: number, hooks: readonly string[], fn: () => T): T {
  return runAtChainDepth(depth, () => runInOwnChainScope(fn), undefined, hooks);
}

function enqueueHookMessage(depth: number, hooks: string[]): void {
  pendingAgentMessages.enqueue({
    threadId: T,
    targetAgentId: A,
    senderAgentId: 'agent-hook-sender',
    senderName: 'hook-sender',
    content: `hook says (depth ${depth})`,
    reason: 'all-mode-thread-message',
    sourceMessageId: `message-${depth}-${hooks.join('-')}`,
    chain: { depth, hooks },
  });
}

function enqueuePersonMessage(): void {
  pendingAgentMessages.enqueue({
    threadId: T,
    targetAgentId: A,
    senderUserId: 'user-1',
    senderName: 'User',
    content: 'a person, mid-run',
    reason: 'user-mid-run',
  });
}

describe('raiseAmbientChain', () => {
  it('raises a shallower run to the stamp and merges the chain', () => {
    inRun(1, ['x'], () => {
      expect(raiseAmbientChain([{ depth: 3, hooks: ['a', 'b', 'c'] }])).toBe(true);
      expect(ambient()).toEqual({ depth: 3, hooks: ['a', 'b', 'c', 'x'] });
    });
  });

  it('never decreases: a shallower stamp keeps the depth and only adds its hooks', () => {
    inRun(4, ['a', 'b', 'c', 'd'], () => {
      raiseAmbientChain([{ depth: 1, hooks: ['z'] }]);
      expect(ambient()).toEqual({ depth: 4, hooks: ['a', 'b', 'c', 'd', 'z'] });
      raiseAmbientChain([{ depth: 2, hooks: ['a'] }]);
      expect(ambient().depth).toBe(4);
    });
  });

  it('a person’s message (no stamp) leaves the context unchanged', () => {
    inRun(2, ['a', 'b'], () => {
      expect(raiseAmbientChain([null, null])).toBe(false);
      expect(ambient()).toEqual({ depth: 2, hooks: ['a', 'b'] });
    });
    inRun(0, [], () => {
      expect(raiseAmbientChain([])).toBe(false);
      expect(ambient()).toEqual({ depth: 0, hooks: [] });
    });
  });

  it('stays inside the run’s own scope: the enclosing wave context is untouched', () => {
    runAtChainDepth(
      1,
      () => {
        runInOwnChainScope(() => raiseAmbientChain([{ depth: 5, hooks: ['deep'] }]));
        expect(ambient()).toEqual({ depth: 1, hooks: ['w'] });
      },
      undefined,
      ['w']
    );
  });

  it('is seen by a tool call bound later in the same run (runWithRunContext inherits it)', () => {
    inRun(0, [], () => {
      raiseAmbientChain([{ depth: 2, hooks: ['h', 'h'] }]);
      const seen = runWithRunContext({ threadId: T, runId: 'run-1' }, ambient);
      expect(seen).toEqual({ depth: 2, hooks: ['h', 'h'] });
    });
  });
});

describe('drainInjectablePeerMessages — chain depth of the injected messages', () => {
  beforeEach(() => pendingAgentMessages.clearAgent(T, A));

  it('injecting a hook message raises the running agent to the message’s depth', () => {
    enqueueHookMessage(3, ['loop', 'loop', 'loop']);
    inRun(1, ['loop'], () => {
      expect(drainInjectablePeerMessages({ threadId: T, agentId: A, mode: 'all' })).toHaveLength(1);
      expect(ambient()).toEqual({ depth: 3, hooks: ['loop', 'loop', 'loop'] });
    });
  });

  it('never decreases when the injected stamp is shallower than the run', () => {
    enqueueHookMessage(1, ['h']);
    inRun(3, ['a', 'b', 'c'], () => {
      drainInjectablePeerMessages({ threadId: T, agentId: A, mode: 'all' });
      expect(ambient().depth).toBe(3);
    });
  });

  it('a person’s injected message leaves the depth unchanged', () => {
    enqueuePersonMessage();
    inRun(2, ['a', 'b'], () => {
      expect(drainInjectablePeerMessages({ threadId: T, agentId: A, mode: 'all' })).toHaveLength(1);
      expect(ambient()).toEqual({ depth: 2, hooks: ['a', 'b'] });
    });
  });

  it('with a person’s and a hook’s message in one drain, the deepest stamp wins', () => {
    enqueuePersonMessage();
    enqueueHookMessage(2, ['h', 'h']);
    inRun(0, [], () => {
      drainInjectablePeerMessages({ threadId: T, agentId: A, mode: 'all' });
      expect(ambient()).toEqual({ depth: 2, hooks: ['h', 'h'] });
    });
  });

  it('a deferred message (not injected this seam) does not raise the run', () => {
    enqueueHookMessage(3, ['h']); // a peer broadcast: an un-mentioned peer defers it
    inRun(0, [], () => {
      expect(drainInjectablePeerMessages({ threadId: T, agentId: A, mode: 'mentioned' })).toEqual(
        []
      );
      expect(ambient().depth).toBe(0);
    });
  });
});
