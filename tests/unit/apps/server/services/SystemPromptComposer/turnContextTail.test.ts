/**
 * Turn-context tail — the per-turn ephemeral message that carries what would
 * otherwise be volatile system-prompt fragments.
 *
 * Guarantees under test:
 *   - it is deterministic given (ctx, extras) — same inputs, same bytes,
 *   - it is clearly delimited as out-of-record (so it is never mistaken for
 *     user speech and never persisted/replayed),
 *   - it renders the per-turn data (coordinates, project scope, soft-threshold,
 *     prior-run hint, pane layout) that stays out of the system prompt,
 *   - it collapses to null when there is genuinely nothing to say.
 */

import {
  composeAutomationWakeNote,
  composeTurnContextData,
  composeTurnContextTail,
  buildTurnContextMessage,
  TURN_CONTEXT_HEADER,
} from '@server/services/SystemPromptComposer/composeTurnContextTail';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';

function ctx(over: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return {
    replyAgentId: 'agent-self',
    runParams: {
      host_path: '/snaglet/host',
      thread_path: '/Snaglet/projects/vega/threads',
      thread_title: 'Rollout planning',
      thread_routing: 'all',
      thread_participants: 'Peer One, Peer Two',
      project_name: 'Vega',
      project_folder_path: '/repos/vega',
      project_gitrepo: 'git@example.com:snaglet/vega.git',
      parent_project_name: 'Snaglet',
    },
    embeddingsEnabled: true,
    agentSoftThresholdNotified: new Set<string>(),
    agentDispatchCount: new Map<string, number>(),
    ...over,
  } as unknown as SystemPromptContext;
}

describe('composeTurnContextData', () => {
  it('is deterministic — identical ctx → byte-identical output', () => {
    expect(composeTurnContextData(ctx())).toBe(composeTurnContextData(ctx()));
  });

  it('renders the per-turn coordinate + project data kept out of the system prompt', () => {
    const text = composeTurnContextData(ctx());
    expect(text).toContain('Your current coordinates');
    expect(text).toContain('/Snaglet/projects/vega/threads');
    // The roster is not restated here — joins/departures persist as
    // thread_event rows and replay in order, so re-billing it every wake
    // adds nothing the transcript does not already carry.
    expect(text).not.toContain('Peer One, Peer Two');
    expect(text).toContain('Project scope: `Vega`');
    expect(text).toContain('/repos/vega');
    expect(text).toContain('parent project: `Snaglet`');
  });

  it('prints the current thread id next to its title', () => {
    const text = composeTurnContextData(ctx({ threadId: 'thread-123-abc' } as never));
    expect(text).toContain('- Thread: `Rollout planning` (thread-123-abc)');
  });

  it('prints the bare id when the title is missing, and nothing extra without an id', () => {
    const untitled = composeTurnContextData(
      ctx({ threadId: 'thread-123-abc', runParams: { host_path: '/snaglet/host' } } as never)
    );
    expect(untitled).toContain('- Thread: thread-123-abc');
    expect(composeTurnContextData(ctx())).toContain('- Thread: `Rollout planning`\n');
  });

  it('includes the soft-threshold nudge only when the agent is over budget', () => {
    const notified = ctx({
      agentSoftThresholdNotified: new Set(['agent-self']),
      agentDispatchCount: new Map([['agent-self', 5]]),
    });
    expect(composeTurnContextData(notified)).toContain('responded 5 times');
    expect(composeTurnContextData(ctx())).not.toContain('responded');
  });

  it('degrades gracefully when coordinates cannot be resolved', () => {
    const bare = composeTurnContextData(
      ctx({ runParams: { host_path: '/snaglet/host' } } as never)
    );
    expect(bare).toContain('/snaglet/host');
    expect(bare).toContain('could not be resolved');
  });

  it('includes the voice profile block only when voiceModeActive', () => {
    // Off (default): no voice profile — keeps the cache-stability guarantee, since
    // the block rides the tail only while a voice session is active.
    expect(composeTurnContextData(ctx())).not.toContain('Voice mode is ON');
    // On: the compact behavior block appears.
    const withVoice = composeTurnContextData(ctx({ voiceModeActive: true }));
    expect(withVoice).toContain('Voice mode is ON');
    expect(withVoice).toContain('1-3 sentences');
    expect(withVoice).toContain('@Name');
    // Replies are already spoken, so playing speech yourself (shell `say`,
    // text_to_speech) is off-limits in voice mode.
    expect(withVoice).toContain('spoken aloud automatically');
    expect(withVoice).toContain('say');
    // Off state carries neither the block nor the say-tool line.
    expect(composeTurnContextData(ctx())).not.toContain('spoken aloud automatically');
  });

  it('stays deterministic with the voice block on', () => {
    expect(composeTurnContextData(ctx({ voiceModeActive: true }))).toBe(
      composeTurnContextData(ctx({ voiceModeActive: true }))
    );
  });
});

describe('buildTurnContextMessage / composeTurnContextTail', () => {
  it('wraps content behind the out-of-record delimiter as a user message', () => {
    const msg = composeTurnContextTail(ctx(), ['[System note: Your previous run completed.]']);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('user');
    expect(msg!.content.startsWith(TURN_CONTEXT_HEADER)).toBe(true);
    expect(msg!.content).toContain('not part of the conversation record');
    expect(msg!.content).toContain('Your previous run completed');
  });

  it('splices async extras (prior-run hint, pane layout) after the sync data', () => {
    const msg = buildTurnContextMessage([
      composeTurnContextData(ctx()),
      '[System note: prior run hint]',
      '[Pane layout: viewing Vega overview]',
    ]);
    expect(msg!.content).toContain('prior run hint');
    expect(msg!.content).toContain('Pane layout');
  });

  it('returns null when every segment is empty (no phantom tail)', () => {
    expect(buildTurnContextMessage([null, undefined, '', '   '])).toBeNull();
  });

  it('carries no persistence identity — it is an in-memory, out-of-record message', () => {
    // The shape carries no persistence fields: no id, no runId, no message_type.
    // It is pushed onto the in-memory turn payload and never written via
    // Messages.create, so it cannot appear in the next turn's replay. The
    // `ephemeral` flag is an in-memory cache-routing marker (it is what keeps
    // this block out of the durable cache prefix), not a persistence identity.
    const msg = composeTurnContextTail(ctx());
    expect(Object.keys(msg!).sort()).toEqual(['content', 'ephemeral', 'role']);
    expect(msg!.ephemeral).toBe(true);
  });
});

describe('composeAutomationWakeNote', () => {
  it('tells the woken agent the turn is its scheduled task, to do now and answer in its reply', () => {
    const note = composeAutomationWakeNote({ name: 'Check backlog', scheduledByYou: true });
    expect(note).toBe(
      'This turn was started by the automation "Check backlog" (scheduled by you), not by someone typing, and nobody is waiting live. Carry out its prompt now and answer in your reply here, not in a separate message.'
    );
    const msg = composeTurnContextTail(ctx(), [note]);
    expect(msg!.content).toContain('started by the automation "Check backlog"');
  });

  it('names a person as the scheduler when the agent did not create it', () => {
    expect(composeAutomationWakeNote({ name: 'Morning check', scheduledByYou: false })).toContain(
      '(scheduled by a person)'
    );
  });

  it('is absent for a turn no automation started', () => {
    expect(composeAutomationWakeNote(null)).toBeNull();
    expect(composeTurnContextTail(ctx())!.content).not.toContain('automation');
  });
});

describe('composeTurnContextData — working folder', () => {
  const folder = (source?: string) =>
    composeTurnContextData(
      ctx({ runParams: { host_path: '/snaglet/host', host_path_source: source } } as never)
    );

  it('says where the working folder comes from', () => {
    expect(folder('project')).toContain(
      "- Working folder: `/snaglet/host` (this project's linked folder"
    );
    expect(folder('thread')).toContain('set for this thread');
    expect(folder('home')).toContain('Snaglet home, because this thread has no project folder');
  });

  it('leaves "shell and file start here" to the cached system prompt', () => {
    expect(folder('project')).toBe(
      "**Your current coordinates:**\n- Working folder: `/snaglet/host` (this project's linked folder)\n- Thread coordinates could not be resolved this turn; call `orient` if you need them."
    );
  });

  it('still shows the folder when the source is unknown', () => {
    expect(folder()).toContain('- Working folder: `/snaglet/host`');
    expect(folder()).not.toContain('Host machine');
  });
});
