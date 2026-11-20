import { execFileSync } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { setGitEmailReaderForTests } from '@server/services/ToolService/lib/gitUserEmail';
import shellRun from '@server/services/ToolService/tools/shell/shellRun';

const UNTIL_EXIT_MS = 30_000;
const COMMIT =
  'git init -q . && git -c commit.gpgsign=false -c core.hooksPath=/dev/null ' +
  'commit -q --allow-empty -m test && git log -1 --format="%an <%ae> | %cn <%ce>"';

async function commitAs(dir: string, context: Record<string, unknown>): Promise<string> {
  const out = await shellRun(
    { cmd: COMMIT, cwd: dir, yield_time_ms: UNTIL_EXIT_MS, max_output_tokens: 200 },
    {},
    context
  );
  return String(out);
}

describe('shell tool git identity', () => {
  beforeEach(() =>
    setGitEmailReaderForTests((scope) => (scope === 'global' ? 'user@example.com' : ''))
  );
  afterEach(() => setGitEmailReaderForTests(null));

  it('authors and commits as the calling agent, per call', async () => {
    const dirs = [
      await mkdtemp(path.join(os.tmpdir(), 'snaglet-git-id-')),
      await mkdtemp(path.join(os.tmpdir(), 'snaglet-git-id-')),
    ];
    try {
      const [a, b] = await Promise.all([
        commitAs(dirs[0], { agentId: 'test-agent-a', runtime: { agentName: 'Test Agent A' } }),
        commitAs(dirs[1], { agentId: 'test-agent-b', runtime: { agentName: 'Test Agent B' } }),
      ]);
      expect(a).toContain(
        'Test Agent A (Snaglet agent) <user@example.com> | Test Agent A (Snaglet agent) <user@example.com>'
      );
      expect(b).toContain(
        'Test Agent B (Snaglet agent) <user@example.com> | Test Agent B (Snaglet agent) <user@example.com>'
      );
      expect(a).not.toContain('Agent B');
      // sanity: the commit really landed in the temp repo
      expect(
        execFileSync('git', ['log', '-1', '--format=%an'], { cwd: dirs[0] }).toString().trim()
      ).toBe('Test Agent A (Snaglet agent)');
    } finally {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    }
  });

  it('falls back to an .invalid address when no email is configured', async () => {
    setGitEmailReaderForTests(() => '');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-git-id-'));
    try {
      const out = await commitAs(dir, {
        agentId: 'test-agent-a',
        runtime: { agentName: 'Test Agent A' },
      });
      expect(out).toContain('<test-agent-a@agents.snaglet.invalid>');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds no identity for a human-panel call that borrows an agent context', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-git-id-'));
    try {
      const out = await shellRun(
        {
          cmd: 'echo "[$GIT_AUTHOR_NAME]"',
          cwd: dir,
          yield_time_ms: UNTIL_EXIT_MS,
          max_output_tokens: 100,
        },
        {},
        { agentId: 'test-agent-a', bypassToolAccess: true, runtime: { agentName: 'Test Agent A' } }
      );
      expect(String(out)).toContain('[]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
