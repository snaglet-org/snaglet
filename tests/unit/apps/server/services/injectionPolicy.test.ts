import { describe, expect, it } from '@jest/globals';
import { decideMidRunInjection } from '@server/services/SocketService/handlers/chatPhases/injectionPolicy';

// Full (mode × sender-kind) matrix. The governing rule: a direct user message
// injects live in every mode (the human's own voice always reaches the running
// agent); peer (agent → agent) messages follow the thread's routing mode.
describe('decideMidRunInjection — (mode × sender) mid-run injection matrix', () => {
  describe('user sender — always injects, in every mode', () => {
    it('all', () => {
      expect(decideMidRunInjection('all', 'user', false)).toBe('inject');
      expect(decideMidRunInjection('all', 'user', true)).toBe('inject');
    });
    it('mentioned (even when not @mentioned)', () => {
      expect(decideMidRunInjection('mentioned', 'user', false)).toBe('inject');
      expect(decideMidRunInjection('mentioned', 'user', true)).toBe('inject');
    });
    it('unknown mode', () => {
      expect(decideMidRunInjection('something-new', 'user', false)).toBe('inject');
    });
  });

  describe('peer sender — follows the routing mode', () => {
    it('all mode always injects peer messages', () => {
      expect(decideMidRunInjection('all', 'peer', false)).toBe('inject');
      expect(decideMidRunInjection('all', 'peer', true)).toBe('inject');
    });
    it('mentioned mode injects a peer only when it @mentioned this agent', () => {
      expect(decideMidRunInjection('mentioned', 'peer', true)).toBe('inject');
      expect(decideMidRunInjection('mentioned', 'peer', false)).toBe('defer');
    });
    it('unknown modes stay conservative and defer peers', () => {
      expect(decideMidRunInjection('something-new', 'peer', true)).toBe('defer');
    });
  });

  // Thread-state narration (threadEvents: model / routing mode / budgets / wave
  // cap / run time limit / voice / vision / run-ended). Not a participant
  // speaking, so no routing rule applies: an agent that keeps running under a
  // state that just changed is working from a stale premise in every mode.
  describe('system sender (thread-state narration) — always injects, mode-independent', () => {
    it.each(['all', 'mentioned', 'something-new'])('%s mode', (mode) => {
      expect(decideMidRunInjection(mode, 'system', false)).toBe('inject');
      expect(decideMidRunInjection(mode, 'system', true)).toBe('inject');
    });

    it('is never deferred by the unknown-mode peer rule it superficially resembles', () => {
      // Both are author-less at the queue level; only `reason` separates them.
      expect(decideMidRunInjection('something-new', 'peer', false)).toBe('defer');
      expect(decideMidRunInjection('something-new', 'system', false)).toBe('inject');
    });
  });
});
