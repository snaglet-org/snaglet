/**
 * The [PASS] / [DONE] affordance: `detectPassSignal`, the runtime classifier
 * for explicit pass tokens, and the soft-threshold nudge toward [PASS], which
 * lives in the per-turn ephemeral turn-context tail (not the system prompt)
 * and is rendered by `composeTurnContextData`.
 */

import { detectPassSignal } from '@server/services/SocketService/handlers/chatPhases/detectPassSignal';
import { composeTurnContextData } from '@server/services/SystemPromptComposer/composeTurnContextTail';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';

describe('detectPassSignal', () => {
  it('detects an explicit [PASS] on a continuation round', () => {
    const signal = detectPassSignal('[PASS]', true);
    expect(signal.isExplicitPass).toBe(true);
  });

  it('treats [DONE] as an alias for [PASS]', () => {
    const signal = detectPassSignal('[DONE]', true);
    expect(signal.isExplicitPass).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    const signal = detectPassSignal('  [pass]  ', true);
    expect(signal.isExplicitPass).toBe(true);
    expect(signal.trimmedReply).toBe('[pass]');
  });

  it('never passes on the first round', () => {
    const signal = detectPassSignal('[PASS]', false);
    expect(signal.isExplicitPass).toBe(false);
  });

  it('recognizes a trailing token after real content and strips it (parting message)', () => {
    const signal = detectPassSignal('Nothing further from me.\n\n[PASS]', true);
    expect(signal.isExplicitPass).toBe(true);
    expect(signal.strippedReply).toBe('Nothing further from me.');
  });

  it('recognizes a trailing [DONE] on the same line as prose', () => {
    const signal = detectPassSignal('Wrapping up here. [DONE]', true);
    expect(signal.isExplicitPass).toBe(true);
    expect(signal.strippedReply).toBe('Wrapping up here.');
  });

  it('mid-prose tokens are inert (writing about passing does not pass)', () => {
    const signal = detectPassSignal(
      'I will [PASS] on the naming question, but the API shape works.',
      true
    );
    expect(signal.isExplicitPass).toBe(false);
    expect(signal.strippedReply).toBe(
      'I will [PASS] on the naming question, but the API shape works.'
    );
  });

  it('a token followed by more prose is inert (a terminal signal must be terminal)', () => {
    const signal = detectPassSignal('[PASS]\nActually, one more thing…', true);
    expect(signal.isExplicitPass).toBe(false);
  });

  it('a token followed by trailing punctuation is inert (anchored means anchored)', () => {
    const signal = detectPassSignal('That is a [PASS].', true);
    expect(signal.isExplicitPass).toBe(false);
  });

  // Repetition (stagnation) detection is in chatPhases/detectStagnation.ts.
});

describe('soft-threshold nudge (turn-context tail)', () => {
  function makeCtx(overrides: Record<string, unknown> = {}): SystemPromptContext {
    return {
      replyAgentId: 'agent-1',
      runParams: { host_path: '/snaglet/host' },
      agentSoftThresholdNotified: new Set<string>(['agent-1']),
      agentDispatchCount: new Map<string, number>([['agent-1', 4]]),
      ...overrides,
    } as unknown as SystemPromptContext;
  }

  it('nudges the agent toward [PASS] once past the soft threshold', () => {
    const text = composeTurnContextData(makeCtx());

    expect(text).toMatch(/\[PASS\]/);
    expect(text).toContain('responded 4 times');
  });

  it('omits the nudge when the agent has not crossed the threshold', () => {
    const text = composeTurnContextData(makeCtx({ agentSoftThresholdNotified: new Set<string>() }));

    expect(text).not.toMatch(/\[PASS\]/);
    expect(text).not.toContain('responded');
  });
});
