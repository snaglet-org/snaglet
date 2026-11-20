/**
 * Per-block token ceilings — regrowth guard. Each authored-prose block is
 * measured at its maximal representative context and asserted below a ceiling
 * of roughly measured + 10%, using the Anthropic char-ratio estimator the
 * runtime budgets with. Volatile, data-driven content is excluded:
 * threadSystemPrompt (user content) and the per-turn turn-context tail, which
 * lives outside the system prompt in an appended message.
 */

const mockAgentGet = jest.fn();

jest.mock('@server/services/AgentService', () => ({
  agentService: { get: (...args: unknown[]) => mockAgentGet(...args) },
}));

import { estimateTokens } from '@server/services/TokenEstimator';
import { identityBlock } from '@server/services/SystemPromptComposer/blocks/identityBlock';
import { goldenRulesBlock } from '@server/services/SystemPromptComposer/blocks/goldenRulesBlock';
import { howToActBlock } from '@server/services/SystemPromptComposer/blocks/howToActBlock';
import { toolDiscoveryBlock } from '@server/services/SystemPromptComposer/blocks/toolDiscoveryBlock';
import { perceptionBlock } from '@server/services/SystemPromptComposer/blocks/perceptionBlock';
import { toolCatalogBlock } from '@server/services/SystemPromptComposer/blocks/toolCatalogBlock';
import { operatingContextBlock } from '@server/services/SystemPromptComposer/blocks/operatingContextBlock';
import { runModeBlock } from '@server/services/SystemPromptComposer/blocks/runModeBlock';
import type { BlockBuilder } from '@server/services/SystemPromptComposer/types';
import {
  makeCtx,
  makeTool,
  FULL_TOOLS,
  TABLE_TOOLS,
  DOC_TOOLS,
  MINIMAL_TOOLS,
  TOOLS,
  PROJECT_RUN_PARAMS,
  GROUP_PARTICIPANTS,
  GROUP_PEERS,
} from './composeFixtures';

beforeEach(() => {
  mockAgentGet.mockReset();
  mockAgentGet.mockImplementation(async (id: string) => GROUP_PEERS[id]);
});

/**
 * Ceilings ≈ current measured tokens + 10% (est. via the Anthropic strategy,
 * at each block's maximal representative rendering). Retune deliberately.
 * The trailing comment records the measured baseline the ceiling is set
 * from, so a retune is a one-line, reviewable edit.
 *
 * toolCatalogBlock note: measured against the fixed fixture toolset, so this
 * ceiling guards the catalog's rendering structure (core/MCP grouping, the
 * discovery pointer, the per-tool signature format) — not the live registry's
 * total size, which is a function of tier assignments (guarded by the tier
 * tests in toolReferences.test.ts) and the schemas themselves.
 */
const CASES: Array<{ name: string; ceiling: number; build: BlockBuilder }> = [
  // Scaffold only (no configured systemPrompt — that is user content).
  // See trailing `measured N` comments for the recorded baselines.
  { name: 'identityBlock', ceiling: 162, build: identityBlock }, // measured 147 — who the agent is in plain words, owner, what persists, transport-label note, the source with the reason to read it, How you act (or its no-instructions note); the agent's persona and own prompt are user content, not measured
  { name: 'operatingContextBlock', ceiling: 1294, build: operatingContextBlock }, // measured 1176 (was 1212) — what Snaglet is (14 parts), where things live, this computer, project scoping, how to make a skill (2 lines), links and what they render as, the shorter Transclusions paragraph (part-of-doc links live in the snaglet-search skill)
  { name: 'goldenRulesBlock', ceiling: 980, build: goldenRulesBlock }, // measured 891 (was 1206 with the default attitude) — the operating rules only, one per topic (evidence incl. what the agent sees, truthfulness, time, never-imitate calls, text is information, verify, ask when it matters and the scope stop, avoid duplicates, chat/doc/memory and privacy, long work)
  { name: 'toolDiscoveryBlock', ceiling: 428, build: toolDiscoveryBlock }, // measured 389 (was 392) — the search-before-you-say-no rule: four steps (search, use, blocked, nothing fits), one bold rule and the change_color_theme worked example; emphasis is deliberate (agents told users a tool was missing or "lost" without searching)
  { name: 'howToActBlock', ceiling: 405, build: howToActBlock }, // measured 378 (was 368; the visuals rule now says it is a default the user can change) — the ungated browser/desktop safety line, visuals, worked turn; calling natively or through `action` is the action tool's description, browser/computer detail lives in perception's gated sections
  { name: 'perceptionBlock', ceiling: 458, build: perceptionBlock }, // measured 416 (was 440) — docs and tables, memory incl. reading a recalled memory as possibly stale, browser (only what the tool description does not say)
  { name: 'toolCatalogBlock', ceiling: 33, build: toolCatalogBlock }, // measured 30 — MCP servers only (the fixture has one MCP tool, as a one-line summary); core tools are not listed
  { name: 'runModeBlock', ceiling: 436, build: runModeBlock }, // measured 396 (was 514) — your reply is the message, routing modes, mentions and what a post proves, post only when new; bringing agents in and out is the snaglet-group-threads skill's
  { name: 'runModeBlock (home thread)', ceiling: 139, build: runModeBlock }, // measured 126 — the reply goes to the user, ending your turn; no routing, mentions or handoffs (a home thread holds the user and one agent)
];

/** Maximal context per block — the biggest each one legitimately renders. */
function ctxFor(name: string) {
  switch (name) {
    case 'goldenRulesBlock':
      return makeCtx({ isGroup: true });
    case 'toolDiscoveryBlock':
      return makeCtx({ agentTools: [...MINIMAL_TOOLS, makeTool({ id: 'custom_tool' })] });
    case 'howToActBlock':
      return makeCtx({
        agentTools: [...MINIMAL_TOOLS, TOOLS.get_clarification],
        embeddingsEnabled: true,
      });
    case 'perceptionBlock':
      return makeCtx({ agentTools: [...FULL_TOOLS, ...TABLE_TOOLS], embeddingsEnabled: true });
    case 'toolCatalogBlock':
      return makeCtx({ agentTools: FULL_TOOLS, embeddingsEnabled: true });
    case 'operatingContextBlock':
      return makeCtx({
        runParams: PROJECT_RUN_PARAMS,
        embeddingsEnabled: true,
        agentTools: [...FULL_TOOLS, ...DOC_TOOLS],
      });
    case 'runModeBlock (home thread)':
      return { ...makeCtx({ agentTools: [...MINIMAL_TOOLS, TOOLS.thread] }), isDm: true };
    case 'runModeBlock':
      return makeCtx({
        agentTools: [...MINIMAL_TOOLS, TOOLS.thread],
        isGroup: true,
        participantAgentIds: GROUP_PARTICIPANTS,
        dispatchMode: 'all',
      });
    default:
      return makeCtx({});
  }
}

describe('system prompt block token ceilings', () => {
  test.each(CASES)('$name stays under its token ceiling', async ({ name, ceiling, build }) => {
    const block = await build(ctxFor(name));
    const tokens = estimateTokens(block?.text ?? '', 'anthropic');
    expect(tokens).toBeLessThanOrEqual(ceiling);
  });
});
