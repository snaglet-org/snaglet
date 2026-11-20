/**
 * shell(op:run) with `background: true` against real short-lived child
 * processes, with the reporter replaced by a recorder (the delivery itself is
 * ShellJobService, covered by the integration suite): it returns at once with
 * a session id, a job that ends inside its start window is reported in the
 * same call, its own lifetime bounds it, it is exempt from the idle-poll
 * breaker and from Stop but not from its agent's removal, and an agent may run
 * at most SHELL_MAX_BACKGROUND_JOBS_PER_AGENT at once.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const readOptional = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('@server/services/settings', () => ({
  settingsService: { readOptional: (...args: unknown[]) => readOptional(...args) },
}));
const helperAgents = new Set<string>();
jest.mock('@server/services/subagents/helperVisibility', () => ({
  isHelperAgent: async (id: string) => helperAgents.has(id),
}));

import {
  setBackgroundJobReporter,
  type BackgroundJobReporter,
  type BackgroundJobStart,
} from '@server/services/ToolService/tools/shell/backgroundJobs';
import {
  getShellSession,
  killAllShellSessions,
  killBackgroundShellJobs,
  killShellSessionsForAgent,
  killShellSessionsForThread,
  recordShellPoll,
  waitForShellSessionClose,
  type ShellSessionEnd,
} from '@server/services/ToolService/tools/shell/codex-shell-sessions';
import {
  SHELL_MAX_BACKGROUND_JOBS_PER_AGENT,
  SHELL_MAX_IDLE_POLLS,
} from '@server/services/ToolService/tools/shell/shellGuardrails';
import shellRun from '@server/services/ToolService/tools/shell/shellRun';
import shellWrite from '@server/services/ToolService/tools/shell/shellWrite';

const node = `"${process.execPath}"`;
const THREAD = 'thread-1111111111111-shellbgaa';
const AGENT = 'test-agent-a';
const ctx = { threadId: THREAD, agentId: AGENT };
/** Prints, then stays alive until killed. */
const LONG = `${node} -e "console.log('up'); setInterval(() => {}, 30000)"`;

interface Recorded {
  starts: BackgroundJobStart[];
  ends: Array<{ job: BackgroundJobStart; end: ShellSessionEnd }>;
}
let recorded: Recorded;

/** A reporter writing into its own record, so a late end from an earlier test lands there. */
function recorder(): BackgroundJobReporter {
  const own: Recorded = { starts: [], ends: [] };
  recorded = own;
  return {
    started: async (job) => {
      own.starts.push(job);
    },
    ended: (job, end) => {
      own.ends.push({ job, end });
    },
  };
}

function sessionIdOf(text: string): number {
  const id = Number(/session ID (\d+)/.exec(text)?.[1]);
  expect(id).toBeGreaterThan(0);
  return id;
}

async function waitForEnds(n: number, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (recorded.ends.length < n) {
    if (Date.now() > deadline) throw new Error(`expected ${n} ends, got ${recorded.ends.length}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  readOptional.mockReset();
  readOptional.mockResolvedValue(null);
  helperAgents.clear();
  setBackgroundJobReporter(recorder());
});

afterEach(() => {
  killAllShellSessions();
  setBackgroundJobReporter(null);
});

describe('shell(op:run) background: true', () => {
  it('returns at once with a session id, then reports the exit through the reporter', async () => {
    const t0 = Date.now();
    const out = String(
      await shellRun(
        {
          cmd: `${node} -e "console.log('building'); setTimeout(() => console.log('built'), 700)"`,
          background: true,
          yield_time_ms: 250,
        },
        {},
        ctx
      )
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
    const id = sessionIdOf(out);
    expect(out).toContain('Running in the background');
    expect(out).toContain('killed after 2 h');
    expect(out).toContain('No need to poll');
    expect(recorded.starts).toEqual([
      expect.objectContaining({
        sessionId: id,
        threadId: THREAD,
        agentId: AGENT,
        limitMs: 7_200_000,
      }),
    ]);
    expect(getShellSession(id)?.background).toBe(true);

    await waitForEnds(1);
    const { job, end } = recorded.ends[0]!;
    expect(job.jobId).toBe(recorded.starts[0]!.jobId);
    expect(end).toMatchObject({ id, exitCode: 0, killReason: null, signal: null });
    expect(end.tail(100)).toContain('built');
    // The handle stays the source of truth: op:write still reads what is left.
    const rest = String(await shellWrite({ session_id: id, yield_time_ms: 250 }, {}, ctx));
    expect(rest).toContain('Process exited with code 0');
    expect(rest).toContain('built');
  }, 15_000);

  it('a command that ends inside the start window is reported in the same call, not later', async () => {
    const out = String(await shellRun({ cmd: 'echo quick', background: true }, {}, ctx));
    expect(out).toContain('Process exited with code 0');
    expect(out).toContain('quick');
    await new Promise((r) => setTimeout(r, 200));
    expect(recorded.starts).toEqual([]);
    expect(recorded.ends).toEqual([]);
  });

  it('its own timeout_ms bounds it; a timeout over the maximum is clamped and said so', async () => {
    const out = String(
      await shellRun(
        { cmd: LONG, background: true, timeout_ms: 1_000, yield_time_ms: 250 },
        {},
        ctx
      )
    );
    sessionIdOf(out);
    expect(out).toContain('killed after 1 s');
    await waitForEnds(1);
    expect(recorded.ends[0]!.end.killReason).toBe('hard-timeout');

    readOptional.mockResolvedValue({ backgroundMaxMs: 60_000 });
    const clamped = String(
      await shellRun(
        { cmd: LONG, background: true, timeout_ms: 99 * 60 * 60_000, yield_time_ms: 250 },
        {},
        ctx
      )
    );
    expect(clamped).toContain('killed after 1 min');
    expect(clamped).toContain('over the background maximum of 1 min');
  }, 15_000);

  it('is exempt from the idle-poll breaker and from Stop, but dies with its agent', async () => {
    const id = sessionIdOf(
      String(await shellRun({ cmd: LONG, background: true, yield_time_ms: 250 }, {}, ctx))
    );
    for (let i = 0; i < SHELL_MAX_IDLE_POLLS + 3; i++) expect(recordShellPoll(id)).toBe(false);
    expect(getShellSession(id)?.killed).toBe(false);

    // The Stop / run-abort paths reap foreground shells only.
    expect(killShellSessionsForAgent(THREAD, AGENT)).toBe(0);
    expect(killShellSessionsForThread(THREAD)).toBe(0);
    expect(getShellSession(id)?.killed).toBe(false);

    expect(killBackgroundShellJobs({ agentId: AGENT })).toBe(1);
    expect(await waitForShellSessionClose(id, 5_000)).toBe(true);
    await waitForEnds(1);
    expect(recorded.ends[0]!.end.killReason).toBe('owner-removed');
  }, 15_000);

  it(`refuses a job past ${SHELL_MAX_BACKGROUND_JOBS_PER_AGENT} running per agent, naming them`, async () => {
    const ids: number[] = [];
    for (let i = 0; i < SHELL_MAX_BACKGROUND_JOBS_PER_AGENT; i++) {
      ids.push(
        sessionIdOf(
          String(await shellRun({ cmd: LONG, background: true, yield_time_ms: 250 }, {}, ctx))
        )
      );
    }
    const refused = shellRun({ cmd: 'echo one more', background: true }, {}, ctx);
    await expect(refused).rejects.toThrow(/already have 3 background jobs running/);
    await expect(shellRun({ cmd: 'echo one more', background: true }, {}, ctx)).rejects.toThrow(
      new RegExp(`session ${ids[0]} \\(running`)
    );
    // Another agent has its own allowance, and foreground runs are unaffected.
    const other = String(
      await shellRun(
        { cmd: 'echo theirs', background: true },
        {},
        { threadId: THREAD, agentId: 'test-agent-b' }
      )
    );
    expect(other).toContain('theirs');
    expect(String(await shellRun({ cmd: 'echo fg' }, {}, ctx))).toContain('fg');
  }, 20_000);

  it('needs an agent in a thread, a reporter, and an agent that is not a subagent helper', async () => {
    await expect(shellRun({ cmd: 'echo x', background: true }, {}, {})).rejects.toThrow(
      /needs an agent in a thread/
    );
    setBackgroundJobReporter(null);
    await expect(shellRun({ cmd: 'echo x', background: true }, {}, ctx)).rejects.toThrow(
      /not available on this server/
    );
    setBackgroundJobReporter(recorder());
    helperAgents.add('test-helper-a');
    await expect(
      shellRun(
        { cmd: 'echo x', background: true },
        {},
        { threadId: THREAD, agentId: 'test-helper-a' }
      )
    ).rejects.toThrow(/Subagent helpers cannot start background jobs/);
  });

  it('runs the git rail first, exactly as a foreground run', async () => {
    await expect(shellRun({ cmd: 'git reset --hard', background: true }, {}, ctx)).rejects.toThrow(
      /Refused: /
    );
    expect(recorded.starts).toEqual([]);
  });

  it('the legacy shell_exec contract refuses background', async () => {
    await expect(
      shellRun({ cmd: 'echo x', background: true, legacy_output: 'shell_exec' }, {}, ctx)
    ).rejects.toThrow(/use shell op:"run" for background/);
  });
});

describe('shell(op:run) foreground limits', () => {
  it('clamps timeout_ms to the configured maximum and says so', async () => {
    readOptional.mockResolvedValue({ maxTimeoutMs: 2_000 });
    const out = String(await shellRun({ cmd: 'echo ok', timeout_ms: 60 * 60_000 }, {}, ctx));
    expect(out).toContain('ok');
    expect(out).toContain('timeout_ms is over the foreground maximum of 2 s; using 2 s.');
  });

  it('kills a foreground command at the clamped maximum', async () => {
    readOptional.mockResolvedValue({ maxTimeoutMs: 1_000 });
    const t0 = Date.now();
    const out = String(
      await shellRun({ cmd: LONG, timeout_ms: 60 * 60_000, yield_time_ms: 60 * 60_000 }, {}, ctx)
    );
    // The wait is capped by the command's lifetime, not left at the hour asked for.
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(out).toContain('Process was KILLED');
  }, 15_000);
});
