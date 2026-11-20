/**
 * Core tools are advertised in CORE_TOOL_ORDER, whatever order the
 * catalog (DB `sort_order, name`) returns them in; non-core tools follow in
 * their arrival order. One constant, so the cached tools prefix is the same
 * for every agent with the same core set.
 */
import { CORE_TOOL_IDS, CORE_TOOL_ORDER } from '@snaglet/shared/constants';
import { orderAdvertisedTools } from '@server/services/AgentToolResolver';
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';

const entry = (id: string): ResolvedAgentTool =>
  ({
    agentId: 'agent-1',
    settings: {},
    requiresConfirmation: false,
    tool: { id, tier: CORE_TOOL_IDS.has(id) ? 'core' : 'standard' },
  }) as unknown as ResolvedAgentTool;

const ids = (tools: ResolvedAgentTool[]) => tools.map((t) => t.tool.id);

describe('CORE_TOOL_ORDER', () => {
  it('covers exactly CORE_TOOL_IDS, with no duplicates', () => {
    expect(new Set(CORE_TOOL_ORDER).size).toBe(CORE_TOOL_ORDER.length);
    expect([...CORE_TOOL_ORDER].sort()).toEqual([...CORE_TOOL_IDS].sort());
  });

  it('puts the gateway and the most-used tools first', () => {
    expect(CORE_TOOL_ORDER.slice(0, 6)).toEqual([
      'action',
      'search',
      'file',
      'shell',
      'node',
      'doc',
    ]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CORE_TOOL_ORDER)).toBe(true);
  });
});

describe('orderAdvertisedTools', () => {
  it('sorts core tools by CORE_TOOL_ORDER regardless of catalog order', () => {
    const alphabetical = [...CORE_TOOL_ORDER].sort().map(entry);
    const reversed = [...CORE_TOOL_ORDER].reverse().map(entry);
    expect(ids(orderAdvertisedTools(alphabetical))).toEqual([...CORE_TOOL_ORDER]);
    expect(ids(orderAdvertisedTools(reversed))).toEqual([...CORE_TOOL_ORDER]);
  });

  it('keeps non-core tools after core, in arrival order', () => {
    const input = ['zeta_tool', 'doc', 'mcp__x__a', 'search', 'alpha_tool'].map(entry);
    expect(ids(orderAdvertisedTools(input))).toEqual([
      'search',
      'doc',
      'zeta_tool',
      'mcp__x__a',
      'alpha_tool',
    ]);
  });

  it('only reorders: same members, nothing added or dropped', () => {
    const input = ['web_search', 'git', 'table_read', 'action'].map(entry);
    const out = orderAdvertisedTools(input);
    expect(new Set(out)).toEqual(new Set(input));
    expect(out).toHaveLength(input.length);
  });
});
