/**
 * Cache-hit verification. The prompt cache is a strict prefix (tools → system
 * → messages), so the system prompt must be byte-identical across turns of a
 * thread even when the roster or dispatch mode changes. Composes two
 * consecutive turns with such a change between them and asserts (a) identical
 * system segments (text and cache_control), (b) the change is not in the system
 * prompt (it surfaces as an event message / turn-context tail), and (c) exactly
 * one system breakpoint, on the last block.
 */

const mockIsSemanticSearch = jest.fn();

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

import { composeSystemPrompt } from '@server/services/SystemPromptComposer/composeSystemPrompt';
import { composeTurnContextData } from '@server/services/SystemPromptComposer/composeTurnContextTail';
import type { SystemContentBlock } from '@server/services/SystemPromptComposer/types';
import { makeCtx, FULL_TOOLS, GROUP_PARTICIPANTS } from './composeFixtures';

beforeEach(() => {
  mockIsSemanticSearch.mockReset();
  mockIsSemanticSearch.mockResolvedValue(true);
});

/** Render blocks to a comparable shape: text + breakpoint flag per block. */
function fingerprint(blocks: SystemContentBlock[]): string {
  return JSON.stringify(blocks.map((b) => ({ text: b.text, cc: b.cache_control ?? null })));
}

function breakpointIndexes(blocks: SystemContentBlock[]): number[] {
  return blocks.flatMap((b, i) => (b.cache_control ? [i] : []));
}

describe('composeSystemPrompt — byte-identical across a roster + mode change', () => {
  // Turn 1: solo, broadcast. Turn 2: two peers added, mode flipped to mentioned.
  // Same thread, same agent, same tools, same (user-authored) thread prompt.
  const threadSystemPrompt = 'Thread rule: post a daily status doc before ending your turn.';

  const turn1 = () =>
    makeCtx({
      isGroup: false,
      agentTools: FULL_TOOLS,
      dispatchMode: 'all',
      participantAgentIds: ['agent-self'],
      threadSystemPrompt,
    });

  const turn2 = () =>
    makeCtx({
      isGroup: true,
      agentTools: FULL_TOOLS,
      dispatchMode: 'mentioned',
      participantAgentIds: GROUP_PARTICIPANTS,
      threadSystemPrompt,
    });

  test('(a) system segments are byte-identical (text + cache_control)', async () => {
    const a = await composeSystemPrompt(turn1());
    const b = await composeSystemPrompt(turn2());
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  test('(b) the roster/mode change does not leak into the system prompt', async () => {
    const joined = (await composeSystemPrompt(turn2())).map((x) => x.text).join('\n');
    // No peer names, no active-mode singling-out — the system teaches all modes
    // generically and names no participants. The change surfaces via the tail /
    // event messages instead.
    expect(joined).not.toContain('Peer One');
    expect(joined).not.toContain('Peer Two');
    expect(joined).not.toMatch(/Who is here/i);
  });

  test('(c) breakpoint budget: exactly one system breakpoint, on the last block', async () => {
    // Breakpoint budget: tools(1) + system(1, here) + durable-message-prefix(1)
    // + message-tail(1). The durable message breakpoint (anthropicMessagePrep)
    // is what lets each run read the message history back from cache.
    const withPrompt = await composeSystemPrompt(turn2());
    const bp = breakpointIndexes(withPrompt);
    expect(bp).toEqual([withPrompt.length - 1]); // threadSystemPrompt is last

    // Without a thread system prompt the single breakpoint lands on the last
    // core block instead — still exactly one, still last.
    const noPrompt = await composeSystemPrompt(
      makeCtx({ agentTools: FULL_TOOLS, participantAgentIds: ['agent-self'] })
    );
    const bp2 = breakpointIndexes(noPrompt);
    expect(bp2).toEqual([noPrompt.length - 1]);
  });

  test('the turn-context tail carries the mode, and does not restate the roster', async () => {
    // The volatile data lives in the tail, not the system prompt. Mode is still
    // restated here because nothing else carries current mode; the roster is
    // not — joins and departures persist as thread_event rows and replay in
    // order, so repeating it every turn would bill for derivable state.
    const data1 = composeTurnContextData({
      ...turn1(),
      runParams: { thread_participants: 'solo', thread_routing: 'all' },
    } as never);
    const data2 = composeTurnContextData({
      ...turn2(),
      runParams: { thread_participants: 'Peer One, Peer Two', thread_routing: 'mentioned' },
    } as never);
    expect(data1).not.toBe(data2);
    expect(data2).toContain('mentioned');
    expect(data2).not.toContain('Peer One, Peer Two');
  });
});
