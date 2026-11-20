/**
 * One advertised catalog per agent across every thread.
 *
 * The prompt cache is a strict prefix (tools → system → messages), so a
 * thread's tool-access override must not change the advertised tools or any
 * tool-gated system block. Drives the real `assembleAgentTurnContext` +
 * `prepareModelAttemptContext` + SystemPromptComposer; the access resolver stub
 * applies access to a fixed tool universe. Pins: system blocks and the tools
 * array are byte-identical across no override, a deny and an allow list; a
 * thread block is named once in the uncached turn-context tail (10 names +
 * "+N more", absent when nothing is blocked); blocked tools leave toolMap and
 * sit only in threadBlockedToolMap.
 */

const mockIsSemanticSearch = jest.fn(async () => true);

jest.mock('@server/services/SystemPromptComposer/blocks/toolCatalogBlock', () => {
  const actual = jest.requireActual(
    '@server/services/SystemPromptComposer/blocks/toolCatalogBlock'
  );
  return { __esModule: true, ...actual, isSemanticSearchAvailable: () => mockIsSemanticSearch() };
});

const mockAgent = {
  id: 'agent-self',
  name: 'Fixture Agent',
  role: 'test engineer',
  provider: 'anthropic',
  modelId: 'claude-test',
  credentialId: null,
  systemPrompt: '',
  rawSystemPrompt: null,
  toolAccessMode: 'all',
  toolAccessAllowList: [],
  toolAccessDenyList: [],
};

jest.mock('@server/services/AgentService', () => ({
  agentService: { get: async () => mockAgent },
}));
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { getEffectiveModel: async () => null, findById: async () => null },
}));
jest.mock('@snaglet/db/tables/models', () => ({
  Models: { findByProviderAndModelId: async () => null },
}));

/** Applies access to the fixed universe — the real resolver's semantics. */
const mockResolveSets = jest.fn();
jest.mock('@server/services/AgentToolResolver', () => ({
  resolveAdvertisedAgentToolSets: (...a: unknown[]) => mockResolveSets(...a),
  selectAdvertisedAgentTools: ({ allowedTools }: { allowedTools: unknown[] }) => allowedTools,
}));
jest.mock('@server/services/ContextWindowService', () => ({
  resolveContextBudget: async () => ({ maxInputTokens: 100_000, cacheTtl: '1h' }),
  findCurrentRunBoundary: (messages: unknown[]) => messages.length,
}));
jest.mock('@server/services/SummaryService', () => ({
  summaryService: { getThreadSummary: async () => null, getSummariesForThread: async () => [] },
}));
jest.mock('@server/services/settings', () => ({ settingsService: { read: async () => 12 } }));
jest.mock('@server/services/settings/categories/budget', () => ({ budgetSettings: {} }));
jest.mock('@server/services/settings/categories/tool', () => ({
  toolSettings: { maxIterations: {} },
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/replayLoader', () => ({
  buildReplayPayload: async () => ({
    messages: [{ role: 'user', content: 'hello' }],
    watermark: null,
  }),
}));
jest.mock('@server/services/summary/memoryRecallSegment', () => ({
  buildMemoryRecallSegment: async () => null,
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/buildPriorRunHint', () => ({
  buildPriorRunHint: async () => null,
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/makeCredentialResolver', () => ({
  makeCredentialResolver: () => async () => null,
}));
jest.mock('@server/services/SystemPromptComposer/expandPromptIncludes', () => ({
  expandPromptIncludes: async (s: string) => s,
}));
jest.mock('@server/services/SystemPromptComposer/resolveRunParams', () => ({
  resolveRunParams: async () => ({ host_path: '/snaglet/host', thread_title: 'Fixture' }),
}));
jest.mock('@server/services/ToolService/ToolFormatService', () => ({
  measureAnthropicToolCatalog: () => ({ toolCount: 0, serializedBytes: 0, estimatedTokens: 0 }),
}));
jest.mock('@server/services/SocketService/voiceSession/voiceSessionRegistry', () => ({
  isThreadVoiceActive: () => false,
}));
jest.mock('@server/services/vision/VisionThreadService', () => ({
  visionThreadService: { accessDeltaFor: () => null, accessCandidateFrom: () => null },
}));

import {
  assembleAgentTurnContext,
  prepareModelAttemptContext,
  composeThreadBlockedToolsLine,
} from '@server/services/SocketService/handlers/chatPhases/contextAssembly';
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { FULL_TOOLS, TABLE_TOOLS } from '../../SystemPromptComposer/composeFixtures';

const UNIVERSE: ResolvedAgentTool[] = [...FULL_TOOLS, ...TABLE_TOOLS];
const THREAD_ID = 'thread-access-1';

function applyAccess(access: ToolAccessConfig): ResolvedAgentTool[] {
  const deny = new Set(access.denyList ?? []);
  const allow = new Set(access.allowList ?? []);
  return UNIVERSE.filter((at) =>
    access.mode === 'allow_list' ? allow.has(at.tool.id) : !deny.has(at.tool.id)
  );
}

beforeEach(() => {
  mockResolveSets.mockReset();
  mockResolveSets.mockImplementation(async (_agentId: string, { access }) => {
    const allowedTools = applyAccess(access);
    return { allowedTools, executionTools: allowedTools, advertisedTools: allowedTools };
  });
});

async function turn(toolAccess?: ToolAccessConfig) {
  const agentOverrides = new Map(toolAccess ? [['agent-self', { toolAccess }]] : []);
  const deps = {
    session: { threadId: THREAD_ID },
    threadId: THREAD_ID,
    threadRuntimeConfig: { agentOverrides },
    isGroup: false,
    dispatchMode: 'all',
    participantAgentIds: ['agent-self'],
    agentNameMap: new Map([['agent-self', 'Fixture Agent']]),
    buildMentionContext: () => undefined,
  };
  const shared = {
    agentSoftThresholdNotified: new Set<string>(),
    agentDispatchCount: new Map<string, number>(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = await assembleAgentTurnContext({ deps, shared, replyAgentId: 'agent-self' } as any);
  if (ctx.status !== 'ready') throw new Error(`unexpected status ${ctx.status}`);
  const attempt = await prepareModelAttemptContext({
    deps,
    agent: ctx.agent,
    runtimeAgent: { ...ctx.runtimeAgentTemplate },
    agentTools: ctx.agentTools,
    executionTools: ctx.executionTools,
    advertisedTools: ctx.advertisedTools,
    threadBlockedTools: ctx.threadBlockedTools,
    toolAccess: ctx.toolAccess,
    turnContextData: ctx.turnContextData,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return { ctx, attempt };
}

const DENY_FILE: ToolAccessConfig = { mode: 'all', allowList: [], denyList: ['file'] };
const ALLOW_SEARCH: ToolAccessConfig = {
  mode: 'allow_list',
  allowList: ['workspace_search'],
  denyList: [],
};

describe('one advertised catalog per agent across threads', () => {
  test('keeps a top-level agent runtime trust flag', async () => {
    const prior = (mockAgent as { trustedToolCalls?: boolean }).trustedToolCalls;
    (mockAgent as { trustedToolCalls?: boolean }).trustedToolCalls = true;
    try {
      const { ctx } = await turn();
      expect(ctx.runtimeAgentTemplate.trustedToolCalls).toBe(true);
    } finally {
      (mockAgent as { trustedToolCalls?: boolean }).trustedToolCalls = prior;
    }
  });

  test('system blocks and the tools array are byte-identical across three thread setups', async () => {
    const setups = [await turn(), await turn(DENY_FILE), await turn(ALLOW_SEARCH)];
    const system = setups.map(({ ctx }) => JSON.stringify(ctx.systemBlocks));
    const tools = setups.map(({ attempt }) => JSON.stringify(attempt.toolRows));

    expect(system[1]).toBe(system[0]);
    expect(system[2]).toBe(system[0]);
    expect(tools[1]).toBe(tools[0]);
    expect(tools[2]).toBe(tools[0]);
    // The shared catalog is the agent's base catalog, not the narrowed one.
    expect(setups[0].attempt.toolRows.map((t) => t.id)).toContain('file');
  });

  test('reach still follows the thread: blocked tools leave toolMap, enter threadBlockedToolMap', async () => {
    const { attempt } = await turn(DENY_FILE);
    expect(attempt.toolMap.has('file')).toBe(false);
    expect(attempt.threadBlockedToolMap.get('file')?.tool.id).toBe('file');
    expect(attempt.toolMap.has('workspace_search')).toBe(true);
  });

  test('the blocked list rides the uncached tail only when the thread blocks something', async () => {
    const none = await turn();
    expect(none.ctx.threadBlockedTools).toEqual([]);
    expect(none.ctx.turnContextData).not.toContain('Not allowed in this thread');

    const denied = await turn(DENY_FILE);
    expect(denied.ctx.turnContextData).toContain(
      'Not allowed in this thread (thread tool access): `file`.'
    );
    expect(JSON.stringify(denied.ctx.systemBlocks)).not.toContain('Not allowed in this thread');
  });
});

describe('tool-discovery reminder in the turn-context tail', () => {
  // Agents deep in a conversation stop attending to the top of the prompt, so
  // the search-before-you-say-no rule is repeated once per turn in the
  // uncached tail, after the whole history.
  const REMINDER =
    "Tools: your list is not everything you can do. Before you say you can't do something or that a tool is missing, search: `tool({op: 'search', query})`.";

  test('rides the uncached tail on every turn, never the cached system blocks', async () => {
    for (const setup of [undefined, DENY_FILE, ALLOW_SEARCH]) {
      const { ctx } = await turn(setup);
      expect(ctx.turnContextData).toContain(REMINDER);
      expect(JSON.stringify(ctx.systemBlocks)).not.toContain(REMINDER);
    }
  });
});

describe('composeThreadBlockedToolsLine', () => {
  test('null when nothing is blocked', () => {
    expect(composeThreadBlockedToolsLine([])).toBeNull();
  });

  test('caps at 10 names and counts the rest', () => {
    const ids = Array.from({ length: 13 }, (_, i) => `t${i}`);
    const line = composeThreadBlockedToolsLine(ids)!;
    expect(line).toContain('`t9`');
    expect(line).not.toContain('`t10`');
    expect(line.endsWith(' +3 more.')).toBe(true);
    expect(line.split('\n')).toHaveLength(1);
  });
});
