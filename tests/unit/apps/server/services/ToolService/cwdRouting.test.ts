/** Tool calls without an explicit directory must use the resolved agent cwd. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const readOptional = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('@server/services/settings', () => ({
  settingsService: { readOptional: (...args: unknown[]) => readOptional(...args) },
}));
jest.mock('@server/services/subagents/helperVisibility', () => ({
  isHelperAgent: async () => false,
}));

import fileRead from '@server/services/ToolService/tools/files/fileRead';
import shellRun from '@server/services/ToolService/tools/shell/shellRun';
import {
  killAllShellSessions,
  waitForShellSessionClose,
} from '@server/services/ToolService/tools/shell/codex-shell-sessions';
import {
  setBackgroundJobReporter,
  type BackgroundJobReporter,
} from '@server/services/ToolService/tools/shell/backgroundJobs';

const node = JSON.stringify(process.execPath);
let cwd: string;

beforeEach(async () => {
  readOptional.mockReset();
  readOptional.mockResolvedValue(null);
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'snaglet-tool-cwd-')));
});

afterEach(async () => {
  killAllShellSessions();
  setBackgroundJobReporter(null);
  await rm(cwd, { recursive: true, force: true });
});

describe('resolved agent cwd routing', () => {
  it('file_read resolves a relative path from context.cwd', async () => {
    await writeFile(path.join(cwd, 'agent-relative.txt'), 'from agent cwd');

    await expect(
      fileRead({ mode: 'text', path: 'agent-relative.txt' }, { root_dir: cwd }, {
        agentId: 'agent-cwd-test',
        cwd,
      } as never)
    ).resolves.toBe('from agent cwd');
  });

  it('foreground shell run uses context.cwd when cwd is omitted', async () => {
    const result = String(
      await shellRun({ cmd: `${node} -e "process.stdout.write(process.cwd())"` }, {}, {
        agentId: 'agent-cwd-test',
        cwd,
      } as never)
    );

    expect(result).toContain(`\n${cwd}`);
  });

  it('background shell run uses context.cwd when cwd is omitted', async () => {
    const reporter: BackgroundJobReporter = {
      started: jest.fn(async () => undefined),
      ended: jest.fn(),
    };
    setBackgroundJobReporter(reporter);
    const context = { threadId: 'thread-cwd-test', agentId: 'agent-cwd-test', cwd };
    const result = String(
      await shellRun(
        {
          cmd: `${node} -e "process.stdout.write(process.cwd()); setTimeout(() => {}, 500)"`,
          background: true,
          yield_time_ms: 250,
        },
        {},
        context as never
      )
    );

    expect(result).toContain('Process running with session ID');
    expect(reporter.started).toHaveBeenCalledWith(expect.objectContaining({ cwd }));
    const sessionId = Number(/session ID (\d+)/.exec(result)?.[1]);
    await waitForShellSessionClose(sessionId, 5_000);
    expect(reporter.ended).toHaveBeenCalledWith(
      expect.objectContaining({ cwd }),
      expect.anything()
    );
  }, 10_000);
});
