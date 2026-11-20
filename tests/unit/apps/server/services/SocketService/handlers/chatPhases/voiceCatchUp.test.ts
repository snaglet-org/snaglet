/**
 * buildVoiceCatchUpBlocks — floor-gated generation catch-up content.
 * Folds thread rows that landed while a run was parked into append-only
 * injection blocks, with the right inclusions/exclusions + a monotonic cursor.
 */

import { buildVoiceCatchUpBlocks } from '@server/services/SocketService/handlers/chatPhases/voiceCatchUp';
import type { MessageRow } from '@snaglet/db/tables/messages';

const AGENT_NAMES = new Map([
  ['agent-A', 'Ada'],
  ['agent-B', 'Boron'],
]);

let seq = 0;
function row(overrides: Partial<MessageRow>): MessageRow {
  seq += 1;
  return {
    id: `msg-${seq}`,
    threadId: 'thread-1',
    agentId: null,
    userId: null,
    role: 'user',
    content: 'hello',
    messageType: 'message',
    resolved: false,
    createdAt: `2026-07-05T00:00:0${seq}.000Z`,
    responseOptions: null,
    thinkingContent: null,
    toolActivity: null,
    injectedDuringRun: false,
    usage: null,
    runId: null,
    runError: null,
    contextPacks: null,
    metadata: null,
    ...overrides,
  };
}

describe('buildVoiceCatchUpBlocks', () => {
  it('folds a peer utterance, naming the speaker', () => {
    const { blocks } = buildVoiceCatchUpBlocks(
      [row({ agentId: 'agent-A', role: 'assistant', content: 'Checking the logs.' })],
      { selfAgentId: 'agent-B', agentNameMap: AGENT_NAMES }
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('Ada');
    expect(blocks[0]).toContain('Checking the logs.');
  });

  it('folds a genuine user send as "The user"', () => {
    const { blocks } = buildVoiceCatchUpBlocks(
      [row({ role: 'user', userId: 'u1', content: 'What about the second query?' })],
      { selfAgentId: 'agent-B', agentNameMap: AGENT_NAMES }
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('The user');
    expect(blocks[0]).toContain('What about the second query?');
  });

  it("skips the agent's own rows (already in its context)", () => {
    const { blocks } = buildVoiceCatchUpBlocks(
      [row({ agentId: 'agent-B', role: 'assistant', content: 'my own utterance' })],
      { selfAgentId: 'agent-B', agentNameMap: AGENT_NAMES }
    );
    expect(blocks).toEqual([]);
  });

  it('skips mid-run user injections (owned by the tool-seam peer path)', () => {
    const { blocks } = buildVoiceCatchUpBlocks(
      [row({ role: 'user', userId: 'u1', content: 'mid-run', injectedDuringRun: true })],
      { selfAgentId: 'agent-B', agentNameMap: AGENT_NAMES }
    );
    expect(blocks).toEqual([]);
  });

  it('skips non-conversational rows (thread_event / empty)', () => {
    const { blocks } = buildVoiceCatchUpBlocks(
      [
        row({ messageType: 'thread_event' as MessageRow['messageType'], content: 'voice on' }),
        row({ agentId: 'agent-A', role: 'assistant', content: '   ' }),
      ],
      { selfAgentId: 'agent-B', agentNameMap: AGENT_NAMES }
    );
    expect(blocks).toEqual([]);
  });

  it('folds a question-type utterance', () => {
    const { blocks } = buildVoiceCatchUpBlocks(
      [
        row({
          agentId: 'agent-A',
          role: 'assistant',
          content: 'Should I proceed?',
          messageType: 'question',
        }),
      ],
      { selfAgentId: 'agent-B', agentNameMap: AGENT_NAMES }
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('Should I proceed?');
  });

  it('preserves order and advances the cursor to the last row seen (even if skipped)', () => {
    const first = row({ agentId: 'agent-A', role: 'assistant', content: 'first' });
    const mineSkipped = row({ agentId: 'agent-B', role: 'assistant', content: 'mine' });
    const last = row({ role: 'user', userId: 'u1', content: 'second' });
    const { blocks, cursor } = buildVoiceCatchUpBlocks([first, mineSkipped, last], {
      selfAgentId: 'agent-B',
      agentNameMap: AGENT_NAMES,
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('first');
    expect(blocks[1]).toContain('second');
    // Cursor is the last row overall — so a skipped own-row can never be refolded.
    expect(cursor).toEqual({ createdAt: last.createdAt, id: last.id });
  });

  it('returns a null cursor for an empty batch', () => {
    expect(
      buildVoiceCatchUpBlocks([], { selfAgentId: 'agent-B', agentNameMap: AGENT_NAMES })
    ).toEqual({ blocks: [], cursor: null });
  });
});
