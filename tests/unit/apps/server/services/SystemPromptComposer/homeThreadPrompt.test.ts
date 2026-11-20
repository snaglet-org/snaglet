/**
 * A home thread (the user's DM with one agent, `threads.kind = 'dm'`) holds
 * only the user and that agent, so its prompt says nothing about routing,
 * mention modes, @-tags or who answers: the reply goes to the user. The
 * group-thread prompt keeps all of it. Composed end to end with the real
 * built-in skill catalog and the turn-context tail a DM resolves to (no
 * routing line: resolveRunParams leaves it out for a DM, tested there).
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const mockAgentGet = jest.fn();
jest.mock('@server/services/AgentService', () => ({
  agentService: { get: (...args: unknown[]) => mockAgentGet(...args) },
}));
jest.mock('@server/services/SystemPromptComposer/blocks/toolCatalogBlock', () => {
  const actual = jest.requireActual(
    '@server/services/SystemPromptComposer/blocks/toolCatalogBlock'
  );
  return { __esModule: true, ...actual, isSemanticSearchAvailable: async () => true };
});

import { composeSystemPrompt } from '@server/services/SystemPromptComposer/composeSystemPrompt';
import { composeTurnContextData } from '@server/services/SystemPromptComposer/composeTurnContextTail';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';
import { makeCtx, MINIMAL_TOOLS, TOOLS, GROUP_PARTICIPANTS, GROUP_PEERS } from './composeFixtures';

const SKILLS_DIR = path.resolve(__dirname, '../../../../../../apps/server/builtin-skills');

/** The built-in skills' real catalog lines. */
const CATALOG = readdirSync(SKILLS_DIR)
  .sort()
  .map((slug) => {
    const raw = readFileSync(path.join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
    return { slug, description: /^description:\s*(.*)$/m.exec(raw)![1]! };
  });

/** Wording that only means something where several agents share a thread. */
const ROUTING = [
  /routing/i,
  /`mentioned`/,
  /`all`/,
  /broadcast/i,
  /`@`-tag|@-tag/,
  /who answers/i,
  /hand(?:ing)? off|handoff/i,
  /snaglet-group-threads/,
];

async function prompt(over: Record<string, unknown>): Promise<string> {
  const ctx = {
    ...makeCtx({ agentTools: [...MINIMAL_TOOLS, TOOLS.thread], dispatchMode: 'mentioned' }),
    skillCatalog: CATALOG,
    ...over,
  } as unknown as SystemPromptContext;
  const blocks = await composeSystemPrompt(ctx);
  return [...blocks.map((b) => b.text), composeTurnContextData(ctx)].join('\n\n');
}

beforeEach(() => {
  mockAgentGet.mockReset();
  mockAgentGet.mockImplementation(async (id: string) => GROUP_PEERS[id]);
});

describe('home thread prompt', () => {
  it('has no routing, mention-mode or who-answers wording', async () => {
    const text = await prompt({
      isDm: true,
      runParams: { host_path: '/snaglet/host', thread_title: 'Patty ↔ Sam', thread_is_dm: 'true' },
    });
    for (const pattern of ROUTING) {
      expect({ pattern: String(pattern), found: pattern.exec(text)?.[0] ?? null }).toEqual({
        pattern: String(pattern),
        found: null,
      });
    }
    expect(text).toContain('This is a direct conversation between you and the user');
    expect(text).toContain('your reply is the message and goes to them');
  });

  it('a group thread keeps its routing modes, handoffs and the group-threads skill', async () => {
    const text = await prompt({
      isGroup: true,
      participantAgentIds: GROUP_PARTICIPANTS,
      runParams: { host_path: '/snaglet/host', thread_routing: 'mentioned' },
    });
    expect(text).toContain('**Routing modes.**');
    expect(text).toContain('**Handing off.**');
    expect(text).toContain('its routing mode decides who a message wakes');
    expect(text).toContain('`snaglet-group-threads`');
    expect(text).toContain('- Routing mode: `mentioned`');
  });
});
