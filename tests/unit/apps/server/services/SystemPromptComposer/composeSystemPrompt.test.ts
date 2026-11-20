/**
 * composeSystemPrompt — structural assertions across representative contexts
 * that survive intentional prose edits (these guard the wiring, not wording).
 *
 * Every volatile dependency is mocked to a fixed value so the composed prompt
 * is deterministic: embeddings availability, peer agents, the thread summary,
 * and the prior-run hint. Tool lists come from the fixed fixture subset, not
 * the live registry. See composeFixtures.ts.
 */

const mockIsSemanticSearch = jest.fn();
const mockAgentGet = jest.fn();
const mockGetThreadSummary = jest.fn();
const mockBuildPriorRunHint = jest.fn();

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
  agentService: { get: (...args: unknown[]) => mockAgentGet(...args) },
}));

jest.mock('@server/services/SummaryService', () => ({
  summaryService: {
    getThreadSummary: (...args: unknown[]) => mockGetThreadSummary(...args),
  },
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/buildPriorRunHint', () => ({
  buildPriorRunHint: (...args: unknown[]) => mockBuildPriorRunHint(...args),
}));

import { composeSystemPrompt } from '@server/services/SystemPromptComposer/composeSystemPrompt';
import {
  makeCtx,
  MINIMAL_TOOLS,
  FULL_TOOLS,
  PROJECT_RUN_PARAMS,
  GROUP_PARTICIPANTS,
  GROUP_PEERS,
} from './composeFixtures';

beforeEach(() => {
  mockIsSemanticSearch.mockReset();
  mockAgentGet.mockReset();
  mockGetThreadSummary.mockReset();
  mockBuildPriorRunHint.mockReset();

  // Deterministic defaults: no summary, no prior-run hint, peers resolve to
  // fixed names. Individual tests set the embeddings toggle.
  mockGetThreadSummary.mockResolvedValue(null);
  mockBuildPriorRunHint.mockResolvedValue(null);
  mockAgentGet.mockImplementation(async (id: string) => GROUP_PEERS[id]);
});

const soloOff = () => makeCtx({ agentTools: MINIMAL_TOOLS });
const fullGroup = () =>
  makeCtx({
    isGroup: true,
    agentTools: FULL_TOOLS,
    runParams: PROJECT_RUN_PARAMS,
    participantAgentIds: GROUP_PARTICIPANTS,
    dispatchMode: 'all',
    systemPrompt: 'You are Vega, the rollout coordinator. Keep the team unblocked.',
    threadSystemPrompt: 'Thread rule: post a daily status doc before ending your turn.',
  });

describe('composeSystemPrompt — structural guards (survive prose rewrites)', () => {
  test('platformHeaderBlock is gone: identity opens the prompt, no meta-narration header', async () => {
    mockIsSemanticSearch.mockResolvedValue(false);
    const blocks = await composeSystemPrompt(soloOff());

    // First block is the identity block.
    expect(blocks[0].text.startsWith('## Who you are')).toBe(true);

    const joined = blocks.map((b) => b.text).join('\n\n');
    expect(joined).not.toContain('The rest of this prompt is composed of');
    expect(joined).not.toContain('identity → discipline → capabilities');
  });

  test('core tools are not re-listed in the prompt; MCP tools are, by server', async () => {
    mockIsSemanticSearch.mockResolvedValue(true);
    const blocks = await composeSystemPrompt(fullGroup());
    const joined = blocks.map((b) => b.text).join('\n\n');

    // The native tool definitions carry the core tools; the prompt does not.
    expect(joined).not.toContain('### Core Tools');
    expect(joined).not.toMatch(/^- search — /m);
    expect(joined).not.toMatch(/^- node — /m);
    expect(joined).not.toContain('### Tool Discovery');
    // MCP tools are not in the native set, so the prompt names them.
    expect(joined).toContain('## MCP servers');
    expect(joined).toMatch(/^- mcp__linear__list_issues — /m);
    // Discovery lives once, in its own block right after identity.
    expect(joined).toContain('## Tools: search before you say no');
    expect(joined).toContain('Your tool list is NOT everything you can do');
    expect(joined).not.toContain('More tools than you can see');
  });

  test('embeddings toggle flips the search guidance without changing block count', async () => {
    mockIsSemanticSearch.mockResolvedValue(true);
    const on = await composeSystemPrompt(makeCtx({ agentTools: MINIMAL_TOOLS }));
    mockIsSemanticSearch.mockResolvedValue(false);
    const off = await composeSystemPrompt(makeCtx({ agentTools: MINIMAL_TOOLS }));

    const onText = on.map((b) => b.text).join('\n\n');
    const offText = off.map((b) => b.text).join('\n\n');

    // The meaning-search note follows the embeddings fact.
    expect(onText).not.toContain('Meaning search is unavailable');
    expect(offText).toContain('Meaning search is unavailable, so search in precise keywords.');
    // Same set of blocks either way (semanticSearchGuidance needs a project, absent here).
    expect(on.length).toBe(off.length);
  });

  test('The browser tool controls the Browser perception section', async () => {
    mockIsSemanticSearch.mockResolvedValue(true);
    const withBrowser = await composeSystemPrompt(fullGroup());
    const withoutBrowser = await composeSystemPrompt(makeCtx({ agentTools: MINIMAL_TOOLS }));

    expect(withBrowser.map((b) => b.text).join('\n\n')).toContain('## Browser');
    expect(withoutBrowser.map((b) => b.text).join('\n\n')).not.toContain('## Browser');
  });
});
