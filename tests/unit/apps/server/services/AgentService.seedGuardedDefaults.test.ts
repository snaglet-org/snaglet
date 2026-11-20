/**
 * Starter-agent seeding × guarded confirmation defaults.
 *
 * A fresh install's starter agents, Patty and Clio, must not ship as unconfirmed operators:
 * seeding writes the same creation-time guarded overrides every new agent
 * gets — per-tool `requiresConfirmation: true` for the call-time-guarded
 * kinds (shell/file/SQL/git) plus destructive builtins. Own file because
 * ensureDefaults seeds once per module instance.
 */

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

// Controlled registry: one destructive builtin beyond the shared guarded kinds.
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn().mockResolvedValue(undefined),
    getAllDefinitions: jest.fn().mockReturnValue({
      delete_doc: { id: 'delete_doc', destructive: true },
      file_read: { id: 'file_read' },
    }),
  },
}));

import { agentService } from '@server/services/AgentService';
import { GUARDED_TOOL_KINDS } from '@snaglet/shared/utils';

function makeAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'patty',
    name: 'Patty',
    role: 'Librarian & Context Manager',
    avatarUrl: null,
    credentialId: null,
    modelId: null,
    systemPrompt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('AgentService starter seeding is guarded', () => {
  it('seeds Patty and Clio with requiresConfirmation:true for every guarded tool', async () => {
    const seeded: Array<Record<string, unknown>> = [];
    mockListAgents.mockImplementation(async (opts?: { limit?: number }) =>
      opts?.limit === 1 ? [] : seeded
    );
    mockCreateAgent.mockImplementation(async (input: Record<string, unknown>) => {
      const row = makeAgentRow(input);
      seeded.push(row);
      return row;
    });

    await agentService.list();

    expect(mockCreateAgent).toHaveBeenCalledTimes(2);
    const names = mockCreateAgent.mock.calls.map(([input]) => (input as { name: string }).name);
    expect(names).toEqual(['Patty', 'Clio']);
    for (const [input] of mockCreateAgent.mock.calls) {
      const created = input as Record<string, unknown>;
      // No provider or model: a starter agent adopts what the user connects.
      expect(created.providerId).toBeUndefined();
      expect(created.modelId).toBeUndefined();
      // Before the onboarding seed links its docs, placeholders read as plain text.
      expect(created.systemPrompt).toEqual(expect.any(String));
      expect(created.systemPrompt).not.toMatch(/\]\(onboarding/);
      expect(created.identity).toEqual(expect.any(String));
    }

    for (const [input] of mockCreateAgent.mock.calls) {
      const overrides = (
        input as { toolOverrides: Record<string, { requiresConfirmation?: boolean }> }
      ).toolOverrides;
      // every shared call-time-guarded kind…
      for (const toolId of Object.keys(GUARDED_TOOL_KINDS)) {
        expect(overrides[toolId]).toEqual({ requiresConfirmation: true });
      }
      // …plus destructive definitions, and nothing for benign tools
      expect(overrides.delete_doc).toEqual({ requiresConfirmation: true });
      expect(overrides.file_read).toBeUndefined();
    }
  });
});
