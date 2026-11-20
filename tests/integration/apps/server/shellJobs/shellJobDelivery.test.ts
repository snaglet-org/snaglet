/**
 * Background shell jobs against the real database and real short-lived child
 * processes, with dispatch stubbed (no model calls):
 *
 * - a job still running past its start window gets an agent-private start
 *   row; when it exits, an end row with the exit code, run time and output
 *   tail, and its idle agent is woken once for it;
 * - an agent running in the thread gets the report mid-run instead (no wake);
 *   if that run ends before reading it, the agent is woken;
 * - a run the agent has while the wake waits for a busy thread reads the row
 *   from replay and cancels the wake;
 * - archiving the agent kills its jobs, with an end row and no wake;
 * - boot recovery turns a start row without an end row into a "lost" row and
 *   a wake, once, and leaves rows another machine's server owns alone.
 */
import os from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

type DispatchInput = { threadId: string; targetAgentId?: string; messageId?: string };
const mockDispatch = jest.fn(async (_input: DispatchInput) => ({
  ok: true,
  reason: 'completed',
  wakeCount: 1,
  capHit: false,
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@server/services/SocketService/dispatch/dispatchToThread'
  ),
  dispatchToThread: (input: DispatchInput) => mockDispatch(input),
}));

import { Agents, Messages, Threads, ThreadParticipants, getDb, type MessageRow } from '@snaglet/db';
import { SHELL_JOB_ENDED_EVENT_KIND, SHELL_JOB_STARTED_EVENT_KIND } from '@snaglet/shared/types';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { agentService } from '@server/services/AgentService';
import { hooks } from '@server/services/HookService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { drainInjectablePeerMessages } from '@server/services/SocketService/handlers/chatPhases/peerInjection';
import { shellJobService } from '@server/services/shellJobs/ShellJobService';
import {
  getShellSession,
  killAllShellSessions,
} from '@server/services/ToolService/tools/shell/codex-shell-sessions';
import shellRun from '@server/services/ToolService/tools/shell/shellRun';

const AGENT = 'test-agent-a';
const PEER = 'test-agent-b';
const THREAD = 'thread-1111111111111-shelljoba';
const node = `"${process.execPath}"`;
const ctx = { threadId: THREAD, agentId: AGENT, cwd: os.tmpdir() };

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out; last ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function jobRows(kind: string): Promise<MessageRow[]> {
  const rows = await Messages.listByThreadId(THREAD);
  return rows.filter((row) => row.metadata?.event_kind === kind);
}

async function endRowFor(sessionId: number): Promise<MessageRow> {
  const rows = await waitFor(
    () => jobRows(SHELL_JOB_ENDED_EVENT_KIND),
    (list) => list.some((row) => row.metadata?.shell_session_id === sessionId)
  );
  return rows.find((row) => row.metadata?.shell_session_id === sessionId)!;
}

/** Starts a background job that prints, waits `ms`, prints again and exits 0. */
async function startJob(ms: number, agentId = AGENT): Promise<number> {
  const out = String(
    await shellRun(
      {
        cmd: `${node} -e "console.log('working'); setTimeout(() => console.log('job done'), ${ms})"`,
        background: true,
        yield_time_ms: 250,
      },
      {},
      { ...ctx, agentId }
    )
  );
  const id = Number(/session ID (\d+)/.exec(out)?.[1]);
  expect(id).toBeGreaterThan(0);
  return id;
}

function wakes() {
  return mockDispatch.mock.calls.map(([input]) => input);
}

/** Pretend `agentId` is running in the thread (what the turn loop registers). */
function runAs(agentId: string, runId: string): () => void {
  const session = `test-session-${runId}`;
  expect(activeRunTracker.startSession(session, THREAD)).toBe(true);
  activeWorkRegistry.registerThreadRun({
    id: runId,
    agentId,
    agentName: agentId,
    threadId: THREAD,
    threadTitle: 'Shell jobs',
  });
  return () => {
    activeWorkRegistry.unregister(runId);
    activeRunTracker.finishSession(session);
  };
}

beforeAll(async () => {
  await Agents.create({ id: AGENT, name: 'Test Agent A' });
  await Agents.create({ id: PEER, name: 'Test Agent B' });
  await Threads.create({ id: THREAD, title: 'Shell jobs' });
  await ThreadParticipants.addParticipant({ threadId: THREAD, agentId: AGENT });
  await ThreadParticipants.addParticipant({ threadId: THREAD, agentId: PEER });
  shellJobService.init({ recoverAfterRestart: false });
});

afterAll(() => {
  killAllShellSessions();
  shellJobService.shutdown();
});

beforeEach(() => {
  mockDispatch.mockClear();
  mockDispatch.mockImplementation(async () => ({
    ok: true,
    reason: 'completed',
    wakeCount: 1,
    capHit: false,
  }));
  shellJobService.resetForTests();
});

describe('background shell jobs (real DB)', () => {
  it('records the start, reports the exit with the output tail, and wakes the idle agent once', async () => {
    const id = await startJob(400);
    const [start] = await jobRows(SHELL_JOB_STARTED_EVENT_KIND);
    expect(start).toMatchObject({ messageType: 'thread_event', visibleToAgentId: AGENT });
    expect(start!.content).toMatch(
      new RegExp(`^\\[shell job ${id} started in the background · killed after 2 h\\] `)
    );
    expect(start!.metadata).toMatchObject({
      shell_session_id: id,
      shell_host: os.hostname(),
      shell_server_pid: process.pid,
    });

    const end = await endRowFor(id);
    expect(end.visibleToAgentId).toBe(AGENT);
    expect(end.metadata?.shell_job_id).toBe(start!.metadata?.shell_job_id);
    expect(end.content).toMatch(new RegExp(`^\\[shell job ${id} finished · exit 0 · ran `));
    expect(end.content).toContain('job done');

    await waitFor(
      async () => wakes(),
      (list) => list.length > 0
    );
    await new Promise((r) => setTimeout(r, 1_200));
    expect(wakes()).toEqual([
      expect.objectContaining({ threadId: THREAD, targetAgentId: AGENT, messageId: end.id }),
    ]);
  }, 20_000);

  it('a running agent gets the report mid-run, and no wake', async () => {
    const done = runAs(AGENT, 'run-shell-mid-1');
    try {
      const id = await startJob(300);
      const end = await endRowFor(id);
      await waitFor(
        async () => pendingAgentMessages.listUnread(THREAD, AGENT).map((m) => m.sourceMessageId),
        (ids) => ids.includes(end.id)
      );
      const injected = drainInjectablePeerMessages({
        threadId: THREAD,
        agentId: AGENT,
        mode: 'mentioned',
      });
      expect(injected.some((text) => text.startsWith(`[shell job ${id} finished`))).toBe(true);
      hooks.emit('run:end', {
        runId: 'run-shell-mid-1',
        agentId: AGENT,
        threadId: THREAD,
        status: 'completed',
      });
    } finally {
      done();
    }
    await new Promise((r) => setTimeout(r, 1_200));
    expect(wakes()).toEqual([]);
  }, 20_000);

  it('a run that ends before reading the report hands it to a wake', async () => {
    const done = runAs(AGENT, 'run-shell-mid-2');
    let endId = '';
    try {
      const id = await startJob(300);
      endId = (await endRowFor(id)).id;
      await waitFor(
        async () => pendingAgentMessages.listUnread(THREAD, AGENT).map((m) => m.sourceMessageId),
        (ids) => ids.includes(endId)
      );
    } finally {
      done();
    }
    hooks.emit('run:end', {
      runId: 'run-shell-mid-2',
      agentId: AGENT,
      threadId: THREAD,
      status: 'completed',
    });
    // The queued copy is dropped (the woken run reads the row from replay).
    expect(
      pendingAgentMessages.listUnread(THREAD, AGENT).map((m) => m.sourceMessageId)
    ).not.toContain(endId);
    const list = await waitFor(
      async () => wakes(),
      (calls) => calls.length > 0
    );
    expect(list).toEqual([expect.objectContaining({ targetAgentId: AGENT, messageId: endId })]);
  }, 20_000);

  it('a run the agent has while the thread is busy reads the row; the wake is canceled', async () => {
    const peerRun = runAs(PEER, 'run-shell-peer-1');
    try {
      const id = await startJob(300);
      await endRowFor(id);
      // Let the service hand the report to its idle wait (it does once the row is written).
      await new Promise((r) => setTimeout(r, 300));
      // The peer holds the thread; the agent is then dispatched in the same wave.
      hooks.emit('run:end', {
        runId: 'run-shell-own-1',
        agentId: AGENT,
        threadId: THREAD,
        status: 'completed',
      });
    } finally {
      peerRun();
    }
    await new Promise((r) => setTimeout(r, 2_000));
    expect(wakes()).toEqual([]);
  }, 20_000);

  it('archiving the agent kills its job, with an end row and no wake', async () => {
    const out = String(
      await shellRun(
        { cmd: `${node} -e "setInterval(() => {}, 30000)"`, background: true, yield_time_ms: 250 },
        {},
        { ...ctx, agentId: PEER }
      )
    );
    const id = Number(/session ID (\d+)/.exec(out)?.[1]);
    expect(getShellSession(id)?.background).toBe(true);
    await agentService.archive(PEER);
    try {
      const end = await endRowFor(id);
      expect(end.content).toContain('killed: its agent was archived or deleted');
      await new Promise((r) => setTimeout(r, 1_200));
      expect(wakes()).toEqual([]);
    } finally {
      await agentService.restore(PEER);
    }
  }, 20_000);

  describe('boot recovery', () => {
    async function startRow(over: Record<string, unknown>) {
      return Messages.createEvent({
        threadId: THREAD,
        content: '[shell job 41 started in the background · killed after 2 h] npm run build',
        eventKind: SHELL_JOB_STARTED_EVENT_KIND,
        visibleToAgentId: AGENT,
        metadata: {
          shell_session_id: 41,
          shell_command: 'npm run build',
          shell_pid: null,
          shell_started_at: new Date(Date.now() - 25 * 60_000).toISOString(),
          shell_limit_ms: 7_200_000,
          shell_host: os.hostname(),
          // This process: a dead predecessor as far as recovery can tell.
          shell_server_pid: process.pid,
          ...over,
        },
      });
    }

    it('leaves a job this server started alone (it is live, not lost)', async () => {
      const id = await startJob(5_000);
      try {
        await shellJobService.recoverAfterRestart();
        const lost = (await jobRows(SHELL_JOB_ENDED_EVENT_KIND)).filter(
          (row) => row.metadata?.shell_session_id === id
        );
        expect(lost).toEqual([]);
      } finally {
        killAllShellSessions();
      }
    }, 20_000);

    it('reports a job the restart cut off, wakes its agent once, and is idempotent', async () => {
      await startRow({ shell_job_id: 'job-1111111111111-lostaaaaa' });
      await startRow({ shell_job_id: 'job-1111111111111-elsewhere', shell_host: 'other-machine' });

      await shellJobService.recoverAfterRestart();
      const lost = (await jobRows(SHELL_JOB_ENDED_EVENT_KIND)).filter(
        (row) => row.metadata?.shell_lost === true
      );
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatchObject({ visibleToAgentId: AGENT });
      expect(lost[0]!.metadata?.shell_job_id).toBe('job-1111111111111-lostaaaaa');
      expect(lost[0]!.content).toMatch(
        /^\[shell job 41 lost · the server restarted while it ran \(started 25 min ago\)\] npm run build\n/
      );
      await waitFor(
        async () => wakes(),
        (calls) => calls.length > 0
      );
      expect(wakes()).toEqual([expect.objectContaining({ messageId: lost[0]!.id })]);

      // Answered now: a second boot finds nothing new (the other machine's row stays).
      await shellJobService.recoverAfterRestart();
      const after = (await jobRows(SHELL_JOB_ENDED_EVENT_KIND)).filter(
        (row) => row.metadata?.shell_lost === true
      );
      expect(after).toHaveLength(1);
      const { rows } = await getDb().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.messages
          WHERE thread_id = $1 AND metadata ->> 'shell_job_id' = 'job-1111111111111-elsewhere'`,
        [THREAD]
      );
      expect(rows[0]!.n).toBe(1);
    }, 20_000);
  });
});
