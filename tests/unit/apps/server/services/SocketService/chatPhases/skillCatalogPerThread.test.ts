/**
 * The skill catalog varies per thread, the tool list does not.
 *
 * Drives the real assembleAgentTurnContext + prepareModelAttemptContext with
 * the real SystemPromptComposer (same harness as threadToolAccessCatalog):
 *   - one agent with skills, two threads with different effective sets →
 *     toolRows byte-identical; system blocks differ only in the skill block
 *   - the skill block sits after the core and before the thread prompt, and
 *     the single system breakpoint stays on the last block
 *   - a thread whose access blocks `skill` gets no catalog (tools unchanged)
 *   - an agent without `skill` advertised gets no catalog at all
 */

import type { ToolAccessConfig } from '@snaglet/shared/types';

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
  SKILL_TOOL_ID: 'skill',
}));

/** Per-thread effective skill sets; the real renderer/block run unmocked. */
const mockSkillsByThread = new Map<string, Array<{ slug: string; description: string }>>();
jest.mock('@server/services/skills/skillCatalog', () => {
  const actual = jest.requireActual('@server/services/skills/skillCatalog');
  return {
    __esModule: true,
    ...actual,
    loadSkillCatalogEntries: async (_agentId: string, threadId: string) =>
      mockSkillsByThread.get(threadId) ?? [],
  };
});
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
} from '@server/services/SocketService/handlers/chatPhases/contextAssembly';
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';
import { SKILL_CATALOG_HEADER } from '@server/services/skills/skillCatalog';
import { FULL_TOOLS, makeTool } from '../../SystemPromptComposer/composeFixtures';

const SKILL_TOOL = makeTool({ id: 'skill', name: 'Skill', categoryPath: 'skills', tier: 'core' });
let advertised: ResolvedAgentTool[] = [];

beforeEach(() => {
  mockSkillsByThread.clear();
  mockSkillsByThread.set('thread-a', [{ slug: 'release', description: 'Cut a release.' }]);
  mockSkillsByThread.set('thread-b', [
    { slug: 'triage', description: 'Triage a bug.' },
    { slug: 'release', description: 'Cut a release.' },
  ]);
  advertised = [...FULL_TOOLS, SKILL_TOOL];
  mockResolveSets.mockReset();
  // Agent-keyed: the same sets whatever the thread, except that an access
  // config denying a tool drops it from the allowed/execution sets (the real
  // resolver's semantics for a thread's tool-access override).
  mockResolveSets.mockImplementation(
    async (_agentId: string, opts: { access: { denyList?: string[] } }) => {
      const deny = new Set(opts.access.denyList ?? []);
      const reachable = advertised.filter((at) => !deny.has(at.tool.id));
      return { allowedTools: reachable, executionTools: reachable, advertisedTools: reachable };
    }
  );
});

async function turn(threadId: string, threadPrompt?: string, toolAccess?: ToolAccessConfig) {
  const agentOverrides = new Map(toolAccess ? [['agent-self', { toolAccess }]] : []);
  const deps = {
    session: { threadId },
    threadId,
    threadRuntimeConfig: { agentOverrides, systemPrompt: threadPrompt },
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

type Block = { text: string; cache_control?: unknown };
const isSkillBlock = (b: Block) => b.text.startsWith(SKILL_CATALOG_HEADER);

describe('skill catalog varies per thread, the tool list does not', () => {
  test('two threads, different effective sets: toolRows identical, system differs only in the skill block', async () => {
    const a = await turn('thread-a');
    const b = await turn('thread-b');

    expect(JSON.stringify(b.attempt.toolRows)).toBe(JSON.stringify(a.attempt.toolRows));
    expect(a.attempt.toolRows.map((t: { id: string }) => t.id)).toContain('skill');

    const sa = a.ctx.systemBlocks as Block[];
    const sb = b.ctx.systemBlocks as Block[];
    expect(sb).toHaveLength(sa.length);
    const differing = sa.map((blk, i) => i).filter((i) => sa[i]!.text !== sb[i]!.text);
    expect(differing).toHaveLength(1);
    expect(isSkillBlock(sa[differing[0]!]!)).toBe(true);
    expect(sa[differing[0]!]!.text).not.toContain('triage');
    expect(sb[differing[0]!]!.text).toContain('`triage` — Triage a bug.');
    // Core prefix (everything before the skill block) is byte-identical.
    expect(JSON.stringify(sb.slice(0, differing[0]))).toBe(
      JSON.stringify(sa.slice(0, differing[0]))
    );
  });

  test('order: core, then skills, then the thread prompt last; one breakpoint on the last block', async () => {
    const { ctx } = await turn('thread-a', 'Be terse.');
    const blocks = ctx.systemBlocks as Block[];
    const skillIdx = blocks.findIndex(isSkillBlock);
    expect(skillIdx).toBe(blocks.length - 2);
    expect(blocks[blocks.length - 1]!.text).toContain('Be terse.');
    expect(blocks.filter((blk) => blk.cache_control)).toHaveLength(1);
    expect(blocks[blocks.length - 1]!.cache_control).toBeDefined();

    const noPrompt = (await turn('thread-a')).ctx.systemBlocks as Block[];
    expect(isSkillBlock(noPrompt[noPrompt.length - 1]!)).toBe(true);
    expect(noPrompt[noPrompt.length - 1]!.cache_control).toBeDefined();
  });

  test('a thread with no effective skills renders no skill block, tools unchanged', async () => {
    mockSkillsByThread.set('thread-c', []);
    const a = await turn('thread-a');
    const c = await turn('thread-c');
    expect((c.ctx.systemBlocks as Block[]).some(isSkillBlock)).toBe(false);
    expect(JSON.stringify(c.attempt.toolRows)).toBe(JSON.stringify(a.attempt.toolRows));
  });

  test('a thread whose access blocks `skill`: no skill block, toolRows still byte-identical', async () => {
    const a = await turn('thread-a');
    const blocked = await turn('thread-b', undefined, {
      mode: 'all',
      allowList: [],
      denyList: ['skill'],
    });
    // thread-b has effective skills, but `skill` is not callable here.
    expect((blocked.ctx.systemBlocks as Block[]).some(isSkillBlock)).toBe(false);
    expect(JSON.stringify(blocked.attempt.toolRows)).toBe(JSON.stringify(a.attempt.toolRows));
    expect(blocked.attempt.toolRows.map((t: { id: string }) => t.id)).toContain('skill');
  });

  test('agent without `skill` advertised: no catalog even if a lookup would return skills', async () => {
    advertised = [...FULL_TOOLS];
    const { ctx, attempt } = await turn('thread-b');
    expect((ctx.systemBlocks as Block[]).some(isSkillBlock)).toBe(false);
    expect(attempt.toolRows.map((t: { id: string }) => t.id)).not.toContain('skill');
  });
});
