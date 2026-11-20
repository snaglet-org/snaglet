/**
 * Provider-boundary coverage for vision access context. Drives the real
 * `prepareModelAttemptContext` and inspects `agentMessages`, the array that
 * becomes the provider request: the vision text rides inside the
 * TURN_CONTEXT sentinel block, no standalone user-role <vision_access>
 * message exists, tool availability reflects this agent's routable tools, and
 * a model fallback does not stack duplicate segments. Only DB-bound
 * collaborators are mocked.
 */

const accessDeltaForMock = jest.fn();

jest.mock('@server/services/vision/VisionThreadService', () => ({
  visionThreadService: {
    accessDeltaFor: (...args: unknown[]) => accessDeltaForMock(...args),
    accessCandidateFrom: (delta: { version: number; current: unknown }) => ({
      version: delta.version,
      source: delta.current,
    }),
  },
}));
jest.mock('@snaglet/db/tables/threads', () => ({ Threads: { findById: jest.fn() } }));
jest.mock('@snaglet/db/tables/models', () => ({ Models: { findByProviderAndModelId: jest.fn() } }));
jest.mock('@server/services/AgentToolResolver', () => ({
  resolveAgentTools: jest.fn(),
  resolveAgentToolsForExecution: jest.fn(),
  selectAdvertisedAgentTools: () => [],
}));
jest.mock('@server/services/ContextWindowService', () => ({
  resolveContextBudget: async () => ({ maxInputTokens: 100_000, cacheTtl: '1h' }),
  // Stub: this suite inspects agentMessages only, never the boundary. The real
  // walk is covered by ContextWindowService.test.ts (findCurrentRunBoundary).
  findCurrentRunBoundary: (messages: unknown[]) => messages.length,
}));
jest.mock('@server/services/SummaryService', () => ({
  summaryService: { getThreadSummary: async () => null },
}));
jest.mock('@server/services/settings', () => ({
  settingsService: { read: async () => 12 },
}));
jest.mock('@server/services/settings/categories/budget', () => ({ budgetSettings: {} }));
jest.mock('@server/services/settings/categories/tool', () => ({
  toolSettings: { maxIterations: {} },
}));
jest.mock(
  '@server/services/SocketService/handlers/chatPhases/replayLoader',
  () => ({
    buildReplayPayload: async () => ({
      messages: [{ role: 'user', content: 'what is on my screen?' }],
      watermark: null,
    }),
  }),
  { virtual: false }
);
jest.mock('@server/services/SocketService/handlers/chatPhases/buildPriorRunHint', () => ({
  buildPriorRunHint: async () => null,
}));
jest.mock('@server/services/SystemPromptComposer/expandPromptIncludes', () => ({
  expandPromptIncludes: async (s: string) => s,
}));
jest.mock('@server/services/ToolService/ToolFormatService', () => ({
  measureAnthropicToolCatalog: () => ({ toolCount: 0, serializedBytes: 0, estimatedTokens: 0 }),
}));
jest.mock('@server/services/SocketService/voiceSession/voiceSessionRegistry', () => ({
  isThreadVoiceActive: () => false,
}));

import { prepareModelAttemptContext } from '@server/services/SocketService/handlers/chatPhases/contextAssembly';
import { TURN_CONTEXT_SENTINEL } from '@server/services/SystemPromptComposer/composeTurnContextTail';

const THREAD_ID = 'thread-vision-1';
const AGENT_ID = 'agent-vision-1';

function resolvedTool(id: string) {
  return { tool: { id, name: id, aliases: [] } };
}

async function attempt(routableToolIds: string[]) {
  const executionTools = routableToolIds.map(resolvedTool);
  const ctx = await prepareModelAttemptContext({
    deps: {
      session: { threadId: THREAD_ID },
      threadId: THREAD_ID,
      participantAgentIds: [AGENT_ID],
      agentNameMap: new Map([[AGENT_ID, 'Vision Agent']]),
      dispatchMode: 'direct',
    },
    agent: { id: AGENT_ID, name: 'Vision Agent' },
    runtimeAgent: { id: AGENT_ID, name: 'Vision Agent' },
    agentTools: executionTools,
    executionTools,
    toolAccess: { mode: 'all', allowList: null, denyList: null },
    turnContextData: '**Your current coordinates:**\n- Thread: `demo`',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return ctx;
}

async function payload(routableToolIds: string[]) {
  const ctx = await attempt(routableToolIds);
  return ctx.agentMessages as Array<{ role: string; content: unknown }>;
}

const textOf = (m: { content: unknown }) => (typeof m.content === 'string' ? m.content : '');

describe('vision access at the provider boundary', () => {
  beforeEach(() => {
    accessDeltaForMock.mockReset();
    accessDeltaForMock.mockReturnValue({
      version: 1,
      transition: { kind: 'enabled', source: 'screen', priorSource: null },
      current: 'screen',
    });
  });

  it('places vision text inside the turn-context sentinel block', async () => {
    const messages = await payload(['capture_user_screen']);

    const tail = messages.filter((m) => textOf(m).startsWith(TURN_CONTEXT_SENTINEL));
    expect(tail).toHaveLength(1);
    expect(textOf(tail[0])).toContain('Vision access');
    expect(textOf(tail[0])).toContain('capture_user_screen');
  });

  it('emits no standalone user-role <vision_access> message', async () => {
    const messages = await payload(['capture_user_screen']);

    // A separate role:'user' message would match no sentinel, so downstream
    // classification would count it as a human turn. Nothing outside the
    // sentinel block may mention vision access.
    for (const message of messages) {
      const text = textOf(message);
      expect(text).not.toContain('<vision_access');
      if (!text.startsWith(TURN_CONTEXT_SENTINEL)) {
        expect(text).not.toContain('Vision access');
      }
    }
  });

  it('reflects this agent’s actual routable tools, not a catalog default', async () => {
    // Granted screen, but this agent cannot route the screen capture tool.
    const withoutTool = await payload(['search', 'file_read']);
    const tailText = textOf(withoutTool.find((m) => textOf(m).startsWith(TURN_CONTEXT_SENTINEL))!);

    expect(tailText).toContain('No capture tool for screen is available to you');
    expect(tailText).not.toContain('Call `capture_user_screen`');

    // Same grant, agent that can route it.
    const withTool = await payload(['capture_user_screen']);
    const withToolText = textOf(withTool.find((m) => textOf(m).startsWith(TURN_CONTEXT_SENTINEL))!);
    expect(withToolText).toContain('capture_user_screen');
  });

  it('does not duplicate the segment when a fallback re-runs assembly', async () => {
    // Each model attempt builds its own payload; none of them may contain the
    // block twice, and successive attempts must be byte-identical.
    const first = await payload(['capture_user_screen']);
    const second = await payload(['capture_user_screen']);

    for (const messages of [first, second]) {
      const tail = messages.filter((m) => textOf(m).startsWith(TURN_CONTEXT_SENTINEL));
      expect(tail).toHaveLength(1);
      const occurrences = textOf(tail[0]).split('**Vision access**').length - 1;
      expect(occurrences).toBe(1);
    }
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('carries the attempt’s candidate out, without acknowledging anything', async () => {
    const ctx = await attempt(['capture_user_screen']);

    // Assembly hands the snapshot to its caller; only a successful provider
    // result may confirm it, so nothing here constitutes perception.
    expect(ctx.visionAccessCandidate).toEqual({ version: 1, source: 'screen' });
  });

  it('carries no candidate when there is no vision delta', async () => {
    accessDeltaForMock.mockReturnValue(null);

    const ctx = await attempt(['capture_user_screen']);

    expect(ctx.visionAccessCandidate).toBeNull();
    for (const message of ctx.agentMessages as Array<{ content: unknown }>) {
      expect(textOf(message)).not.toContain('Vision access');
    }
  });
});
