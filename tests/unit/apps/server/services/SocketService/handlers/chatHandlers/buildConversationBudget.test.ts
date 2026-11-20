/**
 * buildConversationBudget — limit math.
 *
 * `maxTotalOutputTokens`: effective = min(threadOverride ?? settingsDefault,
 * serverCeiling). A thread-level `budget.maxOutputTokens` in stored
 * config_json is ignored (no crash, no effect on the cap); the override key is
 * `maxTotalOutputTokens`. `maxWaves`: a positive thread override is honored
 * exactly, with no ceiling clamp; `null` means unbounded; anything else falls
 * back to the settings default. The settings mock returns each setting's real
 * registry default, so these cases pin the shipped defaults.
 */
import { buildConversationBudget } from '@server/services/SocketService/handlers/chatHandlers/buildConversationBudget';
import { DEFAULT_MAX_OUTPUT_TOKENS_CEILING } from '@server/services/groupChat/safety';
import { budgetSettings } from '@server/services/settings/categories/budget';
import type { ThreadRuntimeConfig } from '@server/services/ConfigResolverService';

const read = jest.fn(async (setting: { default: unknown }) => setting.default);
jest.mock('@server/services/settings', () => ({
  settingsService: { read: (setting: { default: unknown }) => read(setting) },
}));

function expectPoolOf(budget: Awaited<ReturnType<typeof buildConversationBudget>>, cap: number) {
  budget.incrementWave();
  budget.recordAgentTurn(cap - 1);
  expect(budget.exhaustedNonWave()).toBe(false);
  budget.recordAgentTurn(1);
  expect(budget.exhaustedNonWave()).toBe(true);
  expect(budget.summary().exhaustedReason).toBe(`output token budget (${cap})`);
}

describe('buildConversationBudget', () => {
  it('defaults both profiles to the server ceiling and drops the per-agent budget', () => {
    expect(budgetSettings.group.default.conversationTokenBudget).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS_CEILING
    );
    expect(budgetSettings.solo.default.conversationTokenBudget).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS_CEILING
    );
    expect(budgetSettings.group.default).not.toHaveProperty('perAgentTokenBudget');
    expect(budgetSettings.solo.default).not.toHaveProperty('perAgentTokenBudget');
  });

  it('builds a solo budget from the settings registry', async () => {
    const budget = await buildConversationBudget({ isGroup: false, threadRuntimeConfig: null });
    expect(budget.canContinue()).toBe(true);
    expect(budget.waveLimit()).toBe(Number.POSITIVE_INFINITY);
    expectPoolOf(budget, DEFAULT_MAX_OUTPUT_TOKENS_CEILING);
  });

  it('group budget takes the group defaults', async () => {
    const budget = await buildConversationBudget({ isGroup: true, threadRuntimeConfig: null });
    expect(budget.waveLimit()).toBe(Number.POSITIVE_INFINITY);
    expectPoolOf(budget, DEFAULT_MAX_OUTPUT_TOKENS_CEILING);
  });

  it('honors a saved settings override of the pool', async () => {
    read.mockResolvedValueOnce({ conversationTokenBudget: 32_000, maxWaves: 24 });
    const budget = await buildConversationBudget({ isGroup: false, threadRuntimeConfig: null });
    expect(budget.waveLimit()).toBe(24); // saved finite profile is preserved
    expectPoolOf(budget, 32_000);
  });

  it('ignores stale budget.maxOutputTokens in thread config', async () => {
    const threadRuntimeConfig = {
      // Simulates an older thread row that still carries the dead key.
      budget: { maxOutputTokens: 50 },
    } as ThreadRuntimeConfig;

    const budget = await buildConversationBudget({ isGroup: false, threadRuntimeConfig });

    // Cap must come from settings (the default pool), not the stale
    // 50-token override: after spending 100 tokens the conversation continues.
    budget.recordAgentTurn(100);
    expect(budget.canContinue()).toBe(true);
  });

  it('ignores a stored budget.maxTotalToolIterations override gracefully (no such pool)', async () => {
    const threadRuntimeConfig = {
      // A stored thread row carrying a conversation-wide pool key that is not used.
      budget: { maxTotalToolIterations: 1 },
    } as ThreadRuntimeConfig;

    // Must not throw on the stale key, and must not resurrect any tool gate:
    const budget = await buildConversationBudget({ isGroup: true, threadRuntimeConfig });
    budget.incrementWave();
    // Only the output-token budget can gate non-wave continuation.
    expect(budget.exhaustedNonWave()).toBe(false);
    expect(budget.canContinue()).toBe(true);
    expect(budget.nonWaveExhaustionKind()).toBeNull();
  });

  it('honors the thread-level maxWaves override exactly, no server ceiling clamp', async () => {
    const threadRuntimeConfig = { budget: { maxWaves: 1 } } as ThreadRuntimeConfig;

    const budget = await buildConversationBudget({ isGroup: true, threadRuntimeConfig });

    budget.incrementWave();
    expect(budget.waveLimitReached()).toBe(true);
    expect(budget.summary().exhaustedReason).toBe('max waves (1)');
  });

  it('honors a maxWaves override well above the historical ceiling (no clamp)', async () => {
    const threadRuntimeConfig = { budget: { maxWaves: 999 } } as ThreadRuntimeConfig;

    const budget = await buildConversationBudget({ isGroup: true, threadRuntimeConfig });

    expect(budget.waveLimit()).toBe(999);
  });

  it('treats a null maxWaves override as genuinely unbounded', async () => {
    const threadRuntimeConfig = { budget: { maxWaves: null } } as ThreadRuntimeConfig;

    const budget = await buildConversationBudget({ isGroup: false, threadRuntimeConfig });

    expect(budget.waveLimit()).toBe(Number.POSITIVE_INFINITY);
    for (let i = 0; i < 1000; i++) budget.incrementWave();
    expect(budget.waveLimitReached()).toBe(false);
    expect(budget.canContinue()).toBe(true);
  });

  it('ignores a non-positive maxWaves override (keeps the settings default)', async () => {
    // 0 is not a meaningful cap; fall back to the unbounded default
    // rather than wedging the loop at zero waves.
    const threadRuntimeConfig = { budget: { maxWaves: 0 } } as ThreadRuntimeConfig;

    const budget = await buildConversationBudget({ isGroup: false, threadRuntimeConfig });

    expect(budget.waveLimit()).toBe(Number.POSITIVE_INFINITY);
  });

  it('honors the honest maxTotalOutputTokens override', async () => {
    const threadRuntimeConfig = {
      budget: { maxTotalOutputTokens: 1_000 },
    } as ThreadRuntimeConfig;

    const budget = await buildConversationBudget({ isGroup: true, threadRuntimeConfig });

    budget.recordAgentTurn(1_000);
    expect(budget.exhaustedNonWave()).toBe(true);
    expect(budget.summary().exhaustedReason).toBe('output token budget (1000)');
  });

  it('clamps maxTotalOutputTokens to the server ceiling', async () => {
    const threadRuntimeConfig = {
      budget: { maxTotalOutputTokens: 5_000_000 },
    } as ThreadRuntimeConfig;

    const budget = await buildConversationBudget({ isGroup: true, threadRuntimeConfig });

    budget.recordAgentTurn(DEFAULT_MAX_OUTPUT_TOKENS_CEILING);
    expect(budget.exhaustedNonWave()).toBe(true);
    expect(budget.summary().exhaustedReason).toBe(
      `output token budget (${DEFAULT_MAX_OUTPUT_TOKENS_CEILING})`
    );
  });

  it('a seed carries prior consumption into the built budget', async () => {
    const budget = await buildConversationBudget({
      isGroup: true,
      threadRuntimeConfig: null,
      seed: { waves: 23, totalOutputTokens: 100 },
    });
    expect(budget.currentWave()).toBe(23);
    budget.incrementWave();
    expect(budget.waveLimitReached()).toBe(false); // no default wave cap
  });

  it('enforces the registry conversation cap', async () => {
    const budget = await buildConversationBudget({ isGroup: true, threadRuntimeConfig: null });

    budget.recordAgentTurn(DEFAULT_MAX_OUTPUT_TOKENS_CEILING);
    expect(budget.canContinue()).toBe(false);
  });
});
