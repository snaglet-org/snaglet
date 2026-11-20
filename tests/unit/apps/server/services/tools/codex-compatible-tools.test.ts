import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from '@jest/globals';

import execCommand from '@server/services/ToolService/tools/shell/shellRun';
import writeStdin from '@server/services/ToolService/tools/shell/shellWrite';
import applyPatch from '@server/services/ToolService/tools/files/filePatch';
import updatePlan from '@server/services/ToolService/tools/system/update-plan/tool';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-codex-tools-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Yield window for calls that must observe the child's exit. Both tools return
 * as soon as the child closes, so this waits for the exit itself rather than
 * racing process startup against a fixed window; it only caps a child that
 * never exits, which the Jest timeout reports first.
 */
const UNTIL_EXIT_MS = 30_000;

describe('codex-compatible tools', () => {
  it('exec_command returns Codex-style output for completed commands', async () => {
    const result = await execCommand(
      {
        cmd: `"${process.execPath}" -e "console.log('hello')"`,
        yield_time_ms: UNTIL_EXIT_MS,
        max_output_tokens: 100,
      },
      {}
    );

    expect(result).toContain('Chunk ID:');
    expect(result).toContain('Process exited with code 0');
    expect(result).toContain('Output:');
    expect(result).toContain('hello');
  });

  it('write_stdin continues an active exec_command session', async () => {
    // The child blocks on stdin, so it is still running whenever the yield ends.
    const started = await execCommand(
      {
        cmd: `"${process.execPath}" -e "process.stdin.on('data', d => { console.log('got:' + d.toString().trim()); process.exit(0); })"`,
        yield_time_ms: 250,
        max_output_tokens: 100,
      },
      {}
    );
    const match = String(started).match(/session ID (\d+)/);
    expect(match).toBeTruthy();

    const result = await writeStdin(
      { session_id: Number(match![1]), chars: 'ping\n', yield_time_ms: UNTIL_EXIT_MS },
      {}
    );

    expect(result).toContain('Process exited with code 0');
    expect(result).toContain('got:ping');
  });

  it('apply_patch applies an update patch relative to workdir', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'sample.txt');
      await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8');

      const patch = [
        '*** Begin Patch',
        '*** Update File: sample.txt',
        '@@',
        ' alpha',
        '-beta',
        '+delta',
        ' gamma',
        '*** End Patch',
      ].join('\n');

      const result = await applyPatch({ patch, workdir: dir }, {});
      expect(result).toContain('Done!');
      await expect(readFile(file, 'utf8')).resolves.toBe('alpha\ndelta\ngamma\n');
    });
  });

  it('update_plan validates and summarizes plan items', async () => {
    const result = await updatePlan(
      {
        explanation: 'Tracking implementation.',
        plan: [
          { step: 'Add tools', status: 'completed' },
          { step: 'Run tests', status: 'in_progress' },
        ],
      },
      {},
      { agentId: 'agent-1', threadId: 'thread-1' }
    );

    expect(result).toContain('Plan updated.');
    expect(result).toContain('completed: Add tools');
    expect(result).toContain('in_progress: Run tests');
  });
});
