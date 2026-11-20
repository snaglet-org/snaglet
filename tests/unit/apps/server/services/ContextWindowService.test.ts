/**
 * ContextWindowService: resolveContextBudget (defaults, metadata, thread and
 * agent overrides) and compressMessages (no-op below threshold, sliding
 * window above it, tool_use/tool_result pairing, group mode).
 *
 * metadataResolver is mocked directly rather than the Models+Providers tables:
 * the budget resolver is its only consumer and the contract is one call.
 */

const mockResolveModelMetadata = jest.fn();
const mockFindByProviderAndModelId = jest.fn();
const mockGetEffectiveModel = jest.fn();

jest.mock('@server/services/metadataResolver.js', () => ({
  resolveModelMetadata: (...args: unknown[]) => mockResolveModelMetadata(...args),
}));

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    findByProviderAndModelId: (...args: unknown[]) => mockFindByProviderAndModelId(...args),
  },
}));

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    getEffectiveModel: (...args: unknown[]) => mockGetEffectiveModel(...args),
  },
}));

import {
  resolveContextBudget,
  compressMessages,
  findCurrentRunBoundary,
  type ContextBudget,
} from '@server/services/ContextWindowService';
import { TURN_CONTEXT_HEADER } from '@server/services/SystemPromptComposer/composeTurnContextTail';
import {
  RELAYED_CLOSE,
  RELAYED_LEGEND,
  RELAYED_OPEN,
} from '@server/services/SocketService/handlers/chatPhases/replayAssembly';
import { THREAD_EVENT_LINE_PREFIXES } from '@server/services/SocketService/threadEvents';
import { prepareAnthropicApiMessages } from '@server/services/ProviderChatService/providers/anthropicMessagePrep';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';
import { logger } from '@server/config/logger';
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { SnagletAgent } from '@snaglet/shared/types/agent';

const baseBudget: ContextBudget = {
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-5',
  contextWindowTokens: 128_000,
  effectiveContextWindowTokens: Math.floor(128_000 * 0.98),
  safetyMarginPct: 2,
  systemPromptTokens: 0,
  toolCatalogTokens: 0,
  overheadTokens: 0,
  overheadFloored: false,
  maxOutputTokens: 4_096,
  usableBudget: 128_000 - 4_096,
  tokenThreshold: 1_000_000,
  tailMessages: 4,
  minMessagesBeforeCompression: 6,
  maxSummaryChars: 2000,
};

const baseAgent = (overrides: Partial<SnagletAgent> = {}): SnagletAgent =>
  ({
    id: 'agent-1',
    name: 'Test Agent',
    role: 'tester',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    configJson: {},
    ...overrides,
  }) as SnagletAgent;

const userMsg = (content: string) => ({ role: 'user' as const, content });
const assistantMsg = (content: string) => ({ role: 'assistant' as const, content });
const toolUseMsg = (id: string) => ({
  role: 'assistant' as const,
  content: [{ type: 'tool_use', id, name: 'test_tool', input: {} }],
});
const toolResultMsg = (id: string, result = 'ok') => ({
  role: 'user' as const,
  content: [{ type: 'tool_result', tool_use_id: id, content: result }],
});
// The live tool loop folds peer/user injections and loop-breaking nudges into
// the tool_result user turn (toolDispatch: `[...toolResults, ...appendedText]`),
// producing a mixed `[tool_result, text]` message. The active-request reminder
// must not re-pin this shape, or it orphans the tool_result.
const toolResultWithText = (id: string, text: string, result = 'ok'): ProviderMessage =>
  ({
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content: result },
      { type: 'text', text },
    ],
  }) as unknown as ProviderMessage;

/**
 * Collect tool_result ids in `messages` whose tool_use never appeared earlier
 * in the array — i.e. orphaned pairs that would 400 the Anthropic API.
 */
const collectOrphanToolResultIds = (messages: readonly ProviderMessage[]): string[] => {
  const seenUseIds = new Set<string>();
  const orphans: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') seenUseIds.add(block.id);
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        if (!seenUseIds.has(block.tool_use_id)) orphans.push(block.tool_use_id);
      }
    }
  }
  return orphans;
};

beforeEach(() => {
  mockResolveModelMetadata.mockReset();
  mockFindByProviderAndModelId.mockReset();
  mockGetEffectiveModel.mockReset();

  mockGetEffectiveModel.mockResolvedValue({
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
  });
  mockFindByProviderAndModelId.mockResolvedValue({
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
    metadata: {
      contextCompression: {
        contextWindowTokens: 128_000,
        maxOutputTokens: 4_096,
      },
    },
  });
  mockResolveModelMetadata.mockResolvedValue({
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    metadata: {
      contextCompression: {
        contextWindowTokens: 128_000,
        maxOutputTokens: 4_096,
      },
    },
  });
});

describe('resolveContextBudget', () => {
  // Anthropic's provider safety margin is 2%.
  const EFFECTIVE_WINDOW = Math.floor(128_000 * 0.98);

  test.each([
    ['codex', 'gpt-6-luna', 272_000],
    ['codex', 'gpt-6.1-terra', 272_000],
    ['mistral', 'mistral-medium-latest', 128_000],
    ['together', 'Qwen/Qwen3.7-Max', 262_144],
    ['anthropic', 'claude-new-unlisted', 200_000],
  ])(
    'budgets a %s model with no stated window (%s) on the provider default, never 8,192',
    async (provider, modelId, window) => {
      mockGetEffectiveModel.mockResolvedValueOnce({ providerId: provider, modelId });
      mockFindByProviderAndModelId.mockResolvedValueOnce({
        contextWindowTokens: null,
        maxOutputTokens: null,
      });
      const budget = await resolveContextBudget(baseAgent(), 'thread-1');
      expect(budget.contextWindowTokens).toBe(window);
      expect(budget.contextWindowTokens).not.toBe(8_192);
    }
  );

  test('keeps the 8,192 default for a local runtime whose window is unknown', async () => {
    mockGetEffectiveModel.mockResolvedValueOnce({ providerId: 'ollama', modelId: 'qwen3:4b' });
    mockFindByProviderAndModelId.mockResolvedValueOnce(null);
    const budget = await resolveContextBudget(baseAgent(), 'thread-1');
    expect(budget.contextWindowTokens).toBe(8_192);
  });

  test('returns defaults derived from model metadata', async () => {
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);
    const budget = await resolveContextBudget(agent, 'thread-1');
    expect(budget.contextWindowTokens).toBe(128_000); // raw, for display
    expect(budget.effectiveContextWindowTokens).toBe(EFFECTIVE_WINDOW);
    expect(budget.safetyMarginPct).toBe(2);
    expect(budget.maxOutputTokens).toBe(4_096);
    // tokenThreshold = (effectiveWindow - maxOutput - systemPromptTokens) * ratio
    // empty system prompt -> systemPromptTokens = 0
    expect(budget.tokenThreshold).toBe(Math.floor((EFFECTIVE_WINDOW - 4_096) * 0.75));
    // No model-metadata tail override → undefined; compressMessages derives
    // the tail from the budget at compression time.
    expect(budget.tailMessages).toBeUndefined();
  });

  test('output reserve is capped: a 128K declared max output does not eat the window', async () => {
    // codex gpt-5.6 shape: 372K window, 128K declared max output. Uncapped, the
    // reserve alone would take 34% of the window. It clamps to
    // OUTPUT_RESERVE_CAP_TOKENS (32K).
    mockGetEffectiveModel.mockResolvedValue({ providerId: 'codex', modelId: 'gpt-5.6-luna' });
    mockFindByProviderAndModelId.mockResolvedValue({
      provider: 'codex',
      modelId: 'gpt-5.6-luna',
      contextWindowTokens: 372_000,
      maxOutputTokens: 128_000,
      metadata: {},
    });
    mockResolveModelMetadata.mockResolvedValue({
      provider: 'codex',
      modelId: 'gpt-5.6-luna',
      metadata: {},
    });
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);
    const budget = await resolveContextBudget(agent, 'thread-1');
    const effectiveWindow = Math.floor(372_000 * 0.95); // codex margin 5%
    // Reserve clamps to 32K, not the declared 128K.
    expect(budget.usableBudget).toBe(effectiveWindow - 32_000);
    expect(budget.tokenThreshold).toBe(Math.floor((effectiveWindow - 32_000) * 0.75));
    // maxOutputTokens itself still reports the declared value for display.
    expect(budget.maxOutputTokens).toBe(128_000);
  });

  test('output reserve below the cap is used as-is', async () => {
    // 4_096 declared max output (default mock) is under the 32K cap — the
    // reserve must remain exactly 4_096, not get raised to the cap.
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);
    const budget = await resolveContextBudget(agent, 'thread-1');
    expect(budget.usableBudget).toBe(EFFECTIVE_WINDOW - 4_096);
  });

  test('metadata safetyMarginPct overrides the provider default', async () => {
    mockResolveModelMetadata.mockResolvedValue({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      safetyMarginPct: 25,
    });
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);
    const budget = await resolveContextBudget(agent, 'thread-1');
    expect(budget.safetyMarginPct).toBe(25);
    expect(budget.effectiveContextWindowTokens).toBe(Math.floor(128_000 * 0.75));
  });

  test('clamps a garbage safetyMarginPct rather than zeroing the budget', async () => {
    mockResolveModelMetadata.mockResolvedValue({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      safetyMarginPct: 250,
    });
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);
    const budget = await resolveContextBudget(agent, 'thread-1');
    expect(budget.safetyMarginPct).toBeLessThanOrEqual(90);
    expect(budget.usableBudget).toBeGreaterThan(0);
  });

  test('falls back to safe defaults when metadata is missing', async () => {
    mockResolveModelMetadata.mockResolvedValue({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      metadata: {},
    });
    const budget = await resolveContextBudget(baseAgent(), 'thread-1');
    expect(budget.contextWindowTokens).toBeGreaterThan(0);
    expect(budget.maxOutputTokens).toBeGreaterThan(0);
    expect(budget.tokenThreshold).toBeGreaterThan(0);
  });

  test('model metadata contextCompression.tailMessages populates the tail override', async () => {
    mockResolveModelMetadata.mockResolvedValue({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      contextCompression: { tailMessages: 7 },
    });
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);
    const budget = await resolveContextBudget(agent, 'thread-1');
    expect(budget.tailMessages).toBe(7);
  });

  test('model metadata contextCompression.tokenBudgetRatio still overrides the threshold', async () => {
    mockResolveModelMetadata.mockResolvedValue({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      contextCompression: { tokenBudgetRatio: 0.3 },
    });
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);
    const budget = await resolveContextBudget(agent, 'thread-1');
    expect(budget.tokenThreshold).toBe(Math.floor((Math.floor(128_000 * 0.98) - 4_096) * 0.3));
  });

  test('model metadata cacheTtl passes through; absent stays undefined', async () => {
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);
    // Absent → undefined; the runtime default ('1h' chat) is applied later in
    // prepareModelAttemptContext, not here.
    const noTtl = await resolveContextBudget(agent, 'thread-1');
    expect(noTtl.cacheTtl).toBeUndefined();

    mockResolveModelMetadata.mockResolvedValue({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      cacheTtl: '5m',
    });
    const withTtl = await resolveContextBudget(agent, 'thread-1');
    expect(withTtl.cacheTtl).toBe('5m');
  });

  test('clamps a garbage metadata tail override rather than throwing', async () => {
    mockResolveModelMetadata.mockResolvedValue({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      contextCompression: { tailMessages: 0 },
    });
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);
    const budget = await resolveContextBudget(agent, 'thread-1');
    expect(budget.tailMessages).toBeGreaterThanOrEqual(1);
  });

  // Overhead accounting: the budget subtracts the composed system prompt (not
  // just the persona field) and the advertised tool catalog, so compaction
  // fires before the real payload overflows.

  const toolRow = (id: string, description: string) =>
    ({
      id,
      name: id,
      description,
      parametersSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'A filesystem path' } },
        required: ['path'],
      },
    }) as unknown as ToolRow;

  test('subtracts the composed system prompt supplied by the caller', async () => {
    const composed = 'C'.repeat(35_000); // 10k tokens at anthropic's 3.5 chars/token
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);

    const bare = await resolveContextBudget(agent, 'thread-1');
    const withPrompt = await resolveContextBudget(agent, 'thread-1', {
      systemPromptText: composed,
    });

    expect(withPrompt.systemPromptTokens).toBe(10_000);
    expect(withPrompt.usableBudget).toBe(bare.usableBudget - 10_000);
    expect(withPrompt.tokenThreshold).toBeLessThan(bare.tokenThreshold);
  });

  test('subtracts the advertised tool catalog', async () => {
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);
    const tools = Array.from({ length: 40 }, (_, i) =>
      toolRow(`tool_${i}`, `Tool number ${i} — ${'d'.repeat(200)}`)
    );

    const bare = await resolveContextBudget(agent, 'thread-1');
    const withTools = await resolveContextBudget(agent, 'thread-1', { toolRows: tools });

    expect(bare.toolCatalogTokens).toBe(0);
    expect(withTools.toolCatalogTokens).toBeGreaterThan(1_000);
    expect(withTools.usableBudget).toBe(bare.usableBudget - withTools.toolCatalogTokens);
    expect(withTools.overheadTokens).toBe(withTools.toolCatalogTokens);
    // The whole point: the threshold that triggers compaction comes down.
    expect(withTools.tokenThreshold).toBeLessThan(bare.tokenThreshold);
  });

  test('composed prompt replaces agent.systemPrompt — no double counting', async () => {
    // The persona field is one block inside the composed prompt; adding both
    // would charge the agent twice for the same bytes.
    const persona = 'p'.repeat(3_500); // 1k tokens
    const composed = `${persona}${'x'.repeat(31_500)}`; // 10k tokens, persona included
    const agent = baseAgent({ systemPrompt: persona } as Partial<SnagletAgent>);

    const budget = await resolveContextBudget(agent, 'thread-1', { systemPromptText: composed });

    expect(budget.systemPromptTokens).toBe(10_000);
    expect(budget.overheadTokens).toBe(10_000);
  });

  test('falls back to agent.systemPrompt when no composed prompt is supplied', async () => {
    const persona = 'p'.repeat(3_500);
    const agent = baseAgent({ systemPrompt: persona } as Partial<SnagletAgent>);

    const budget = await resolveContextBudget(agent, 'thread-1');

    expect(budget.systemPromptTokens).toBe(1_000);
    expect(budget.toolCatalogTokens).toBe(0);
    expect(budget.overheadFloored).toBe(false);
  });

  test('overhead larger than the window floors the budget instead of wedging it', async () => {
    // A small-window model with a full tool catalog: overhead alone exceeds
    // the window. A 0 budget would mean a 1-token threshold — compaction on
    // every turn forever, folding the thread down to a single message.
    mockFindByProviderAndModelId.mockResolvedValue({
      provider: 'anthropic',
      modelId: 'tiny-model',
      contextWindowTokens: 8_000,
      maxOutputTokens: 4_000,
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const tools = Array.from({ length: 60 }, (_, i) =>
      toolRow(`tool_${i}`, `Tool number ${i} — ${'d'.repeat(400)}`)
    );

    const budget = await resolveContextBudget(baseAgent(), 'thread-1', {
      systemPromptText: 'S'.repeat(35_000),
      toolRows: tools,
    });

    expect(budget.overheadTokens).toBeGreaterThan(budget.effectiveContextWindowTokens);
    expect(budget.overheadFloored).toBe(true);
    expect(budget.usableBudget).toBeGreaterThanOrEqual(2_048);
    expect(budget.tokenThreshold).toBeGreaterThanOrEqual(1_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('prompt overhead does not fit'));
    warn.mockRestore();
  });

  test('the floor leaves a real tail where a zero budget would keep one message', () => {
    // The compact-forever shape: usableBudget 0 → threshold 1 → the derived
    // tail collapses to a single message on every turn. The floor is what
    // keeps a recent window alive on a model whose overhead ate the window.
    const msgs = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0
        ? userMsg(`turn-${i} ${'x'.repeat(400)}`)
        : assistantMsg(`reply-${i} ${'y'.repeat(400)}`)
    );

    const wedged: ContextBudget = {
      ...baseBudget,
      tailMessages: undefined,
      usableBudget: 0,
      tokenThreshold: 1,
    };
    expect(compressMessages(msgs, wedged, 'system prompt').keptCount).toBe(1);

    const floored: ContextBudget = {
      ...baseBudget,
      tailMessages: undefined,
      usableBudget: 2_048,
      tokenThreshold: Math.floor(2_048 * 0.6),
    };
    const result = compressMessages(msgs, floored, 'system prompt');
    expect(result.compressed).toBe(true);
    expect(result.keptCount).toBeGreaterThan(1);
  });

  test('clamps garbage metadata ratio rather than producing a broken threshold', async () => {
    mockResolveModelMetadata.mockResolvedValue({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      contextCompression: { tokenBudgetRatio: 5 },
    });
    const agent = baseAgent({ systemPrompt: '' } as Partial<SnagletAgent>);
    const budget = await resolveContextBudget(agent, 'thread-1');
    expect(budget.tokenThreshold).toBeLessThanOrEqual(128_000 - 4_096);
    expect(budget.tokenThreshold).toBeGreaterThan(0);
  });
});

describe('compressMessages', () => {
  const budget = baseBudget;

  test('no-op when below minMessagesBeforeCompression', () => {
    const msgs = [userMsg('a'), assistantMsg('b'), userMsg('c')];
    const result = compressMessages(msgs, budget, 'system prompt');
    expect(result.compressed).toBe(false);
    expect(result.messages).toHaveLength(3);
  });

  test('no-op when under token threshold even if many messages', () => {
    const msgs = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? userMsg(`u${i}`) : assistantMsg(`a${i}`)
    );
    const result = compressMessages(msgs, budget, 'system prompt');
    expect(result.compressed).toBe(false);
    expect(result.messages).toHaveLength(20);
  });

  test('compresses when over token threshold; keeps tail intact', () => {
    const tight = {
      ...budget,
      tokenThreshold: 50,
      tailMessages: 4,
      minMessagesBeforeCompression: 6,
    };
    const filler = 'x'.repeat(200); // ensure each message materially exceeds threshold/2
    const msgs = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? userMsg(`turn-${i} ${filler}`) : assistantMsg(`reply-${i} ${filler}`)
    );
    const result = compressMessages(msgs, tight, 'system prompt');
    expect(result.compressed).toBe(true);
    const tail = result.messages.slice(-tight.tailMessages);
    const originalTail = msgs.slice(-tight.tailMessages);
    expect(tail).toEqual(originalTail);
    expect(result.messages.length).toBeGreaterThanOrEqual(tight.tailMessages);
    expect(result.messages.length).toBeLessThan(msgs.length);
  });

  test('never splits a tool_use/tool_result pair at the compression boundary', () => {
    const tight = { ...budget, tokenThreshold: 10, tailMessages: 3 };
    const msgs = [
      ...Array.from({ length: 10 }, (_, i) => userMsg(`filler-${i}`)),
      toolUseMsg('call-1'),
      toolResultMsg('call-1'),
      assistantMsg('done'),
      userMsg('ok'),
    ];
    const result = compressMessages(msgs, tight, 'system prompt');
    expect(result.compressed).toBe(true);
    const toolUseIds = new Set<string>();
    const orphans: string[] = [];
    for (const m of result.messages) {
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block && typeof block === 'object' && 'type' in block) {
            const b = block as { type?: string; id?: string; tool_use_id?: string };
            if (b.type === 'tool_use') toolUseIds.add(b.id!);
            if (b.type === 'tool_result') {
              const id = b.tool_use_id!;
              if (!toolUseIds.has(id)) orphans.push(id);
            }
          }
        }
      }
    }
    expect(orphans).toEqual([]);
  });

  test('derives the tail from the budget when no metadata override', () => {
    // Huge usable budget + 60 small messages → derived tail hits the 50 cap.
    const derived = {
      ...budget,
      tailMessages: undefined,
      usableBudget: 1_000_000,
      tokenThreshold: 50,
      minMessagesBeforeCompression: 6,
    };
    const msgs = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? userMsg(`turn-${i} ${'x'.repeat(40)}`) : assistantMsg(`reply-${i}`)
    );
    const result = compressMessages(msgs, derived, 'system prompt');
    expect(result.compressed).toBe(true);
    expect(result.keptCount).toBe(50); // MAX_DERIVED_TAIL_MESSAGES cap
    expect(result.messages.slice(-50)).toEqual(msgs.slice(-50));
  });

  test('derived tail shrinks with a small budget (scales with model window)', () => {
    // Tiny usable budget → 40% of it fits only a few messages.
    const derived = {
      ...budget,
      tailMessages: undefined,
      usableBudget: 500,
      tokenThreshold: 50,
      minMessagesBeforeCompression: 6,
    };
    const filler = 'x'.repeat(200);
    const msgs = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? userMsg(`turn-${i} ${filler}`) : assistantMsg(`reply-${i} ${filler}`)
    );
    const result = compressMessages(msgs, derived, 'system prompt');
    expect(result.compressed).toBe(true);
    expect(result.keptCount).toBeGreaterThanOrEqual(1);
    expect(result.keptCount).toBeLessThan(10);
  });

  test('metadata tail override beats the derived value', () => {
    // Same huge budget as the derivation test, but tailMessages: 4 set —
    // the override must win over the derived 50.
    const overridden = {
      ...budget,
      tailMessages: 4,
      usableBudget: 1_000_000,
      tokenThreshold: 50,
    };
    const msgs = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? userMsg(`turn-${i} ${'x'.repeat(40)}`) : assistantMsg(`reply-${i}`)
    );
    const result = compressMessages(msgs, overridden, 'system prompt');
    expect(result.compressed).toBe(true);
    expect(result.keptCount).toBe(4);
  });

  test('stored summary is injected as the compaction prefix message[0]', () => {
    // The stored summary is not in the system prompt (which stays
    // byte-identical for the thread). When compression trims, the stored text
    // is injected here as messages[0], so it isn't lost.
    const tight = { ...budget, tokenThreshold: 50, tailMessages: 4 };
    const filler = 'x'.repeat(200);
    const msgs = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? userMsg(`turn-${i} ${filler}`) : assistantMsg(`reply-${i} ${filler}`)
    );
    const result = compressMessages(msgs, tight, 'system prompt', 'STORED-SUMMARY-BODY');
    expect(result.compressed).toBe(true);
    const first = result.messages[0]!;
    expect(first.role).toBe('user');
    expect(String(first.content)).toContain('STORED-SUMMARY-BODY');
    // Tail preserved after the summary prefix.
    expect(result.messages.slice(-4)).toEqual(msgs.slice(-4));
  });

  test('never-summarized threads still get the inline fallback digest', () => {
    const tight = { ...budget, tokenThreshold: 50, tailMessages: 4 };
    const filler = 'x'.repeat(200);
    const msgs = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? userMsg(`turn-${i} ${filler}`) : assistantMsg(`reply-${i} ${filler}`)
    );
    const result = compressMessages(msgs, tight, 'system prompt', null);
    expect(result.compressed).toBe(true);
    const first = result.messages[0]!;
    expect(first.role).toBe('user');
    expect(String(first.content)).toContain('[Historical context summary');
  });

  test('carries the roster + dispatch mode forward into the compaction summary', () => {
    // The thread_event rows that narrate roster/mode changes get folded away by
    // compression; the carry-forward line restates current state so it survives.
    const tight = { ...budget, tokenThreshold: 50, tailMessages: 4 };
    const filler = 'x'.repeat(200);
    const msgs = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? userMsg(`turn-${i} ${filler}`) : assistantMsg(`reply-${i} ${filler}`)
    );
    const carry = '[current roster: Nova, Vega · dispatch mode: mentioned]';

    // Stored-summary path carries it through.
    const stored = compressMessages(msgs, tight, 'system prompt', 'SUMMARY', undefined, carry);
    expect(String(stored.messages[0]!.content)).toContain(carry);

    // Synthesized-digest path carries it through too.
    const synth = compressMessages(msgs, tight, 'system prompt', null, undefined, carry);
    expect(String(synth.messages[0]!.content)).toContain(carry);
  });

  test('pins the active user request when tool history pushes it outside the tail', () => {
    const tight = { ...budget, tokenThreshold: 10, tailMessages: 2 };
    const msgs = [
      userMsg('older context'),
      assistantMsg('older reply'),
      userMsg('Tell me whether these tasks still need to be done'),
      toolUseMsg('call-1'),
      toolResultMsg('call-1'),
      toolUseMsg('call-2'),
      toolResultMsg('call-2'),
    ];

    const result = compressMessages(msgs, tight, 'system prompt');

    expect(result.compressed).toBe(true);
    expect(result.messages).toContainEqual({
      role: 'user',
      content:
        '[Active user request — answer this directly after completing any necessary tool calls]\n' +
        'Tell me whether these tasks still need to be done',
    });
  });

  test('active-request scan skips the ephemeral tail + thread_event lines', () => {
    // The always-last ephemeral turn-context tail and author-less thread_event
    // narration lines are role='user' too. If the scan didn't exclude them,
    // the tail would always win and the active-request reminder would never
    // fire. The scan reaches past both to the real human message and re-pins
    // it when it's summarized away.
    const tight = { ...budget, tokenThreshold: 10, tailMessages: 2 };
    const tail = `${TURN_CONTEXT_HEADER}\n\n**Your current coordinates:**\n- Location: \`/Snaglet\``;
    const eventLine = '[thread started · participants: Nova, Vega · mode: all]';
    const modelEventLine =
      '[participant model changed · Nova · from: anthropic/claude-sonnet-4-5 · to: openai/gpt-5]';
    const abortEventLine = '[Test User] aborted [Patty]';
    // A watched-changes narration line may still exist in stored threads;
    // misclassifying one would re-pin machine narration as the active human
    // request on every wake.
    const watchedChangesLine = '[watched changes · Nova · 12 unread since last turn]';
    const realRequest = 'Tell me whether these tasks still need to be done';
    const msgs = [
      userMsg('older context'),
      assistantMsg('older reply'),
      userMsg(realRequest),
      userMsg(eventLine), // thread_event narration replays as plain user text
      userMsg(modelEventLine),
      userMsg(abortEventLine),
      userMsg(watchedChangesLine),
      toolUseMsg('call-1'),
      toolResultMsg('call-1'),
      toolUseMsg('call-2'),
      toolResultMsg('call-2'),
      userMsg(tail), // ephemeral turn-context tail — always last
    ];

    const result = compressMessages(msgs, tight, 'system prompt');

    expect(result.compressed).toBe(true);
    // The real human request is re-pinned…
    expect(result.messages).toContainEqual({
      role: 'user',
      content:
        '[Active user request — answer this directly after completing any necessary tool calls]\n' +
        realRequest,
    });
    // …never the ephemeral tail or the event line.
    const reminders = result.messages.filter(
      (m) =>
        typeof m.content === 'string' &&
        m.content.startsWith('[Active user request — answer this directly')
    );
    expect(reminders).toHaveLength(1);
    expect(String(reminders[0]!.content)).not.toContain(TURN_CONTEXT_HEADER);
    expect(String(reminders[0]!.content)).not.toContain(eventLine);
    expect(String(reminders[0]!.content)).not.toContain(modelEventLine);
    expect(String(reminders[0]!.content)).not.toContain(watchedChangesLine);
  });

  test('every registered thread_event prefix is classified as narration, not conversation', () => {
    // Drives the whole exported registry rather than a hand-picked sample: an
    // event kind whose prefix is missing from THREAD_EVENT_LINE_PREFIX would be
    // treated as a real human turn, and compaction would re-pin it as the
    // "active user request" instead of folding it away.
    const tight = { ...budget, tokenThreshold: 10, tailMessages: 2 };
    const realRequest = 'Tell me whether these tasks still need to be done';
    const narrationLines = THREAD_EVENT_LINE_PREFIXES.map((prefix) => `${prefix} · details]`);
    const msgs = [
      userMsg('older context'),
      assistantMsg('older reply'),
      userMsg(realRequest),
      ...narrationLines.map((line) => userMsg(line)),
      toolUseMsg('call-1'),
      toolResultMsg('call-1'),
      toolUseMsg('call-2'),
      toolResultMsg('call-2'),
    ];

    const result = compressMessages(msgs, tight, 'system prompt');

    expect(result.compressed).toBe(true);
    const reminders = result.messages.filter(
      (m) =>
        typeof m.content === 'string' &&
        m.content.startsWith('[Active user request — answer this directly')
    );
    expect(reminders).toHaveLength(1);
    // The scan reached past every narration line to the real human message.
    expect(String(reminders[0]!.content)).toContain(realRequest);
    for (const line of narrationLines) {
      expect(String(reminders[0]!.content)).not.toContain(line);
    }
  });

  // Compaction boundary inside a tool cycle. Besides the window-split guard, a
  // `[tool_result, text]` fold must not count as a conversational user message:
  // re-pinned above the recent window, it would orphan its tool_result and the
  // provider would answer 400 `unexpected tool_use_id`. These tests assert no
  // orphan reaches the payload and the provider's last-mile pairing guard has
  // nothing to convert.

  test('reminder never re-pins a [tool_result, text] fold, so compaction emits no orphan (guard not hit)', () => {
    const tight = { ...budget, tokenThreshold: 10, tailMessages: 3 };
    const opener = 'Audit every open task across the board and report back';
    const foldedPeer = '@Nova can you take the DB migrations?';
    const msgs: ProviderMessage[] = [
      userMsg(opener) as ProviderMessage, // 0: the real human request (string)
      toolUseMsg('call-1') as ProviderMessage,
      toolResultWithText('call-1', foldedPeer), // [tool_result, text] fold (folded away)
      toolUseMsg('call-2') as ProviderMessage,
      toolResultMsg('call-2') as ProviderMessage,
      toolUseMsg('call-3') as ProviderMessage,
      toolResultMsg('call-3') as ProviderMessage,
      toolUseMsg('call-4') as ProviderMessage,
      toolResultMsg('call-4') as ProviderMessage,
    ];

    const result = compressMessages(msgs, tight, 'system prompt');
    expect(result.compressed).toBe(true);

    // The reminder is the string opener — never the folded tool_result turn.
    const reminders = result.messages.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith('[Active user request')
    );
    expect(reminders).toHaveLength(1);
    expect(String(reminders[0]!.content)).toContain(opener);
    expect(String(reminders[0]!.content)).not.toContain(foldedPeer);

    // Compaction output carries no orphaned tool_result.
    expect(collectOrphanToolResultIds(result.messages)).toEqual([]);

    // Acceptance: the last-mile provider guard is a no-op on this payload.
    const prep = prepareAnthropicApiMessages(result.messages);
    expect(prep.orphanedToolResults).toBe(0);
    expect(prep.orphanedToolUses).toBe(0);
  });

  test('soak: 45-iteration tool loop with periodic peer folds compacts repeatedly, never orphaning a cycle', () => {
    // Small budget → compaction fires on nearly every iteration, so the sliding
    // boundary sweeps across many tool cycles. Every 5th iteration folds a peer
    // message into the tool_result turn — the orphan-prone shape.
    const tight = {
      ...budget,
      tokenThreshold: 40,
      tailMessages: 4,
      minMessagesBeforeCompression: 6,
    };
    const bulk = 'y'.repeat(80);
    const agentMessages: ProviderMessage[] = [
      userMsg(
        'Kick off the long multi-step job and report when everything is done'
      ) as ProviderMessage,
    ];

    let compactions = 0;
    let guardHits = 0;

    for (let i = 0; i < 45; i++) {
      agentMessages.push(toolUseMsg(`call-${i}`) as ProviderMessage);
      agentMessages.push(
        i % 5 === 4
          ? toolResultWithText(`call-${i}`, `@peer note at iter ${i}`, `result-${i} ${bulk}`)
          : (toolResultMsg(`call-${i}`, `result-${i} ${bulk}`) as ProviderMessage)
      );

      const result = compressMessages(agentMessages, tight, 'system prompt');
      if (result.compressed) compactions++;

      // The compaction output itself must never contain an orphaned cycle…
      expect(collectOrphanToolResultIds(result.messages)).toEqual([]);

      // …and the provider's last-mile guard must never have to convert anything.
      const prep = prepareAnthropicApiMessages(result.messages);
      guardHits += prep.orphanedToolResults + prep.orphanedToolUses;
    }

    expect(compactions).toBeGreaterThan(20); // it really did compact, repeatedly
    expect(guardHits).toBe(0); // and never produced a single orphan across the run
  });
});

// Current-run protection: the turn path passes a boundary (the triggering
// inbound message), and compressMessages never compresses anything at or
// after it. Otherwise, on a small budget, a run's own iteration-1 tool
// exchange can fold into the summary and the agent repeats the same call.
describe('compressMessages current-run boundary', () => {
  // Floored small budget, no tail override (derived tail path), bulky old
  // history so the derived tail collapses to ~1 and the split guard then walks
  // it to 0 ("summary + 0 recent").
  const flooredBudget: ContextBudget = {
    ...baseBudget,
    tailMessages: undefined,
    usableBudget: 2_048,
    tokenThreshold: Math.floor(2_048 * 0.6),
  };
  const bulky = 'h'.repeat(3_000);
  const oldHistory: ProviderMessage[] = Array.from({ length: 8 }, (_, i) =>
    i % 2 === 0 ? userMsg(`old-turn-${i} ${bulky}`) : assistantMsg(`old-reply-${i} ${bulky}`)
  ) as ProviderMessage[];
  const trigger = userMsg('Please reconcile the board and report back');
  const ephemeralTail = {
    role: 'user' as const,
    content: `${TURN_CONTEXT_HEADER}\n\n**Your current coordinates:**\n- Location: \`/Snaglet\``,
    ephemeral: true,
  };
  const iter1ToolUse = toolUseMsg('run-call-1');
  const iter1ToolResult = toolResultMsg('run-call-1', `iteration-1 findings ${'r'.repeat(2_000)}`);
  /** Payload as buildPromptMessagesForIteration sees it at iteration 2. */
  const iteration2Payload = (): ProviderMessage[] =>
    [
      ...oldHistory,
      trigger,
      ephemeralTail,
      iter1ToolUse,
      iter1ToolResult,
    ] as unknown as ProviderMessage[];
  const boundaryAtTrigger = oldHistory.length; // index of the triggering message

  test('without a boundary: iteration-1 exchanges fold away (contrast case)', () => {
    const msgs = iteration2Payload();
    const result = compressMessages(msgs, flooredBudget, 'system prompt');
    expect(result.compressed).toBe(true);
    // The run's own iteration-1 exchange is gone from the payload: the model
    // cannot see what it just did.
    expect(result.messages).not.toContainEqual(iter1ToolUse);
    expect(result.messages).not.toContainEqual(iter1ToolResult);
  });

  test('with the boundary: iteration-1 exchanges survive verbatim while history compresses', () => {
    const msgs = iteration2Payload();
    const result = compressMessages(
      msgs,
      flooredBudget,
      'system prompt',
      null,
      undefined,
      undefined,
      undefined,
      boundaryAtTrigger
    );

    expect(result.compressed).toBe(true);
    // The current run — trigger, ephemeral tail, iteration-1 tool exchange —
    // is retained verbatim (same references, not copies), so the identical
    // tool call cannot recur for lack of seeing the first one.
    const protectedTail = msgs.slice(boundaryAtTrigger);
    expect(result.messages.slice(-protectedTail.length)).toEqual(protectedTail);
    for (const m of protectedTail) {
      expect(result.messages).toContain(m);
    }
    // Older history genuinely compressed into the summary prefix…
    expect(result.messages[0]!.role).toBe('user');
    expect(String(result.messages[0]!.content)).toContain('[Historical context summary');
    expect(result.messages).not.toContainEqual(oldHistory[0]);
    expect(result.messages.length).toBeLessThan(msgs.length);
    // …and the payload carries no orphaned tool cycle.
    expect(collectOrphanToolResultIds(result.messages)).toEqual([]);
    const prep = prepareAnthropicApiMessages(result.messages);
    expect(prep.orphanedToolResults).toBe(0);
    expect(prep.orphanedToolUses).toBe(0);
  });

  test('boundary grows with the run: later-iteration appends stay protected too', () => {
    // Same run, two more iterations appended after the captured boundary —
    // the boundary index is captured once and the array is append-only.
    const msgs = [
      ...iteration2Payload(),
      toolUseMsg('run-call-2'),
      toolResultMsg('run-call-2', `iteration-2 findings ${'s'.repeat(2_000)}`),
      userMsg('[mid-run correction] the second id was stale'),
      toolUseMsg('run-call-3'),
      toolResultMsg('run-call-3', 'iteration-3 findings'),
    ] as unknown as ProviderMessage[];
    const result = compressMessages(
      msgs,
      flooredBudget,
      'system prompt',
      null,
      undefined,
      undefined,
      undefined,
      boundaryAtTrigger
    );
    expect(result.compressed).toBe(true);
    const protectedTail = msgs.slice(boundaryAtTrigger);
    expect(result.messages.slice(-protectedTail.length)).toEqual(protectedTail);
    expect(collectOrphanToolResultIds(result.messages)).toEqual([]);
  });

  test('boundary 0: the whole thread is the current run — nothing folds, even over budget', () => {
    const msgs = iteration2Payload();
    const result = compressMessages(
      msgs,
      flooredBudget,
      'system prompt',
      null,
      undefined,
      undefined,
      undefined,
      0
    );
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(msgs); // the original array, untouched
    expect(result.keptCount).toBe(msgs.length);
  });

  test('boundary beyond the array end clamps to an empty protected tail and still compresses safely', () => {
    const msgs = iteration2Payload();
    const result = compressMessages(
      msgs,
      flooredBudget,
      'system prompt',
      null,
      undefined,
      undefined,
      undefined,
      msgs.length + 10
    );
    expect(result.compressed).toBe(true);
    expect(result.messages[0]!.role).toBe('user');
    expect(String(result.messages[0]!.content)).toContain('[Historical context summary');
    expect(collectOrphanToolResultIds(result.messages)).toEqual([]);
  });

  test('a boundary landing on a tool_result turn is pulled back — never an orphaned pair', () => {
    // Garbage caller input: the boundary points at the tool_result, so naive
    // protection would keep the result while its tool_use folds → provider 400.
    const msgs = [
      ...oldHistory,
      toolUseMsg('pair-1'),
      toolResultMsg('pair-1'),
      assistantMsg('done'),
      userMsg('ok'),
    ] as unknown as ProviderMessage[];
    const boundaryOnResult = oldHistory.length + 1; // the tool_result index
    const result = compressMessages(
      msgs,
      flooredBudget,
      'system prompt',
      null,
      undefined,
      undefined,
      undefined,
      boundaryOnResult
    );
    expect(result.compressed).toBe(true);
    expect(collectOrphanToolResultIds(result.messages)).toEqual([]);
    const prep = prepareAnthropicApiMessages(result.messages);
    expect(prep.orphanedToolResults).toBe(0);
    expect(prep.orphanedToolUses).toBe(0);
    // The pair traveled together into the kept window.
    expect(result.messages).toContainEqual(toolUseMsg('pair-1'));
    expect(result.messages).toContainEqual(toolResultMsg('pair-1'));
  });

  test('capacity honesty: warns loudly when the current run alone exceeds the usable budget', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const tiny: ContextBudget = { ...flooredBudget, usableBudget: 500, tokenThreshold: 300 };
      const msgs = iteration2Payload(); // protected tail alone estimates >> 500
      const result = compressMessages(
        msgs,
        tiny,
        'system prompt',
        null,
        undefined,
        undefined,
        undefined,
        boundaryAtTrigger
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('current run does not fit'));
      // Protection still holds — warn, never mangle.
      const protectedTail = msgs.slice(boundaryAtTrigger);
      expect(result.messages.slice(-protectedTail.length)).toEqual(protectedTail);
    } finally {
      warn.mockRestore();
    }
  });

  test('no capacity warning without a boundary (estimator and no-boundary paths stay silent)', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const tiny: ContextBudget = { ...flooredBudget, usableBudget: 500, tokenThreshold: 300 };
      compressMessages(iteration2Payload(), tiny, 'system prompt');
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('current run does not fit'));
    } finally {
      warn.mockRestore();
    }
  });

  test('no-boundary parity: an explicit undefined boundary is byte-identical to the 7-argument call', () => {
    // The 7-arg call and an explicit `undefined` 8th arg walk the exact same
    // path; the suite above pins the 7-arg behavior itself.
    const msgs = iteration2Payload();
    const legacy = compressMessages(
      msgs,
      flooredBudget,
      'system prompt',
      'STORED',
      undefined,
      '[carry]'
    );
    const explicit = compressMessages(
      msgs,
      flooredBudget,
      'system prompt',
      'STORED',
      undefined,
      '[carry]',
      undefined,
      undefined
    );
    expect(explicit).toEqual(legacy);
  });

  test('ephemeral-tail exclusion still holds with a boundary: the reminder never re-pins the tail', () => {
    // The tail sits inside the protected span here, and the latest genuine
    // conversational message (the trigger) does too — so no reminder at all,
    // and certainly never one built from the ephemeral tail.
    const msgs = iteration2Payload();
    const result = compressMessages(
      msgs,
      flooredBudget,
      'system prompt',
      null,
      undefined,
      undefined,
      undefined,
      boundaryAtTrigger
    );
    const reminders = result.messages.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith('[Active user request')
    );
    expect(reminders).toHaveLength(0);
    // The tail itself is still present, verbatim, exactly once.
    const tails = result.messages.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith(TURN_CONTEXT_HEADER)
    );
    expect(tails).toHaveLength(1);
  });
});

describe('findCurrentRunBoundary', () => {
  test('finds the start of the trailing plain-user run (trigger + narration + ephemeral tail)', () => {
    const msgs = [
      userMsg('old'),
      assistantMsg('old reply'),
      userMsg('the trigger'),
      userMsg('[thread started · participants: Nova · mode: all]'),
      { role: 'user' as const, content: 'tail', ephemeral: true },
    ] as unknown as ProviderMessage[];
    expect(findCurrentRunBoundary(msgs)).toBe(2);
  });

  test('a trailing assistant turn means no pending inbound — boundary is the array length', () => {
    const msgs = [userMsg('a'), assistantMsg('b')] as unknown as ProviderMessage[];
    expect(findCurrentRunBoundary(msgs)).toBe(2);
  });

  test('a trailing tool_result turn terminates the walk (prior-run history)', () => {
    const msgs = [
      userMsg('a'),
      toolUseMsg('c1'),
      toolResultMsg('c1'),
    ] as unknown as ProviderMessage[];
    expect(findCurrentRunBoundary(msgs)).toBe(3);
  });

  test('an all-user thread is entirely the current run (boundary 0); empty arrays too', () => {
    const msgs = [userMsg('only'), userMsg('turns')] as unknown as ProviderMessage[];
    expect(findCurrentRunBoundary(msgs)).toBe(0);
    expect(findCurrentRunBoundary([])).toBe(0);
  });

  // Replay renders another agent's message as relay-framed assistant text.
  const peerMsg = (content: string, withLegend = false) =>
    assistantMsg(
      `${withLegend ? `${RELAYED_LEGEND}\n` : ''}${RELAYED_OPEN}\n${content}\n${RELAYED_CLOSE}`
    );
  const tail = { role: 'user' as const, content: 'tail', ephemeral: true };

  test('a run started by a peer (a subagent brief) includes that message', () => {
    const msgs = [
      userMsg('[thread started · participants: test-agent-a · mode: all]'),
      peerMsg('Brief: update the parser and run its tests.', true),
      tail,
    ] as unknown as ProviderMessage[];
    expect(findCurrentRunBoundary(msgs)).toBe(1);
  });

  test('a peer @mention that woke the agent is the run trigger too', () => {
    const msgs = [
      userMsg('older question'),
      assistantMsg('own older reply'),
      peerMsg('@test-agent-a can you check the build?'),
      tail,
    ] as unknown as ProviderMessage[];
    expect(findCurrentRunBoundary(msgs)).toBe(2);
  });

  test('a human message after the peer message is the trigger; the peer message stays history', () => {
    const msgs = [
      peerMsg('an earlier teammate remark'),
      userMsg('Please summarize the thread'),
      tail,
    ] as unknown as ProviderMessage[];
    expect(findCurrentRunBoundary(msgs)).toBe(1);
  });

  test("the agent's own (unframed) reply is never pulled into the current run", () => {
    const msgs = [userMsg('a'), assistantMsg('own reply'), tail] as unknown as ProviderMessage[];
    expect(findCurrentRunBoundary(msgs)).toBe(2);
  });

  test('history compression keeps a peer brief verbatim under pressure', () => {
    const budget: ContextBudget = {
      ...baseBudget,
      tailMessages: undefined,
      usableBudget: 2_048,
      tokenThreshold: Math.floor(2_048 * 0.6),
    };
    const brief = peerMsg(`Brief: ${'b'.repeat(400)}`, true);
    const msgs = [
      ...Array.from({ length: 6 }, (_, i) =>
        i % 2 === 0 ? userMsg(`old ${'h'.repeat(3_000)}`) : assistantMsg(`old ${'h'.repeat(3_000)}`)
      ),
      brief,
      tail,
      toolUseMsg('call-1'),
      toolResultMsg('call-1', 'r'.repeat(2_000)),
    ] as unknown as ProviderMessage[];
    const boundary = findCurrentRunBoundary(msgs.slice(0, 8));
    expect(boundary).toBe(6);
    const result = compressMessages(
      msgs,
      budget,
      'system prompt',
      null,
      undefined,
      undefined,
      undefined,
      boundary
    );
    expect(result.compressed).toBe(true);
    expect(result.messages).toContain(brief);
  });
});
