import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/services/subagents/helperInheritance', () => ({
  resolveHelperToolPolicy: jest.fn(),
}));

import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import type { AgentRow } from '@snaglet/db/tables/agents';
import {
  GHOST_TOOL_ACCESS,
  resolveAgentToolPolicy,
} from '@server/services/ToolService/lib/agentToolPolicy';

const row = (partial: Partial<AgentRow>): AgentRow =>
  ({
    id: 'a',
    name: 'a',
    parentAgentId: null,
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    ...partial,
  }) as AgentRow;

describe('ghost tool policy', () => {
  it('judges ghost by the fixed allow list, whatever its row says', async () => {
    const policy = await resolveAgentToolPolicy(row({ id: GHOST_AGENT_ID, toolAccessMode: null }));
    expect(policy.access.mode).toBe('allow_list');
    expect(policy.access.allowList).toEqual([...GHOST_TOOL_ACCESS.allowList]);
    expect(policy.access.allowList).not.toContain('shell');
    expect(policy.helper).toBe(false);
  });

  it('hands out a copy, so a caller cannot widen the shared list', async () => {
    const policy = await resolveAgentToolPolicy(row({ id: GHOST_AGENT_ID }));
    policy.access.allowList.push('shell');
    expect(GHOST_TOOL_ACCESS.allowList).not.toContain('shell');
  });

  it('leaves every other agent on its own row (null mode still reads as all)', async () => {
    const policy = await resolveAgentToolPolicy(row({ id: 'echo', toolAccessMode: null }));
    expect(policy.access.mode).toBe('all');
  });
});
