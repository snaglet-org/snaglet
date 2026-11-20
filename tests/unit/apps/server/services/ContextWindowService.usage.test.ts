/**
 * estimateThreadUsage — the number behind the UI's context-usage bar. It
 * counts the composed system prompt, the tool catalog, and tool calls and
 * results replayed from the activity log (never stored as messages), not just
 * user/assistant message rows; on an agent-heavy thread the rows alone are a
 * small fraction of the real payload.
 *
 * Every collaborator here is a DB or assembly boundary; the token math,
 * budget resolution, and compression pass are real.
 */

const mockFindThreadById = jest.fn();
const mockGetEffectiveModel = jest.fn();
const mockFindModel = jest.fn();
const mockResolveModelMetadata = jest.fn();
const mockAgentGet = jest.fn();
const mockListParticipants = jest.fn();
const mockThreadRuntimeConfig = jest.fn();
const mockAdvertisedToolSets = jest.fn();
const mockComposeSystemPrompt = jest.fn();
const mockBuildReplayPayload = jest.fn();
const mockGetThreadSummary = jest.fn();
const mockGetSummaryByThreadAndAgent = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    findById: (...a: unknown[]) => mockFindThreadById(...a),
    getEffectiveModel: (...a: unknown[]) => mockGetEffectiveModel(...a),
  },
}));
jest.mock('@snaglet/db/tables/models', () => ({
  Models: { findByProviderAndModelId: (...a: unknown[]) => mockFindModel(...a) },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByThread: (...a: unknown[]) => mockListParticipants(...a) },
}));
jest.mock('@snaglet/db/tables/thread_summaries', () => ({
  ThreadSummaries: {
    getByThreadAndAgent: (...a: unknown[]) => mockGetSummaryByThreadAndAgent(...a),
  },
}));
jest.mock('@server/services/metadataResolver.js', () => ({
  resolveModelMetadata: (...a: unknown[]) => mockResolveModelMetadata(...a),
}));
jest.mock('@server/services/AgentService', () => ({
  agentService: { get: (...a: unknown[]) => mockAgentGet(...a) },
}));
jest.mock('@server/services/ConfigResolverService', () => ({
  resolveThreadRuntimeConfig: (...a: unknown[]) => mockThreadRuntimeConfig(...a),
}));
jest.mock('@server/services/AgentToolResolver', () => ({
  resolveAdvertisedAgentToolSets: (...a: unknown[]) => mockAdvertisedToolSets(...a),
}));
jest.mock('@server/services/SystemPromptComposer', () => ({
  composeSystemPrompt: (...a: unknown[]) => mockComposeSystemPrompt(...a),
}));
jest.mock('@server/services/SystemPromptComposer/resolveRunParams', () => ({
  resolveRunParams: async () => ({}),
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/replayLoader', () => ({
  buildReplayPayload: (...a: unknown[]) => mockBuildReplayPayload(...a),
}));
jest.mock('@server/services/SummaryService', () => ({
  summaryService: { getThreadSummary: (...a: unknown[]) => mockGetThreadSummary(...a) },
}));

import * as compression from '@server/services/contextWindow/compression';
import { estimateThreadUsage } from '@server/services/ContextWindowService';
import { estimateSessionTokens } from '@server/services/TokenEstimator';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';

const THREAD_ID = 'thread-usage-1';
const AGENT_ID = 'agent-usage-1';

/** ~5.7k tokens of composed system prompt — workspace context, tool guidance, memory. */
const COMPOSED_SYSTEM_PROMPT = `# Identity\nYou are a test agent.\n${'Operating context. '.repeat(1_000)}`;

const toolRow = (id: string) => ({
  id,
  name: id,
  description: `Tool ${id} — ${'does a thing. '.repeat(20)}`,
  parametersSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace path' },
      body: { type: 'string', description: 'Payload body' },
    },
    required: ['path'],
  },
});

/**
 * A realistic agent-heavy replay: a few plain turns, then many tool cycles.
 * Only the plain string turns are `messages` rows — everything else is
 * replayed from `agent_activity_log`.
 */
function replayFixture(): ProviderMessage[] {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'Audit the workspace and report what needs attention' },
    { role: 'assistant', content: 'On it.' },
  ];
  for (let i = 0; i < 12; i++) {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: `call-${i}`, name: 'read_doc', input: { path: `/docs/${i}.md` } },
      ],
    } as unknown as ProviderMessage);
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `call-${i}`,
          content: `file body ${'x'.repeat(2_000)}`,
        },
      ],
    } as unknown as ProviderMessage);
  }
  messages.push({ role: 'assistant', content: 'Here is the audit.' });
  return messages;
}

/** A rows-only count: string user/assistant rows, no system prompt. */
function legacyMessageOnlyEstimate(messages: ProviderMessage[]): number {
  const rows = messages.filter((m) => typeof m.content === 'string');
  return estimateSessionTokens(rows, '', 'anthropic', 'claude-sonnet-4-5');
}

beforeEach(() => {
  jest.clearAllMocks();

  mockFindThreadById.mockResolvedValue({ id: THREAD_ID, dispatchMode: 'mentioned' });
  mockGetEffectiveModel.mockResolvedValue({
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-5',
  });
  mockFindModel.mockResolvedValue({
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_000,
    supportsTools: true,
  });
  mockResolveModelMetadata.mockResolvedValue({});
  mockAgentGet.mockResolvedValue({
    id: AGENT_ID,
    name: 'Test Agent',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    // The persona field: a tiny fraction of what actually ships.
    systemPrompt: 'You are a test agent.',
    configJson: {},
  });
  mockListParticipants.mockResolvedValue([{ agentId: AGENT_ID }]);
  mockThreadRuntimeConfig.mockResolvedValue({ agentOverrides: new Map(), dispatch: {} });
  mockAdvertisedToolSets.mockResolvedValue({
    allowedTools: [],
    executionTools: [],
    advertisedTools: Array.from({ length: 30 }, (_, i) => ({ tool: toolRow(`tool_${i}`) })),
  });
  mockComposeSystemPrompt.mockResolvedValue([{ type: 'text', text: COMPOSED_SYSTEM_PROMPT }]);
  mockBuildReplayPayload.mockResolvedValue({ messages: replayFixture(), watermark: null });
  mockGetThreadSummary.mockResolvedValue(null);
  mockGetSummaryByThreadAndAgent.mockResolvedValue(null);
});

describe('estimateThreadUsage', () => {
  test('counts tool activity and the composed system prompt, not just message rows', async () => {
    const result = await estimateThreadUsage(THREAD_ID, AGENT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { tokens } = result.usage;

    const legacy = legacyMessageOnlyEstimate(replayFixture());

    // A rows-only count is a rounding error next to the real payload.
    expect(legacy).toBeLessThan(200);
    expect(tokens.estimated).toBeGreaterThan(legacy * 20);

    // Each part is genuinely present.
    expect(tokens.systemPromptTokens).toBeGreaterThan(4_000);
    expect(tokens.toolCatalogTokens).toBeGreaterThan(1_000);
    expect(tokens.toolCount).toBe(30);
    // Tool results are the bulk of an agent-heavy thread.
    expect(tokens.messageTokens).toBeGreaterThan(6_000);
    expect(tokens.messagesCounted).toBe(replayFixture().length);
  });

  test('composes a DM / home thread with its own variant, as the turn path does', async () => {
    mockFindThreadById.mockResolvedValue({ id: THREAD_ID, dispatchMode: 'mentioned', kind: 'dm' });
    await estimateThreadUsage(THREAD_ID, AGENT_ID);
    expect(mockComposeSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ isDm: true, isGroup: false })
    );

    mockComposeSystemPrompt.mockClear();
    mockFindThreadById.mockResolvedValue({
      id: THREAD_ID,
      dispatchMode: 'mentioned',
      kind: 'chat',
    });
    await estimateThreadUsage(THREAD_ID, AGENT_ID);
    expect(mockComposeSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({ isDm: false }));
  });

  test('does not put the thread digest in the estimate, as the turn path does not', async () => {
    mockGetThreadSummary.mockResolvedValue({
      summaryText: 'We chose option A.',
      messagesCovered: 12,
      modelUsed: 'test-provider/test-model',
    });
    const spy = jest.spyOn(compression, 'compressMessages');
    try {
      await estimateThreadUsage(THREAD_ID, AGENT_ID);
      expect(spy.mock.calls[0]?.[3]).toBeNull();
      expect(mockGetThreadSummary).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('the post-Compact estimate measures the stored summary in its labeled form', async () => {
    mockGetThreadSummary.mockResolvedValue({
      summaryText: 'We chose option A.',
      messagesCovered: 12,
      modelUsed: 'test-provider/test-model',
    });
    const spy = jest.spyOn(compression, 'compressMessages');
    try {
      await estimateThreadUsage(THREAD_ID, AGENT_ID, { applySummaryUnconditionally: true });
      const summaryArg = spy.mock.calls[0]?.[3];
      expect(summaryArg).toContain('Generated by test-provider/test-model; covers 12 messages.');
      expect(summaryArg).toContain('lossy');
      expect(summaryArg).toContain('We chose option A.');
    } finally {
      spy.mockRestore();
    }
  });

  test('the reported breakdown sums to the reported total', async () => {
    const result = await estimateThreadUsage(THREAD_ID, AGENT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { tokens } = result.usage;

    expect(tokens.systemPromptTokens + tokens.toolCatalogTokens + tokens.messageTokens).toBe(
      tokens.estimated
    );
    expect(tokens.raw).toBeGreaterThanOrEqual(tokens.estimated);
  });

  test('the budget it reports has the same overhead removed', async () => {
    const result = await estimateThreadUsage(THREAD_ID, AGENT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { budget, tokens } = result.usage;

    // effective window (2% anthropic margin) − output reserve − overhead
    const effectiveWindow = Math.floor(200_000 * 0.98);
    expect(budget.usableBudget).toBe(
      effectiveWindow - 32_000 - tokens.systemPromptTokens - tokens.toolCatalogTokens
    );
    expect(budget.overheadFloored).toBe(false);
    // percentOfUsable measures messages against the message budget — counting
    // the overhead there would charge it twice.
    expect(result.usage.percentOfUsable).toBeCloseTo(
      (tokens.messageTokens / budget.usableBudget) * 100,
      6
    );
  });

  test('a tool-less model reports no catalog cost', async () => {
    mockFindModel.mockResolvedValue({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
      supportsTools: false,
    });
    mockAdvertisedToolSets.mockResolvedValue({
      allowedTools: [],
      executionTools: [],
      advertisedTools: [],
    });

    const result = await estimateThreadUsage(THREAD_ID, AGENT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mockAdvertisedToolSets).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ modelSupportsTools: false })
    );
    expect(result.usage.tokens.toolCatalogTokens).toBe(0);
    expect(result.usage.tokens.toolCount).toBe(0);
  });

  test("prices the agent's base catalog even when the thread overrides tool access", async () => {
    // The turn path advertises from base access in every thread; the estimator
    // must select identically or the meter disagrees with the wire.
    mockThreadRuntimeConfig.mockResolvedValue({
      agentOverrides: new Map([
        [AGENT_ID, { toolAccess: { mode: 'allow_list', allowList: ['tool_0'], denyList: [] } }],
      ]),
      dispatch: {},
    });

    const result = await estimateThreadUsage(THREAD_ID, AGENT_ID);
    expect(result.ok).toBe(true);
    expect(mockAdvertisedToolSets).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ access: { mode: 'all', allowList: [], denyList: [] } })
    );
  });

  test('missing thread and missing agent stay distinguishable', async () => {
    mockFindThreadById.mockResolvedValue(null);
    await expect(estimateThreadUsage(THREAD_ID, AGENT_ID)).resolves.toEqual({
      ok: false,
      reason: 'thread_not_found',
    });

    mockFindThreadById.mockResolvedValue({ id: THREAD_ID, dispatchMode: 'mentioned' });
    mockAgentGet.mockResolvedValue(null);
    await expect(estimateThreadUsage(THREAD_ID, AGENT_ID)).resolves.toEqual({
      ok: false,
      reason: 'agent_not_found',
    });
  });
});
