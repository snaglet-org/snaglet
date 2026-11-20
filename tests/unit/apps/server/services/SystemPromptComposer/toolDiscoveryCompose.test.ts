/**
 * The tool-discovery rule in the composed prompt, offline (no model, no
 * network, no database): the advertised catalog comes from the real resolver
 * over a mocked tools table, for each tool-access mode, and the prompt is
 * composed from it. Pins that the rule is present in every mode, high in the
 * prompt (right after identity), stated once, and adapts when `custom_tool`
 * is denied.
 */

jest.mock('@snaglet/db/tables/skill_assignments', () => ({
  SkillAssignments: { agentHasAny: async () => false },
}));
jest.mock('@snaglet/db/tables/skill_registry', () => ({
  SkillRegistry: { listBuiltinValid: async () => [] },
}));

const listResolvableMock = jest.fn();
const findAgentByIdMock = jest.fn();
jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { listResolvable: (...args: unknown[]) => listResolvableMock(...args) },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...args: unknown[]) => findAgentByIdMock(...args) },
}));
jest.mock('@server/services/ToolAvailabilityService', () => ({
  getToolAvailability: jest.fn().mockResolvedValue('available'),
}));
jest.mock('@server/services/McpService', () => ({
  mcpService: {
    ensureServersConnected: jest.fn(),
    getToolDefsForServers: jest.fn().mockReturnValue([]),
    getConfirmationPolicy: jest.fn().mockReturnValue(true),
  },
}));

jest.mock('@server/services/SystemPromptComposer/blocks/toolCatalogBlock', () => ({
  __esModule: true,
  ...jest.requireActual('@server/services/SystemPromptComposer/blocks/toolCatalogBlock'),
  isSemanticSearchAvailable: async () => true,
}));
jest.mock('@snaglet/db/tables/users', () => ({
  Users: { getActiveUser: jest.fn().mockResolvedValue({ name: 'Test User' }) },
}));
jest.mock('@server/services/SystemPromptComposer/hostMachine', () => ({
  describeHostMachine: () => 'a test computer running TestOS (kernel 1.0, x64), 4 cores, 16 GB RAM',
}));
jest.mock('@server/services/snagletHome', () => ({
  ...jest.requireActual('@server/services/snagletHome'),
  SNAGLET_SKILLS_DIR: '/test-home/skills',
}));
jest.mock('@server/services/AgentService', () => ({
  agentService: { get: jest.fn().mockResolvedValue(undefined) },
}));

import { resolveAdvertisedAgentToolSets } from '@server/services/AgentToolResolver';
import { composeSystemPrompt } from '@server/services/SystemPromptComposer/composeSystemPrompt';
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { CORE_TOOL_ORDER } from '@snaglet/shared/constants';
import { makeCtx } from './composeFixtures';

function row(id: string, tier: 'core' | 'standard' = 'core'): ToolRow {
  return {
    id,
    name: id,
    description: id,
    type: 'builtin',
    parametersSchema: {},
    keywords: [],
    aliases: [],
    source: null,
    configJson: {},
    enabled: true,
    tier,
    categoryPath: 'system',
    providerId: null,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  } as ToolRow;
}

// The real core set (minus `skill`, which needs an assigned skill) plus two
// on-demand tools, one of them the theme tool from the incident.
const CATALOG = [
  ...CORE_TOOL_ORDER.filter((id) => id !== 'skill').map((id) => row(id)),
  row('change_color_theme', 'standard'),
  row('browser', 'standard'),
];

const SEARCH_CALL = "tool({op: 'search', query: 'color theme'})";
const RULE_HEADING = '## Tools: search before you say no';

interface Case {
  name: string;
  access: ToolAccessConfig;
  strict?: boolean;
}

const MODES: Case[] = [
  { name: 'all', access: { mode: 'all', allowList: [], denyList: [] } },
  {
    name: 'allow list that does not name tool search',
    access: { mode: 'allow_list', allowList: ['doc', 'file'], denyList: [] },
  },
  {
    name: 'strict allow list (small-model trim)',
    access: { mode: 'allow_list', allowList: ['doc'], denyList: [] },
    strict: true,
  },
  {
    name: 'deny list that names tool search and custom_tool',
    access: { mode: 'deny_list', allowList: [], denyList: ['tool', 'custom_tool'] },
  },
];

async function composeFor({ access, strict = false }: Case) {
  findAgentByIdMock.mockResolvedValue({
    id: 'agent-self',
    name: 'Clio',
    toolAccessMode: access.mode,
    toolAccessAllowList: access.allowList,
    toolAccessDenyList: access.denyList,
    toolAccessAdvertiseAllowedOnly: strict,
    toolOverrides: null,
    mcpServers: null,
    parentAgentId: null,
  });
  const { advertisedTools } = await resolveAdvertisedAgentToolSets('agent-self', { access });
  const ctx = makeCtx({ agentTools: advertisedTools });
  ctx.agent = { ...ctx.agent, name: 'Clio' };
  const blocks = await composeSystemPrompt(ctx);
  return { advertisedTools, blocks, text: blocks.map((b) => b.text).join('\n\n') };
}

beforeEach(() => {
  jest.clearAllMocks();
  listResolvableMock.mockResolvedValue(CATALOG);
});

describe('tool discovery rule in the composed prompt', () => {
  test.each(MODES)('is present for an agent in mode: $name', async (mode) => {
    const { advertisedTools, text } = await composeFor(mode);
    // Tool search is always available: no allow or deny entry removes it.
    expect(advertisedTools.map((at) => at.tool.id)).toContain('tool');
    expect(text).toContain(RULE_HEADING);
    expect(text).toContain(SEARCH_CALL);
    expect(text).toContain(
      '**NEVER declare a capability unavailable before searching the catalog. If a call fails, report the actual error rather than assuming access was lost.**'
    );
  });

  it('sits right after identity, before the long how-to-work material', async () => {
    const { blocks } = await composeFor(MODES[0]!);
    expect(blocks[0]!.text.startsWith('## Who you are')).toBe(true);
    expect(blocks[1]!.text.startsWith(RULE_HEADING)).toBe(true);
    const index = (heading: string) => blocks.findIndex((b) => b.text.includes(heading));
    expect(index(RULE_HEADING)).toBeLessThan(index('## How to work'));
    expect(index(RULE_HEADING)).toBeLessThan(index('## Using tools'));
  });

  it('is stated once, with no separate "More tools than you can see" paragraph', async () => {
    const { text } = await composeFor(MODES[0]!);
    expect(text.split(RULE_HEADING).length - 1).toBe(1);
    expect(text.split(SEARCH_CALL).length - 1).toBe(1);
    expect(text).not.toContain('More tools than you can see');
  });

  it('offers an agent with custom_tool to create the missing tool', async () => {
    const { text } = await composeFor(MODES[0]!);
    expect(text).toContain('you can create one with `custom_tool` (op `create`');
  });

  it('adapts when custom_tool is denied: the user adds the tool instead', async () => {
    const { advertisedTools, text } = await composeFor(MODES[3]!);
    expect(advertisedTools.map((at) => at.tool.id)).not.toContain('custom_tool');
    expect(text).not.toContain('you can create one with `custom_tool`');
    expect(text).toContain('Tools view → New tool');
    expect(text).toContain('Agents → Clio → Capabilities');
  });
});
