/**
 * Anthropic cache_control plumbing.
 *
 * Pins the contract pieces that are pure functions:
 *  - the extended-TTL beta header is requested (without it the API may
 *    silently coerce 1h breakpoints back to the 5-minute default)
 *  - the system prompt uses the extended 1h TTL for chat runs — breakpoint
 *    placement is centralized in composeSystemPrompt (individual block
 *    builders carry no cache_control), so the stable-core breakpoint is
 *    asserted on the composed output, not on perceptionBlock.
 */

const mockIsSemanticSearch = jest.fn().mockResolvedValue(false);
jest.mock('@server/services/SystemPromptComposer/blocks/toolCatalogBlock', () => {
  const actual = jest.requireActual(
    '@server/services/SystemPromptComposer/blocks/toolCatalogBlock'
  );
  return { __esModule: true, ...actual, isSemanticSearchAvailable: () => mockIsSemanticSearch() };
});

import { buildAnthropicAuthedRequest } from '@server/services/ProviderChatService/shared';
import { perceptionBlock } from '@server/services/SystemPromptComposer/blocks/perceptionBlock';
import { composeSystemPrompt } from '@server/services/SystemPromptComposer/composeSystemPrompt';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';

const makeTool = (id: string) => ({
  tool: {
    id,
    name: id,
    description: '',
    keywords: [],
    categoryPath: 'workspace',
    type: 'builtin',
    parametersSchema: {},
  },
  settings: {},
});

const ctxOf = (runKind: string): SystemPromptContext =>
  ({
    runKind,
    agent: { id: 'self', name: 'Self', role: 'tester' },
    runtimeAgent: { id: 'self', name: 'Self', systemPrompt: '' },
    threadRuntimeConfig: null,
    isGroup: false,
    replyAgentId: 'self',
    participantAgentIds: ['self'],
    dispatchMode: 'all',
    runParams: { host_path: '/snaglet/host' },
    // Provide workspace tools so perceptionBlock renders at least one section
    agentTools: [makeTool('workspace_search'), makeTool('memory_recall')],
  }) as unknown as SystemPromptContext;

describe('buildAnthropicAuthedRequest — beta headers', () => {
  test('requests prompt caching and the extended cache TTL beta', () => {
    const { headers } = buildAnthropicAuthedRequest({
      secret: 'sk-ant-test-key',
      model: 'claude-sonnet-4-6',
      system: 'system prompt',
    });
    const beta = headers['anthropic-beta'] ?? '';
    expect(beta).toContain('prompt-caching-2024-07-31');
    expect(beta).toContain('extended-cache-ttl-2025-04-11');
  });

  test('system blocks pass through with their cache_control intact', () => {
    const { system } = buildAnthropicAuthedRequest({
      secret: 'sk-ant-test-key',
      model: 'claude-sonnet-4-6',
      system: '',
      systemBlocks: [
        { type: 'text', text: 'stable prefix', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'volatile suffix' },
      ],
    });
    const blocks = system as Array<{ text: string; cache_control?: { ttl?: string } }>;
    expect(blocks.find((b) => b.text === 'stable prefix')?.cache_control?.ttl).toBe('1h');
    expect(blocks.find((b) => b.text === 'volatile suffix')?.cache_control).toBeUndefined();
  });
});

describe('system-block breakpoints', () => {
  test('individual block builders carry no cache_control — the composer places it', async () => {
    const block = await perceptionBlock(ctxOf('realtime_thread'));
    expect(block?.cache_control).toBeUndefined();
  });

  test('composeSystemPrompt places the stable-core 1h breakpoint on the last core block', async () => {
    const blocks = await composeSystemPrompt(ctxOf('realtime_thread'));
    const withBreakpoints = blocks.filter((b) => b.cache_control);
    // No threadSystemPrompt here → exactly one system breakpoint, on the last block.
    expect(withBreakpoints).toHaveLength(1);
    expect(blocks[blocks.length - 1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});
