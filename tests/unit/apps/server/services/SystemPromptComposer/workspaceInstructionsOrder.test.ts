/**
 * Where the owner's instructions for all agents land in the composed system
 * prompt: after the agent-level core, before the skill catalog and the
 * thread's own instructions, with the single cache breakpoint still on
 * whichever block renders last.
 */

const mockIsSemanticSearch = jest.fn(async () => false);
let mockInstructions = '';

jest.mock('@server/services/SystemPromptComposer/blocks/toolCatalogBlock', () => {
  const actual = jest.requireActual(
    '@server/services/SystemPromptComposer/blocks/toolCatalogBlock'
  );
  return {
    __esModule: true,
    ...actual,
    isSemanticSearchAvailable: () => mockIsSemanticSearch(),
  };
});
jest.mock('@server/services/settings', () => ({
  settingsService: {
    read: async (def: { key: string; default: unknown }) =>
      def.key === 'global_instructions' ? mockInstructions : def.default,
  },
}));
jest.mock('@server/services/AgentService', () => ({
  agentService: { get: async () => undefined },
}));
jest.mock('@server/services/SummaryService', () => ({
  summaryService: { getThreadSummary: async () => null },
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/buildPriorRunHint', () => ({
  buildPriorRunHint: async () => null,
}));

import { composeSystemPrompt } from '@server/services/SystemPromptComposer/composeSystemPrompt';
import { WORKSPACE_INSTRUCTIONS_OPEN } from '@server/services/SystemPromptComposer/blocks/workspaceInstructionsBlock';
import { THREAD_INSTRUCTIONS_OPEN } from '@server/services/SystemPromptComposer/blocks/threadSystemPromptBlock';
import { SKILL_CATALOG_HEADER } from '@server/services/skills/skillCatalog';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';
import { makeCtx } from './composeFixtures';

type Block = { text: string; cache_control?: unknown };

const OWNER_TEXT = 'Write in plain English. Ask before deleting anything.';

function ctxWith(opts: { threadPrompt?: string; skills?: boolean } = {}): SystemPromptContext {
  return {
    ...makeCtx({ threadSystemPrompt: opts.threadPrompt }),
    skillCatalog: opts.skills ? [{ slug: 'triage', description: 'Triage a bug.' }] : [],
  };
}

const kindOf = (b: Block): string => {
  if (b.text.startsWith(WORKSPACE_INSTRUCTIONS_OPEN)) return 'workspace';
  if (b.text.startsWith(SKILL_CATALOG_HEADER)) return 'skills';
  if (b.text.startsWith(THREAD_INSTRUCTIONS_OPEN)) return 'thread';
  return 'core';
};

const withoutCache = (blocks: Block[]) => blocks.map((b) => b.text);

beforeEach(() => {
  mockInstructions = '';
});

describe('composeSystemPrompt — instructions for all agents', () => {
  test('sit after the core and before the skill catalog and the thread instructions', async () => {
    mockInstructions = OWNER_TEXT;
    const blocks = (await composeSystemPrompt(
      ctxWith({ threadPrompt: 'Be terse.', skills: true })
    )) as Block[];

    const kinds = blocks.map(kindOf);
    expect(kinds.slice(-3)).toEqual(['workspace', 'skills', 'thread']);
    expect(kinds.slice(0, -3).every((k) => k === 'core')).toBe(true);
    expect(blocks[kinds.indexOf('workspace')]!.text).toContain(OWNER_TEXT);

    expect(blocks.filter((b) => b.cache_control)).toHaveLength(1);
    expect(blocks[blocks.length - 1]!.cache_control).toBeDefined();
  });

  test('carry the one cache breakpoint when nothing per-thread renders after them', async () => {
    mockInstructions = OWNER_TEXT;
    const blocks = (await composeSystemPrompt(ctxWith())) as Block[];

    expect(kindOf(blocks[blocks.length - 1]!)).toBe('workspace');
    expect(blocks.filter((b) => b.cache_control)).toHaveLength(1);
    expect(blocks[blocks.length - 1]!.cache_control).toBeDefined();
  });

  test('empty setting adds no block and leaves the rest of the prompt unchanged', async () => {
    const empty = (await composeSystemPrompt(
      ctxWith({ threadPrompt: 'Be terse.', skills: true })
    )) as Block[];
    expect(empty.some((b) => kindOf(b) === 'workspace')).toBe(false);

    mockInstructions = OWNER_TEXT;
    const set = (await composeSystemPrompt(
      ctxWith({ threadPrompt: 'Be terse.', skills: true })
    )) as Block[];

    expect(withoutCache(set.filter((b) => kindOf(b) !== 'workspace'))).toEqual(withoutCache(empty));
  });
});
