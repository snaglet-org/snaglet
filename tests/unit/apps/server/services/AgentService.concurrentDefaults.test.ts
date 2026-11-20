const mockListAgents = jest.fn();
const mockCreateAgent = jest.fn();

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    list: mockListAgents,
    create: mockCreateAgent,
  },
}));

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    findByProviderAndModelId: jest.fn(),
  },
}));

// Seeding derives the guarded confirmation set from the tool registry; a real
// load would fs-scan + dynamic-import every builtin. A tiny static map keeps
// this suite about the single-flight seeding behavior.
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn().mockResolvedValue(undefined),
    getAllDefinitions: jest.fn().mockReturnValue({}),
  },
}));

import { agentService } from '@server/services/AgentService';

function makeAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'Venus',
    role: 'CTO',
    avatarUrl: null,
    credentialId: null,
    modelId: 'claude-sonnet-4-5',
    systemPrompt: 'You are Venus.',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('AgentService concurrent default seeding', () => {
  it('single-flights simultaneous first access instead of inserting duplicate ids', async () => {
    const defaultRows = [
      makeAgentRow({ id: 'venus', name: 'Venus' }),
      makeAgentRow({ id: 'clio', name: 'Clio', role: 'COO' }),
    ];
    const createdIds = new Set<string>();

    mockListAgents.mockImplementation(async (opts?: { limit?: number }) =>
      opts?.limit === 1 ? [] : defaultRows
    );
    mockCreateAgent.mockImplementation(async (input: { id: string; name: string }) => {
      if (createdIds.has(input.id)) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint agents_pkey'),
          {
            code: '23505',
            constraint: 'agents_pkey',
          }
        );
      }
      createdIds.add(input.id);
      return makeAgentRow(input);
    });

    const [first, second] = await Promise.all([agentService.list(), agentService.list()]);

    expect(first.map((agent) => agent.id)).toEqual(['venus', 'clio']);
    expect(second.map((agent) => agent.id)).toEqual(['venus', 'clio']);
    expect(mockCreateAgent).toHaveBeenCalledTimes(2);
    expect(
      mockListAgents.mock.calls.filter(
        ([opts]) => (opts as { limit?: number } | undefined)?.limit === 1
      )
    ).toHaveLength(1);
  });
});
