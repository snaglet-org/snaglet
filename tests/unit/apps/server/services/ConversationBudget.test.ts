/**
 * ConversationBudget — the unified wave counter + finite limits.
 *
 * There is no "unlimited" state: every limit arrives already clamped by
 * buildConversationBudget. `waveLimitReached()` governs starting new waves;
 * `exhaustedNonWave()` is the mid-wave spend gate (output tokens only; there is
 * no conversation-wide tool-iteration pool); `canContinue()` is their
 * conjunction. Seeds carry consumption into a self-healing redispatch. The
 * token pool only gates dispatch; it has no per-reply output size to hand out.
 */
import { ConversationBudget } from '@server/services/ConversationBudget';

const baseConfig = {
  maxTotalOutputTokens: 32_000,
  maxWaves: 4,
};

describe('ConversationBudget wave cap', () => {
  it('caps at maxWaves', () => {
    const b = new ConversationBudget({ ...baseConfig, maxWaves: 2 });
    b.incrementWave();
    expect(b.canContinue()).toBe(true);
    expect(b.waveLimitReached()).toBe(false);
    b.incrementWave();
    expect(b.canContinue()).toBe(false);
    expect(b.waveLimitReached()).toBe(true);
    expect(b.summary().exhaustedReason).toBe('max waves (2)');
    expect(b.waveLimit()).toBe(2);
  });

  it('exhaustedNonWave ignores the wave count (mid-wave gate)', () => {
    const b = new ConversationBudget({ ...baseConfig, maxWaves: 1 });
    b.incrementWave();
    // Wave limit reached, but no spend: mid-wave turns may still run.
    expect(b.waveLimitReached()).toBe(true);
    expect(b.exhaustedNonWave()).toBe(false);
  });

  it('stops on the output-token budget', () => {
    const b = new ConversationBudget({ ...baseConfig });
    b.incrementWave();
    b.recordAgentTurn(32_000);
    expect(b.exhaustedNonWave()).toBe(true);
    expect(b.canContinue()).toBe(false);
    expect(b.summary().exhaustedReason).toBe('output token budget (32000)');
  });

  it('stops on no tool-iteration pool — only tokens gate', () => {
    // There is no conversation-wide tool-iteration pool; recordAgentTurn
    // takes only output tokens, and no amount of tool churn can exhaust the
    // conversation. Only the output-token budget gates non-wave continuation.
    const b = new ConversationBudget({ ...baseConfig });
    b.incrementWave();
    b.recordAgentTurn(0); // a turn that burned tools but no tokens
    expect(b.exhaustedNonWave()).toBe(false);
    expect(b.canContinue()).toBe(true);
    expect(b.nonWaveExhaustionKind()).toBeNull();
  });

  it('lets a reply overshoot the pool; the pool only blocks what starts next', () => {
    // A single reply is never sized by the pool (requests ask for the model's
    // full output), so one turn can spend more than what was left. That turn's
    // output stands; only further turns are refused.
    const b = new ConversationBudget({ ...baseConfig });
    b.incrementWave();
    b.recordAgentTurn(30_000);
    expect(b.exhaustedNonWave()).toBe(false);
    b.recordAgentTurn(60_000);
    expect(b.summary().totalOutputTokens).toBe(90_000);
    expect(b.nonWaveExhaustionKind()).toBe('token-budget');
  });

  it('exposes no per-reply output budget', () => {
    const b = new ConversationBudget({ ...baseConfig });
    expect('agentOutputBudget' in b).toBe(false);
  });
});

describe('ConversationBudget seeding (continuation redispatch)', () => {
  it('a seed carries waves and spend into the new budget', () => {
    const first = new ConversationBudget({ ...baseConfig });
    first.incrementWave();
    first.incrementWave();
    first.recordAgentTurn(10_000);
    const continued = new ConversationBudget({ ...baseConfig }, first.seedSnapshot());
    expect(continued.currentWave()).toBe(2);
    expect(continued.summary().totalOutputTokens).toBe(10_000);
    // Two waves remain of the 4-wave limit.
    continued.incrementWave();
    continued.incrementWave();
    expect(continued.waveLimitReached()).toBe(true);
  });

  it('a seed at the limit blocks immediately', () => {
    const b = new ConversationBudget(
      { ...baseConfig, maxWaves: 2 },
      { waves: 2, totalOutputTokens: 0 }
    );
    expect(b.waveLimitReached()).toBe(true);
    expect(b.canContinue()).toBe(false);
  });
});
