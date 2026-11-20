/**
 * subagentBlock — when and how to use subagent helpers, gated on the
 * `subagent` tool, pointing at `op "models"` for the models a helper can run on.
 */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { ModelRow } from '@snaglet/db/tables/models';

const mockProvider = jest.fn<() => Promise<string | null>>();
const mockModels = jest.fn<(providerId: string) => Promise<ModelRow[]>>();
jest.mock('@server/services/subagents/helperModels', () => ({
  helperProviderId: () => mockProvider(),
  helperModels: (providerId: string) => mockModels(providerId),
}));

import { subagentBlock } from '@server/services/SystemPromptComposer/blocks/subagentBlock';

function model(over: Partial<ModelRow> & { modelId: string }): ModelRow {
  return {
    id: `test-provider:${over.modelId}`,
    providerId: 'test-provider',
    displayName: over.modelId,
    description: '',
    family: null,
    contextWindowTokens: null,
    maxOutputTokens: null,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    isActive: true,
    sortOrder: 0,
    type: 'llm',
    dimensions: null,
    metadata: {} as ModelRow['metadata'],
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...over,
  };
}

async function textFor(
  toolIds: string[],
  currentModelId = 'test-strong',
  isDm = false
): Promise<string | null> {
  const ctx = {
    isDm,
    agentTools: toolIds.map((id) => ({ tool: { id } })),
    agent: { id: 'test-agent-a', provider: 'test-provider' },
    runtimeAgent: { id: 'test-agent-a', modelId: currentModelId },
    threadId: 'thread-1111111111111-aaaaaaaaa',
  } as unknown as Parameters<typeof subagentBlock>[0];
  const block = await subagentBlock(ctx);
  return block === null ? null : ((block as { text?: string }).text ?? '');
}

beforeEach(() => {
  mockProvider.mockReset().mockResolvedValue('test-provider');
  mockModels.mockReset().mockResolvedValue([
    model({ modelId: 'test-fast', displayName: 'Test Fast', contextWindowTokens: 200_000 }),
    model({
      modelId: 'test-strong',
      displayName: 'Test Strong',
      contextWindowTokens: 1_000_000,
      supportsReasoning: true,
      supportsVision: true,
    }),
  ]);
});

describe('subagentBlock', () => {
  test('is absent without the subagent tool (helpers never have it)', async () => {
    expect(await textFor(['search', 'thread'])).toBeNull();
    expect(mockModels).not.toHaveBeenCalled();
  });

  test('says when to run helpers in parallel and when to delegate, and when not to', async () => {
    const text = (await textFor(['subagent'])) ?? '';
    expect(text).toContain('## Subagents');
    expect(text).toContain('the user asks for parallel work');
    // Starting several in one turn is the subagent tool's description.
    expect(text).toContain('(one helper per piece, a few at a time)');
    expect(text).toContain('would flood your context');
    expect(text).toContain('Do the work yourself when it is quick');
    expect(text).toContain(
      'A teammate in your thread is reached with an `@`-mention, not a helper.'
    );
  });

  test('sends timed and recurring work to automations, since reports arrive asynchronously', async () => {
    // Asked to "wake me in 2 minutes", an agent briefed a helper to wait (seen live).
    const text = (await textFor(['subagent'])) ?? '';
    expect(text).toContain(
      'Helpers return reports asynchronously; for scheduled or recurring work ("in 10 minutes", "tomorrow at 9", "every weekday"), use the `automation` tool rather than keeping a helper waiting.'
    );
    expect(text).not.toContain("Helpers can't wait or wake you later");
    expect(text.startsWith('## Subagents\nUse `subagent` helpers')).toBe(true);
  });

  test('names the models lookup instead of listing models', async () => {
    const text = (await textFor(['subagent'])) ?? '';
    expect(text).toContain('Pick a small, fast model for lookups');
    expect(text).toContain('`subagent` op `models`');
    expect(text).not.toContain('Models on your provider');
    expect(text).not.toContain('test-fast');
    expect(mockModels).not.toHaveBeenCalled();
    expect(mockProvider).not.toHaveBeenCalled();
  });

  test('teaches the brief, wait-or-end-turn, never inventing a report, and re-tasking', async () => {
    const text = (await textFor(['subagent'])) ?? '';
    expect(text).toContain('A helper sees only its brief');
    // What a helper is and what a brief holds live on the subagent tool's own description.
    expect(text).not.toContain('runs a named helper in its own hidden thread');
    // Same long-work wording as block 3; table creation is the snaglet-projects skill's job.
    expect(text).toContain("the work's own doc");
    expect(text).not.toContain('never a new table');
    expect(text).toContain('what done looks like');
    expect(text).toContain('Ending your turn to await a report is the one exception');
    // Mechanics live once, on the subagent tool's description.
    expect(text).not.toContain('`send` gives a helper more work');
    // Counter-rule to run mode's "finish what you announce": without it an agent
    // invented the helper's report instead of ending its turn (seen live).
    expect(text).toContain(
      'the one exception to finishing what you announce; never write or guess a report yourself.'
    );
  });
});

test('a DM / home thread drops the @-mention teammate line; group threads keep it', async () => {
  const group = await textFor(['subagent']);
  const dm = await textFor(['subagent'], 'test-strong', true);
  expect(group).toContain('reached with an `@`-mention');
  expect(dm).not.toMatch(/@|mention/);
  expect(dm).toContain('## Subagents');
});
