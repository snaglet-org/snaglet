/**
 * The prior-run hint in the order a real turn runs it, on the test cluster.
 *
 * The turn loop creates the new run's row (Runs.create) before it builds the
 * attempt context (prepareModelAttemptContext → buildPriorRunHint). A lookup
 * of "the newest run in the thread" then finds the run starting now and the
 * hint never fires. Here the rows are real and the order is the turn loop's;
 * only the context collaborators that need a model, a replay or a budget are
 * stubbed. The turn-context tail the model would receive must carry the hint.
 */

jest.mock('@server/services/SocketService/handlers/chatPhases/replayLoader', () => ({
  buildReplayPayload: async () => ({
    messages: [{ role: 'user', content: 'pick up where we left off' }],
    watermark: null,
  }),
}));
jest.mock('@server/services/ContextWindowService', () => ({
  resolveContextBudget: async () => ({ maxInputTokens: 100_000, cacheTtl: '1h' }),
  findCurrentRunBoundary: (messages: unknown[]) => messages.length,
}));

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import { Threads } from '@snaglet/db/tables/threads';
import { Agents } from '@snaglet/db/tables/agents';
import { Runs } from '@snaglet/db/tables/runs';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { prepareModelAttemptContext } from '@server/services/SocketService/handlers/chatPhases/contextAssembly';
import { TURN_CONTEXT_SENTINEL } from '@server/services/SystemPromptComposer/composeTurnContextTail';

const THREAD = 'thread-1790000000001-priorhint';
const AGENT = 'agent-priorhint-a';
const OTHER = 'agent-priorhint-b';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startRun(id: string, agentId = AGENT): Promise<void> {
  await Runs.create({ id, threadId: THREAD, agentId, providerId: 'anthropic', model: 'm' });
  await sleep(5); // distinct created_at per row
}

async function logToolCall(runId: string, tool: string, agentId = AGENT): Promise<void> {
  await AgentActivityLog.logActivity({
    agentId,
    runId,
    actionType: 'tool_call',
    triggerType: 'manual',
    tool,
  } as never);
}

/** The tail the model receives for an attempt of run `currentRunId`, as the turn loop builds it. */
async function tailFor(currentRunId: string): Promise<string> {
  const ctx = await prepareModelAttemptContext({
    deps: {
      session: { threadId: THREAD },
      threadId: THREAD,
      isGroup: false,
      participantAgentIds: [AGENT],
      agentNameMap: new Map([[AGENT, 'Prior Agent']]),
      dispatchMode: 'all',
    },
    agent: { id: AGENT, name: 'Prior Agent' },
    runtimeAgent: { id: AGENT, name: 'Prior Agent', systemPrompt: '' },
    agentTools: [],
    executionTools: [],
    advertisedTools: [],
    toolAccess: { mode: 'all', allowList: [], denyList: [] },
    turnContextData: '**Your current coordinates:**\n- Thread: `priorhint`',
    currentRunId,
  } as never);
  const tail = (ctx.agentMessages as Array<{ content: unknown }>).find(
    (m) => typeof m.content === 'string' && m.content.startsWith(TURN_CONTEXT_SENTINEL)
  );
  return (tail?.content as string) ?? '';
}

describe('prior-run hint, real turn order', () => {
  beforeAll(async () => {
    await Threads.create({ id: THREAD, title: 'priorhint' });
    await Agents.create({ id: AGENT, name: 'Prior Agent' } as never);
    await Agents.create({ id: OTHER, name: 'Other Agent' } as never);
  });

  // Nested so it unwinds before the shared database teardown.
  afterAll(async () => {
    await getDb().query(
      'DELETE FROM agent_activity_log WHERE run_id IN (SELECT id FROM runs WHERE thread_id = $1)',
      [THREAD]
    );
    await getDb().query('DELETE FROM runs WHERE thread_id = $1', [THREAD]);
  });

  it('fires after a run cut off by a restart, with the new run row already created', async () => {
    await startRun('run-cut-off');
    await logToolCall('run-cut-off', 'table');
    await Runs.markAllRunningFailed('Server restart');

    // Turn loop order: create the new run's row, then build the attempt context.
    await startRun('run-next-1');
    // Another agent ran in between; it must not hide this agent's own run.
    await startRun('run-other', OTHER);
    await Runs.markCompleted('run-other');

    const tail = await tailFor('run-next-1');

    expect(tail).toContain(
      'Your previous run in this thread was interrupted or failed (Server restart)'
    );
    expect(tail).toContain('run_id "run-cut-off"');
    await Runs.markCompleted('run-next-1');
  });

  it('says nothing after a completed run', async () => {
    await startRun('run-next-2');
    expect(await tailFor('run-next-2')).not.toContain('previous run');
    await Runs.markCompleted('run-next-2');
  });

  it('after the user stopped a run, says so without asking for a redo', async () => {
    await startRun('run-stopped');
    await logToolCall('run-stopped', 'file');
    await Runs.markFailed('run-stopped', 'Aborted by user');
    await startRun('run-next-3');

    const tail = await tailFor('run-next-3');

    expect(tail).toContain('was stopped by the user');
    expect(tail).toContain("Don't resume or redo that work unless asked");
    expect(tail).toContain('run_id "run-stopped"');
  });
});
