import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from '@jest/globals';
import { runModeBlock } from '@server/services/SystemPromptComposer/blocks/runModeBlock';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';
import threadDefinition from '@server/services/ToolService/tools/threads/thread/definition';

const BUILTIN = path.resolve(__dirname, '../../../../../../apps/server/builtin-skills');
/** A built-in skill's catalog line: what the agent reads to decide when to load it. */
function skillDescription(slug: string): string {
  const text = readFileSync(path.join(BUILTIN, slug, 'SKILL.md'), 'utf8');
  return /^description:\s*(.+)$/m.exec(text)?.[1] ?? '';
}

// runModeBlock is roster-independent constant teaching. It does not branch on
// isGroup, dispatchMode, or the peer list — those live in the ephemeral
// turn-context tail (coordinates) and in thread_event narration — so the block
// renders byte-identically regardless of ctx.
function ctx(over: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return {
    runKind: 'realtime_thread',
    isGroup: false,
    participantAgentIds: ['self'],
    replyAgentId: 'self',
    dispatchMode: 'mentioned',
    ...over,
  } as unknown as SystemPromptContext;
}

describe('runModeBlock — constant realtime/routing teaching', () => {
  it('teaches the routing modes and the @-mention mechanics', async () => {
    const text = (await runModeBlock(ctx()))!.text;
    expect(text).toContain('## Threads and handoffs\nYou are in a live thread');
    expect(text).toContain(
      '- **Routing modes.** In `mentioned` mode, tag a participant who needs to act; an untagged reply does not wake them, and a bare name is silent. In `all` mode, replies reach all participants. Untagged messages remain in thread history.'
    );
    // Reaching someone never means changing the user's routing setting.
    expect(text).toContain(
      "To reach someone, tag them; don't change the thread's routing mode to do it."
    );
    expect(text).toContain('Handing off');
    expect(text).toContain('Ending your turn');
  });

  it('keeps the routing line short and leaves skill pointers to the catalog', async () => {
    const text = (await runModeBlock(ctx()))!.text;
    const routing = text.split('\n').find((l) => l.startsWith('- **Routing modes.**')) ?? '';
    expect(routing.length).toBeLessThan(420);
    expect(text).not.toMatch(
      /snaglet-agent-collab|snaglet-group-threads|snaglet-other-threads|snaglet-dms/
    );
  });

  it('says to post only when there is something new', async () => {
    const text = (await runModeBlock(ctx()))!.text;
    expect(text).toContain('Post only when you have something new; never a "still waiting" post.');
    const dm = (await runModeBlock(ctx({ isDm: true })))!.text;
    expect(dm).toContain('Post only when you have something new; never a "still waiting" post.');
  });

  it('is the single home of the no-fabricated-wakes rule: a claim needs the delivering action', async () => {
    const text = (await runModeBlock(ctx()))!.text;
    expect(text).toContain('there is no separate wake tool');
    expect(text).toContain(
      'Claim a notification or handoff only after performing the action that delivers it. Posting proves delivery was initiated, not that the recipient read, accepted or completed the work.'
    );
  });

  it('leaves the bring-in, take-out and handoff procedures to the group-threads skill', async () => {
    // Delivery facts stay here; how to collaborate is the skill's (its catalog
    // line says when to load it) and the ops are the thread tool's description.
    const text = (await runModeBlock(ctx({ agentTools: [{ tool: { id: 'thread' } }] } as never)))!
      .text;
    for (const moved of [
      'keep the room small',
      'add_agents',
      'remove_agents',
      '`leave`',
      'Please take over',
      'Done when:',
    ]) {
      expect({ moved, found: text.includes(moved) }).toEqual({ moved, found: false });
    }
    const skill = readFileSync(path.join(BUILTIN, 'snaglet-group-threads', 'SKILL.md'), 'utf8');
    for (const kept of ['`add_agents`', '`remove_agents`', '`leave`'])
      expect(skill).toContain(kept);
    expect(skillDescription('snaglet-group-threads')).toContain(
      'bring an agent in or take one out'
    );
  });

  it('has no blank line after a heading', async () => {
    for (const over of [{}, { isDm: true }, { agent: { parentAgentId: 'agent-orchestrator' } }]) {
      const text = (await runModeBlock(ctx(over as never)))!.text;
      expect(text).not.toMatch(/^#+ .*\n\n/m);
    }
  });

  it('points at the turn context for who-is-here and the active mode, not a rendered peer list', async () => {
    const text = (await runModeBlock(ctx()))!.text;
    expect(text).toContain('your turn context');
  });

  it('renders byte-identically across roster / dispatch-mode variation (cache-stable)', async () => {
    const solo = (await runModeBlock(ctx({ isGroup: false, dispatchMode: 'mentioned' })))!.text;
    const group = (await runModeBlock(
      ctx({
        isGroup: true,
        dispatchMode: 'all',
        participantAgentIds: ['self', 'peer-1', 'peer-2'],
      })
    ))!.text;
    expect(solo).toBe(group);
  });
});

describe('runModeBlock — thread skills are found through their catalog lines', () => {
  it('the collaboration catalog lines say when to load each, so the block does not repeat them', () => {
    expect(skillDescription('snaglet-agent-collab')).toContain("need another agent's help");
    expect(skillDescription('snaglet-group-threads')).toContain('in a thread with other agents');
    expect(skillDescription('snaglet-other-threads')).toContain('another thread');
    expect(skillDescription('snaglet-dms')).toContain('before you DM');
    expect(skillDescription('snaglet-dms')).toContain('unread DMs');
  });

  it('the thread tool description names the DM ops and their skill', () => {
    expect(threadDefinition.description).toContain('dm_*: private DMs (snaglet-dms skill)');
  });

  it('stays identical for solo and group contexts (cache-stable)', async () => {
    const a = (await runModeBlock({ isGroup: false } as never)) as { text: string };
    const b = (await runModeBlock({ isGroup: true } as never)) as { text: string };
    expect(a.text).toBe(b.text);
  });
});

describe('runModeBlock — DM / home thread', () => {
  it('says nothing about this thread routing or in-thread handoffs', async () => {
    const text = (await runModeBlock(ctx({ isDm: true, dispatchMode: 'mentioned' })))!.text;
    expect(text).not.toMatch(/snaglet-group-threads|handoff|Routing modes|in your reply wakes/i);
    expect(text).not.toMatch(/this thread.{0,40}(routing|mode)/i);
  });

  it('says the reply goes to the user and names no routing mode or @-tag', async () => {
    // Reaching agents in another thread (its routing, @-tags) is snaglet-other-threads.
    const text = (await runModeBlock(ctx({ isDm: true })))!.text;
    expect(text).toContain('between you and the user: your reply is the message and goes to them');
    expect(text).not.toMatch(/routing|`mentioned`|`all`|`@`-tag|broadcast/i);
  });

  it('leaves the thread ops to the thread tool description and the skill to its catalog line', async () => {
    const text = (await runModeBlock(ctx({ isDm: true })))!.text;
    expect(text).not.toMatch(/snaglet-agent-collab|snaglet-other-threads|snaglet-dms|dm_send/);
    for (const op of ['read (', 'create (', 'send (']) {
      expect(threadDefinition.description).toContain(op);
    }
  });

  it('is constant across DM threads (cache-stable)', async () => {
    const a = (await runModeBlock(ctx({ isDm: true, dispatchMode: 'all' })))!.text;
    const b = (await runModeBlock(ctx({ isDm: true, dispatchMode: 'mentioned' })))!.text;
    expect(a).toBe(b);
  });
});

describe('runModeBlock — the same text with or without the thread tool', () => {
  const tool = (id: string) => ({ tool: { id } });

  it('does not vary with the thread tool or a helper thread (cache-stable)', async () => {
    const base = (await runModeBlock(ctx({ agentTools: [tool('search')] } as never)))!.text;
    for (const over of [
      { agentTools: [tool('search'), tool('thread')] },
      { agentTools: [tool('search'), tool('thread')], isHelperThread: true },
      {
        agentTools: [tool('search'), tool('thread')],
        isGroup: true,
        dispatchMode: 'all',
        participantAgentIds: ['self', 'peer-1', 'peer-2'],
      },
    ]) {
      expect((await runModeBlock(ctx(over as never)))!.text).toBe(base);
    }
  });

  it('names only thread ops and fields that exist', async () => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/threads/thread/definition');
    const props = definition.parameters_schema.properties as Record<string, { enum?: string[] }>;
    expect(props.op?.enum).toEqual(expect.arrayContaining(['send']));
  });
});

describe('runModeBlock — helper (subagent) runs', () => {
  const helperCtx = (over: Partial<SystemPromptContext> = {}) =>
    ctx({
      agent: { id: 'subagent-1', parentAgentId: 'agent-orchestrator' },
      agentTools: [{ tool: { id: 'thread' } }],
      ...over,
    } as never);

  it('drops routing, handoff, room and DM guidance a helper cannot act on', async () => {
    const text = (await runModeBlock(helperCtx()))!.text;
    expect(text).toContain('## Your thread');
    for (const absent of [
      'Routing modes',
      'Handing off',
      'keep the room small',
      'dm_send',
      'snaglet-agent-collab',
      'snaglet-dms',
    ]) {
      expect(text).not.toContain(absent);
    }
  });

  it('keeps the no-fabricated-wakes rule and finishing what it announces', async () => {
    const text = (await runModeBlock(helperCtx()))!.text;
    expect(text).toContain('never claim you woke, notified or handed work to anyone');
    expect(text).toContain("Don't end by saying you are about to do something");
  });

  it('is byte-identical across roster and mode changes (cache-stable)', async () => {
    const a = (await runModeBlock(helperCtx({ isGroup: false, dispatchMode: 'all' })))!.text;
    const b = (await runModeBlock(helperCtx({ isGroup: true, dispatchMode: 'mentioned' })))!.text;
    expect(a).toBe(b);
  });
});
