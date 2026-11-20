/**
 * Crash-recovery baseline (real managed PostgreSQL). Recovery is one call,
 * `Runs.markAllRunningFailed('Server restart')` in `runBackgroundInit()`, fired
 * after the HTTP port is listening: every `status='running'` row becomes
 * `failed`, and nothing resumes the interrupted turn. This suite pins that at
 * the three points the turn loop can be interrupted after the inbound message
 * is persisted.
 *
 * The crash is simulated in-process, not with SIGKILL: there is no seam to stub
 * a child server's model call. Message persistence, run bookkeeping and the
 * tool-call phase are real production calls; only the turn-loop glue between
 * them is hand-sequenced, and the provider call is a jest.fn(). The Jest
 * process never dies, so fire-and-forget writes (activity log, embedding sync)
 * always settle here: phase (c) is the best case.
 */

import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const sendToClient = jest.fn();
const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    sendToClient: (...a: unknown[]) => sendToClient(...a),
    broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
    registerHandler: jest.fn(),
  },
}));

// Entry seam only (matches persistFirstMidRun.test.ts): processChatSend must
// persist the message and return without a fully-resolved runtime agent. The
// turn itself is hand-sequenced below via the real Runs/toolExecutor calls.
const dispatchToThreadInternal = jest.fn(async () => ({
  ok: true as const,
  wakeCount: 1,
  capHit: false,
  reason: 'completed' as const,
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThreadInternal: (...a: unknown[]) => dispatchToThreadInternal(...a),
  dispatchToThread: jest.fn(),
  redispatchPersistedMessage: jest.fn(async () => undefined),
}));

import { getDb, getDbClient, Messages, Threads, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Runs } from '@snaglet/db/tables/runs';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { Memories } from '@snaglet/db/tables/memories';
import { Tools } from '@snaglet/db/tables/tools';
import { ensureBuiltinCatalog } from '@snaglet/db/migrations';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { processChatSend } from '@server/services/SocketService/handlers/chatHandlers';
import { setSession } from '@server/services/SocketService/store';
import { runWithRunContext } from '@server/realtime/runContext';
import { toolExecutor, toolRegistry } from '@server/services/ToolService';

const PREFIX = 'crash-recovery-it';
const AGENT_ID = `agent-${PREFIX}`;
const THREAD_A = `thread-${PREFIX}-a`;
const THREAD_B = `thread-${PREFIX}-b`;
const THREAD_C = `thread-${PREFIX}-c`;
const SESSION_A = `session-${PREFIX}-a`;
const SESSION_B = `session-${PREFIX}-b`;
const SESSION_C = `session-${PREFIX}-c`;
const THREAD_IDS = [THREAD_A, THREAD_B, THREAD_C];

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM agent_activity_log WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM memories WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM runs WHERE thread_id = ANY($1::text[])`, [THREAD_IDS]);
  await pool.query(`DELETE FROM messages WHERE thread_id = ANY($1::text[])`, [THREAD_IDS]);
  await pool.query(`DELETE FROM thread_participants WHERE thread_id = ANY($1::text[])`, [
    THREAD_IDS,
  ]);
  await pool.query(`DELETE FROM threads WHERE id = ANY($1::text[])`, [THREAD_IDS]);
  await pool.query(`DELETE FROM agents WHERE id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM nodes WHERE id = ANY($1::text[]) OR id LIKE $2`, [
    THREAD_IDS,
    'message-%',
  ]);
}

/** Persist the trigger message through the real handler; returns its id via
 *  the same callback the voice layer uses (chatHandlers.ts onUserMessagePersisted). */
async function sendTrigger(sessionId: string, message: string): Promise<string> {
  let messageId = '';
  await processChatSend(
    { sessionId, message },
    {
      clientId: 'client-1',
      onUserMessagePersisted: (id) => {
        messageId = id;
      },
    }
  );
  expect(messageId).not.toBe('');
  return messageId;
}

/** The fields turnLoop.ts writes when it starts a run, reproduced here (not
 *  imported) since the real loop is not driven. */
async function startRun(threadId: string): Promise<string> {
  const runId = randomUUID();
  await Runs.create({
    id: runId,
    threadId,
    agentId: AGENT_ID,
    providerId: 'anthropic',
    model: 'claude-fixture',
  });
  activeRunTracker.start(runId);
  return runId;
}

/** Assert the shared baseline: the run died, nobody resumed it,
 *  and the trigger message is the only thing in the thread. */
async function expectNoResumeAfterRecovery(threadId: string, runId: string): Promise<void> {
  const marked = await Runs.markAllRunningFailed('Server restart');
  expect(marked).toBeGreaterThanOrEqual(1);

  const runs = await Runs.listByThreadId(threadId);
  expect(runs).toHaveLength(1); // no second "resumed" run was ever created
  expect(runs[0]!.id).toBe(runId);
  expect(runs[0]!.status).toBe('failed');
  expect(runs[0]!.error).toBe('Server restart');
  expect(runs[0]!.finishedAt).not.toBeNull();

  // Nothing correlates a run back to the message it answered: `runs` has no
  // trigger_message_id column. Re-adding one without writing it would suggest
  // a correlation that does not exist.
  const { rows } = await getDb().query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'runs'
          AND column_name = 'trigger_message_id'
     ) AS present`
  );
  expect(rows[0]!.present).toBe(false);

  const messages = await Messages.listByThreadId(threadId);
  expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
}

beforeAll(async () => {
  await cleanup();
  await ensureBuiltinCatalog(await getDbClient());
  // `ensureBuiltinCatalog` seeds providers/models/mcp_servers only — the
  // `tools` table (memory_store included) is populated by the separate
  // registry-sync boot step (index.ts), reproduced here.
  await toolRegistry.load();
  await toolRegistry.syncToDatabase();
  await Users.getOrCreateLocalUser();
  await Agents.create({ id: AGENT_ID, name: `${PREFIX}-agent` });
  for (const [threadId, sessionId] of [
    [THREAD_A, SESSION_A],
    [THREAD_B, SESSION_B],
    [THREAD_C, SESSION_C],
  ] as const) {
    await Threads.create({ id: threadId, title: `${PREFIX} ${threadId}` });
    await ThreadParticipants.addParticipant({ threadId, agentId: AGENT_ID });
    await setSession({
      id: sessionId,
      agentId: AGENT_ID,
      threadId,
      participantAgentIds: [AGENT_ID],
      createdAt: Date.now(),
    });
  }
}, 30_000);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('crash-recovery baseline (current behavior — resume does not exist)', () => {
  // Inside the describe so it runs before the shared closeDatabase() teardown; getDbClient() throws after close.
  afterAll(async () => {
    activeRunTracker.finishSession(SESSION_A);
    activeRunTracker.finishSession(SESSION_B);
    activeRunTracker.finishSession(SESSION_C);
    await cleanup();
  });

  it('phase (a) — crash before the provider call: run wedges at status=running, then the boot sweep fails it, nothing resumes', async () => {
    await sendTrigger(SESSION_A, 'phase a trigger');
    const runId = await startRun(THREAD_A);

    const providerComplete = jest.fn();
    // The crash lands here — after Runs.create() committed, before the
    // process ever reaches the model call. No graceful cleanup runs: no
    // markFailed, no activeRunTracker.finish (a real crash skips both).

    expect(providerComplete).not.toHaveBeenCalled();
    await expectNoResumeAfterRecovery(THREAD_A, runId);
  });

  it('phase (b) — crash mid-stream: identical DB outcome to phase (a) — streamed chunks are broadcast-only, never persisted', async () => {
    await sendTrigger(SESSION_B, 'phase b trigger');
    const runId = await startRun(THREAD_B);

    // Mirrors streamModelCall (llmStream.ts): visible text arrives via
    // a callback and is broadcast over socket:delta as it streams — nothing
    // per-chunk ever touches the DB. The provider promise itself hangs
    // forever (a real process death mid-network-call never resolves it).
    const providerComplete = jest.fn(() => {
      broadcastToChannel(THREAD_B, {
        type: 'socket:delta',
        payload: { sessionId: SESSION_B, runId, text: 'Thinking through the ' },
      });
      broadcastToChannel(THREAD_B, {
        type: 'socket:delta',
        payload: { sessionId: SESSION_B, runId, text: 'request...' },
      });
      return new Promise(() => {});
    });
    void providerComplete(); // never awaited — matches an abandoned in-flight call

    expect(providerComplete).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).toHaveBeenCalledWith(
      THREAD_B,
      expect.objectContaining({ type: 'socket:delta' })
    );

    // Despite the client having seen partial output, the DB-level baseline
    // is identical to phase (a): same run-failure outcome, same
    // "no assistant message ever landed" — there is no persisted trace of the
    // partial stream to distinguish the two crash points.
    await expectNoResumeAfterRecovery(THREAD_B, runId);
  });

  it("phase (c) — crash after a mutation tool returns but before final persistence: the tool's write and its activity-log row outlive the run that authorized them", async () => {
    await sendTrigger(SESSION_C, 'phase c trigger');
    const runId = await startRun(THREAD_C);

    const memoryTool = await Tools.findById('memory');
    expect(memoryTool).not.toBeNull();

    // Real ToolExecutor.execute → real memory_store handler → real
    // MemoryService.store → real Memories.create, exactly as toolDispatch.ts
    // invokes it (same context/runWithRunContext shape).
    const execResult = await runWithRunContext({ threadId: THREAD_C, runId }, () =>
      toolExecutor.execute(
        {
          // An old alias, resolved to memory(op:create) by the executor.
          name: 'memory_store',
          input: { key: 'crash-c-lesson', content: 'lesson learned mid-turn' },
        },
        { agentId: AGENT_ID, tool: memoryTool!, settings: {}, requiresConfirmation: false },
        { agentId: AGENT_ID, threadId: THREAD_C }
      )
    );
    expect(execResult.success).toBe(true);

    // toolDispatch.ts logs this fire-and-forget (`.catch(...)`, never
    // awaited) — awaited here so the assertion below reflects the best case
    // (see file header: a real SIGKILL could still lose this write).
    await AgentActivityLog.logActivity({
      agentId: AGENT_ID,
      runId,
      actionType: 'tool_call',
      triggerType: 'chat_nudge',
      reason: 'Tool call: memory_store',
      tool: 'memory_store',
      toolInput: { key: 'crash-c-lesson', content: 'lesson learned mid-turn' },
      toolOutput: { output: execResult.output },
      durationMs: execResult.durationMs,
    });

    // The crash lands here: the model was never asked for iteration 2, so
    // finalReply.ts's persistUtterance + Runs.markCompleted never run.

    const memoryRow = await Memories.findByKey(AGENT_ID, 'crash-c-lesson');
    expect(memoryRow).not.toBeNull();
    expect(memoryRow!.content).toBe('lesson learned mid-turn');

    const activity = await AgentActivityLog.getByRunId(runId);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.actionType).toBe('tool_call');
    expect(activity[0]!.tool).toBe('memory_store');

    await expectNoResumeAfterRecovery(THREAD_C, runId);

    // Recovery flips the run and confirms no reply — but it does not touch
    // (let alone roll back) the tool's already-committed side effect. The
    // user is left with a mutated workspace and no acknowledgment that the
    // turn which caused it never finished.
    const memoryRowAfter = await Memories.findByKey(AGENT_ID, 'crash-c-lesson');
    expect(memoryRowAfter).not.toBeNull();
  });
});
