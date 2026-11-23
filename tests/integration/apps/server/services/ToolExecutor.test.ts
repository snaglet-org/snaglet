import path from 'path';
import { writeFile, mkdir, rm, readFile, symlink, stat } from 'fs/promises';
import os from 'os';
import { execSync } from 'child_process';

const hasRg = (() => {
  try {
    execSync('rg --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

// Mock @snaglet/db to avoid import.meta.url issues in Jest
jest.mock('../../../../../packages/db/index.ts', () => ({
  getPool: jest.fn(),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: jest.fn(),
}));

import { WorkspaceQuery } from '@snaglet/db/tables/table_query';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { mintChildDispatchToken } from '@server/middleware/panelAuth';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import { canonicalToolRows } from '@server/services/ToolService/lib/canonicalToolRows';
import { evaluateToolPermission } from '@server/services/ToolService/lib/toolPermission';

// Helper to build a minimal ResolvedAgentTool mock for ToolExecutor.execute
function makeAgentTool(
  settings: Record<string, unknown> = {},
  config: Record<string, unknown> = {}
) {
  return {
    agentId: 'test-agent',
    settings,
    requiresConfirmation: false,
    tool: {
      id: 'test-tool',
      name: 'Test Tool',
      description: 'A test tool',
      type: 'builtin',
      enabled: true,
      parameters_schema: {},
      config_json: config,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  } as Parameters<typeof toolExecutor.execute>[1];
}

describe('ToolExecutor', () => {
  beforeAll(async () => {
    await toolRegistry.load();
  });

  describe('hasHandler', () => {
    it('should return true for built-in tools', () => {
      expect(toolRegistry.hasHandler('file')).toBe(true);
      expect(toolRegistry.hasHandler('file_read')).toBe(false);
      // Merged tools register under their canonical id only. Old ids are never
      // handlers: ToolExecutor resolves them through the catalog alias so the
      // parameter conversion (and the pinned op) is always applied.
      expect(toolRegistry.hasHandler('shell')).toBe(true);
      expect(toolRegistry.hasHandler('shell_exec')).toBe(false);
      expect(toolRegistry.hasHandler('web_fetch')).toBe(true);
      expect(toolRegistry.hasHandler('get_current_datetime')).toBe(true);
      expect(toolRegistry.hasHandler('url_parse')).toBe(false); // retired
      expect(toolRegistry.hasHandler('resolve_path')).toBe(true);
      expect(toolRegistry.hasHandler('repo_tree')).toBe(false);
      expect(toolRegistry.hasHandler('find_files')).toBe(false);
      expect(toolRegistry.hasHandler('server_logs_stream')).toBe(false);
    });

    it('should return false for unknown tools', () => {
      expect(toolRegistry.hasHandler('unknown_tool')).toBe(false);
      expect(toolRegistry.hasHandler('')).toBe(false);
    });
  });

  describe('execute — unknown handler', () => {
    it('should return error for unknown tool name', async () => {
      const result = await toolExecutor.execute(
        { name: 'nonexistent', input: {} },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No handler for tool 'nonexistent'");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('execute — external runner fallback', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = path.join(os.tmpdir(), `snaglet-test-external-tool-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should execute an external script when no native handler exists', async () => {
      const scriptPath = path.join(tmpDir, 'external-ok.cjs');
      await writeFile(
        scriptPath,
        [
          "let raw='';",
          "process.stdin.on('data', (chunk) => raw += chunk);",
          "process.stdin.on('end', () => {",
          "  const payload = JSON.parse(raw || '{}');",
          '  process.stdout.write(`external:${payload.tool}:${payload.input.value}`);',
          '});',
          '',
        ].join('\n')
      );

      const result = await toolExecutor.execute(
        { name: 'external_echo', input: { value: 'hello' } },
        makeAgentTool(
          {},
          {
            external_runner: {
              command: process.execPath,
              script_path: scriptPath,
            },
          }
        )
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe('external:external_echo:hello');
    });

    it('should return a failure when external process exits non-zero', async () => {
      const scriptPath = path.join(tmpDir, 'external-fail.cjs');
      await writeFile(
        scriptPath,
        ["process.stderr.write('boom');", 'process.exit(2);', ''].join('\n')
      );

      const result = await toolExecutor.execute(
        { name: 'external_fail', input: {} },
        makeAgentTool(
          {},
          {
            external_runner: {
              command: process.execPath,
              script_path: scriptPath,
            },
          }
        )
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('External tool failed with exit code 2');
      expect(result.error).toContain('boom');
    });
  });

  describe('execute — workspace tool child env', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = path.join(os.tmpdir(), `snaglet-test-workspace-tool-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("does not put SNAGLET_PANEL_TOKEN in the workspace-tool child's env — a tool that echoes it gets undefined", async () => {
      const scriptPath = path.join(tmpDir, 'echo-panel-token.cjs');
      await writeFile(
        scriptPath,
        'process.stdout.write(JSON.stringify({ panelToken: process.env.SNAGLET_PANEL_TOKEN ?? null }));\n'
      );

      const result = await toolExecutor.execute(
        { name: 'echo_panel_token_tool', input: {} },
        makeAgentTool({ workspace_tool: true, built_path: scriptPath, timeout_ms: 5000 })
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output) as { panelToken: string | null };
      expect(parsed.panelToken).toBeNull();
    });

    it('injects a narrow SNAGLET_CHILD_DISPATCH_TOKEN bound to ghost when no context/agentId is threaded through', async () => {
      const scriptPath = path.join(tmpDir, 'echo-child-dispatch-token.cjs');
      await writeFile(
        scriptPath,
        'process.stdout.write(JSON.stringify({ childDispatchToken: process.env.SNAGLET_CHILD_DISPATCH_TOKEN ?? null }));\n'
      );

      // No third `context` arg: a person ran the tool (panel Run, `snaglet run`
      // with no agent). Its nested calls act as the ghost system actor, as
      // agentless hooks do; an unbound token would be refused by /execute.
      const result = await toolExecutor.execute(
        { name: 'echo_child_dispatch_token_tool', input: {} },
        makeAgentTool({ workspace_tool: true, built_path: scriptPath, timeout_ms: 5000 })
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output) as { childDispatchToken: string | null };
      expect(parsed.childDispatchToken).toBe(mintChildDispatchToken(GHOST_AGENT_ID));
      expect(parsed.childDispatchToken).not.toBe(mintChildDispatchToken());
    });

    it('injects a token bound to the invoking agentId from context, distinct per agent', async () => {
      const scriptPathA = path.join(tmpDir, 'echo-token-a.cjs');
      const scriptPathB = path.join(tmpDir, 'echo-token-b.cjs');
      const script =
        'process.stdout.write(JSON.stringify({ childDispatchToken: process.env.SNAGLET_CHILD_DISPATCH_TOKEN ?? null }));\n';
      await writeFile(scriptPathA, script);
      await writeFile(scriptPathB, script);

      const resultA = await toolExecutor.execute(
        { name: 'echo_child_dispatch_token_tool_a', input: {} },
        makeAgentTool({ workspace_tool: true, built_path: scriptPathA, timeout_ms: 5000 }),
        { agentId: 'agent-a' }
      );
      const resultB = await toolExecutor.execute(
        { name: 'echo_child_dispatch_token_tool_b', input: {} },
        makeAgentTool({ workspace_tool: true, built_path: scriptPathB, timeout_ms: 5000 }),
        { agentId: 'agent-b' }
      );

      const parsedA = JSON.parse(resultA.output) as { childDispatchToken: string | null };
      const parsedB = JSON.parse(resultB.output) as { childDispatchToken: string | null };

      expect(parsedA.childDispatchToken).toBe(mintChildDispatchToken('agent-a'));
      expect(parsedB.childDispatchToken).toBe(mintChildDispatchToken('agent-b'));
      // Tokens differ per agent, so agent-a's child cannot present its own
      // token while claiming (via a raw /execute request body) to be agent-b;
      // /execute's handler recovers 'agent-a' from the token itself.
      expect(parsedA.childDispatchToken).not.toBe(parsedB.childDispatchToken);
    });
  });

  describe('execute — file_read', () => {
    let tmpDir: string;
    let tmpFile: string;

    beforeAll(async () => {
      tmpDir = path.join(os.tmpdir(), `snaglet-test-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
      tmpFile = path.join(tmpDir, 'test.txt');
      await writeFile(tmpFile, 'hello world');
    });

    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should read a file successfully', async () => {
      const result = await toolExecutor.execute(
        { name: 'file_read', input: { path: tmpFile } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe('hello world');
    });

    it('should fail when path is missing', async () => {
      const result = await toolExecutor.execute({ name: 'file_read', input: {} }, makeAgentTool());

      expect(result.success).toBe(false);
      expect(result.error).toContain('path is required');
    });

    it('should fail when file does not exist', async () => {
      const result = await toolExecutor.execute(
        { name: 'file_read', input: { path: '/tmp/does-not-exist-xyz.txt' } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject paths outside root_dir constraint', async () => {
      const result = await toolExecutor.execute(
        { name: 'file_read', input: { path: '/etc/passwd' } },
        makeAgentTool({ root_dir: tmpDir })
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('outside the allowed root directory');
    });

    it('should allow paths inside root_dir constraint', async () => {
      const result = await toolExecutor.execute(
        { name: 'file_read', input: { path: tmpFile } },
        makeAgentTool({ root_dir: tmpDir })
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe('hello world');
    });

    it('should reject a sibling path that only shares the root prefix', async () => {
      const siblingDir = `${tmpDir}-sibling`;
      const siblingFile = path.join(siblingDir, 'secret.txt');
      await mkdir(siblingDir, { recursive: true });
      await writeFile(siblingFile, 'secret');
      try {
        const result = await toolExecutor.execute(
          { name: 'file_read', input: { path: siblingFile } },
          makeAgentTool({ root_dir: tmpDir })
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the allowed root directory');
      } finally {
        await rm(siblingDir, { recursive: true, force: true });
      }
    });

    it('should reject a symlink that escapes root_dir', async () => {
      const linkPath = path.join(tmpDir, 'escape-link');
      await symlink('/etc', linkPath);
      try {
        const result = await toolExecutor.execute(
          { name: 'file_read', input: { path: path.join(linkPath, 'passwd') } },
          makeAgentTool({ root_dir: tmpDir })
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the allowed root directory');
      } finally {
        await rm(linkPath, { force: true });
      }
    });
  });

  describe('execute — file_write', () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = path.join(os.tmpdir(), `snaglet-test-write-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
    });

    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should write a file successfully', async () => {
      const filePath = path.join(tmpDir, 'output.txt');
      const result = await toolExecutor.execute(
        { name: 'file_write', input: { path: filePath, content: 'written!' } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('File written');
    });

    it('should fail when path is missing', async () => {
      const result = await toolExecutor.execute(
        { name: 'file_write', input: { content: 'data' } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('path is required');
    });

    it.each(['file', 'file_write'])(
      '%s create refuses a decoy patch and writes nothing (review blocker)',
      async (name) => {
        const target = path.join(tmpDir, `decoy-target-${name}.txt`);
        const decoy = path.join(tmpDir, `decoy-patch-${name}.txt`);
        const result = await toolExecutor.execute(
          {
            name,
            input: {
              ...(name === 'file' ? { op: 'create' } : {}),
              path: target,
              content: 'secret',
              patch: `*** Begin Patch\n*** Add File: ${decoy}\n+hi\n*** End Patch`,
            },
          },
          makeAgentTool()
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('takes no `patch`');
        await expect(stat(target)).rejects.toThrow();
        await expect(stat(decoy)).rejects.toThrow();
      }
    );
  });

  describe('execute — shell_exec', () => {
    it('should execute a simple command', async () => {
      const result = await toolExecutor.execute(
        { name: 'shell_exec', input: { command: 'echo hello' } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('hello');
    });

    it('should fail when command is missing', async () => {
      const result = await toolExecutor.execute({ name: 'shell_exec', input: {} }, makeAgentTool());

      expect(result.success).toBe(false);
      expect(result.error).toContain('command is required');
    });

    // shell_exec has no command allow list: these check exit-code semantics only.
    it('reports a command that exits non-zero as a failure', async () => {
      const result = await toolExecutor.execute(
        { name: 'shell_exec', input: { command: 'ls /definitely-not-a-real-path-snaglet' } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
    });

    it('reports a command that exits zero as a success', async () => {
      const result = await toolExecutor.execute(
        { name: 'shell_exec', input: { command: 'echo safe' } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('safe');
    });
  });

  describe('execute — git-safety rail (refused commands never spawn)', () => {
    let repo: string;
    const dirty = () => readFile(path.join(repo, 'a.txt'), 'utf8');

    beforeEach(async () => {
      repo = path.join(os.tmpdir(), `snaglet-test-gitsafety-${Date.now()}-${Math.random()}`);
      await mkdir(repo, { recursive: true });
      execSync(
        'git init -q && git config user.email t@t && git config user.name t && ' +
          'echo clean > a.txt && git add a.txt && git commit -qm init && echo dirty > a.txt',
        { cwd: repo }
      );
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    it.each([
      ['shell', { op: 'run', cmd: 'git reset --hard' }],
      ['exec_command', { cmd: 'git reset --hard' }],
      ['shell_exec', { command: 'git reset --hard' }],
      ['shell', { op: 'run', cmd: "touch ran.txt && bash -lc 'git stash'" }],
      // A background run passes the same rail before anything is spawned.
      ['shell', { op: 'run', cmd: 'git reset --hard', background: true }],
      ['shell', { op: 'run', cmd: "touch ran.txt && bash -lc 'git stash'", background: true }],
    ])('%s %j is refused and the tree is untouched', async (name, input) => {
      const result = await toolExecutor.execute(
        { name, input: { ...input, workdir: repo, cwd: repo } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Refused: /);
      expect(await dirty()).toBe('dirty\n');
      // Nothing in the compound ran either: the whole command is refused up front.
      await expect(stat(path.join(repo, 'ran.txt'))).rejects.toThrow();
    });

    it('write refuses `git stash` typed into a live session; the stash stays empty', async () => {
      const started = await toolExecutor.execute(
        { name: 'shell', input: { op: 'run', cmd: 'bash', workdir: repo, yield_time_ms: 300 } },
        makeAgentTool()
      );
      const sessionId = Number(/session ID (\d+)/.exec(started.output)?.[1]);
      expect(sessionId).toBeGreaterThan(0);

      try {
        const result = await toolExecutor.execute(
          {
            name: 'shell',
            input: { op: 'write', session_id: sessionId, chars: 'echo hi\ngit stash\n' },
          },
          makeAgentTool()
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Refused: /);
        expect(await dirty()).toBe('dirty\n');
        expect(execSync('git stash list', { cwd: repo }).toString()).toBe('');
      } finally {
        await toolExecutor.execute(
          { name: 'shell', input: { op: 'write', session_id: sessionId, chars: 'exit\n' } },
          makeAgentTool()
        );
      }
    });

    it('run refuses a decoy `chars` field', async () => {
      const result = await toolExecutor.execute(
        { name: 'shell', input: { op: 'run', cmd: 'echo ok', chars: 'git stash\n' } },
        makeAgentTool()
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('chars');
    });

    it('git status still runs', async () => {
      const result = await toolExecutor.execute(
        { name: 'shell', input: { op: 'run', cmd: 'git status --short', workdir: repo } },
        makeAgentTool()
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('a.txt');
    });
  });

  describe('execute — deny rules apply to shell(op:write) stdin', () => {
    // The production gate: every executor path (chat dispatch, /execute, the
    // action gateway) runs evaluateToolPermission on the call, then executes
    // only on `allow`. Reproduce that gate around real sessions.
    const policy = { mode: 'deny_list' as const, allowList: [], denyList: ['shell_exec(touch:*)'] };
    let dir: string;
    const gated = async (name: string, input: Record<string, unknown>) => {
      const { evaluateToolPermission } =
        await import('@server/services/ToolService/lib/toolPermission');
      const verdict = evaluateToolPermission(policy, name, input);
      if (verdict.decision !== 'allow') {
        return { success: false, output: '', error: `Blocked: ${verdict.reason}` };
      }
      return toolExecutor.execute({ name, input }, makeAgentTool());
    };
    // Under a command deny rule a bare `bash` is refused: it runs commands
    // from its input. The session (as one started earlier would be) is opened
    // ungated here, and every write into it still goes through the gate.
    const startBash = async () => {
      const refused = await gated('shell', { op: 'run', cmd: 'bash', workdir: dir });
      expect(refused.error).toMatch(/`bash` with no script runs commands from its input/);
      const r = await toolExecutor.execute(
        { name: 'shell', input: { op: 'run', cmd: 'bash', workdir: dir, yield_time_ms: 300 } },
        makeAgentTool()
      );
      const id = Number(/session ID (\d+)/.exec(r.output)?.[1]);
      expect(id).toBeGreaterThan(0);
      return id;
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

    beforeEach(async () => {
      dir = path.join(os.tmpdir(), `snaglet-test-d4051cb7-${Date.now()}-${Math.random()}`);
      await mkdir(dir, { recursive: true });
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('run is denied, and the same command typed into a session is denied too', async () => {
      const direct = await gated('shell', { op: 'run', cmd: 'touch ran.txt', workdir: dir });
      expect(direct.success).toBe(false);

      const id = await startBash();
      try {
        const typed = await gated('shell', {
          op: 'write',
          session_id: id,
          chars: 'touch ran.txt\n',
        });
        expect(typed.success).toBe(false);
        expect(typed.error).toContain('touch ran.txt');
        // Split across writes: `tou` is not denied on its own and lands…
        expect((await gated('shell', { op: 'write', session_id: id, chars: 'tou' })).success).toBe(
          true
        );
        // …but the write that completes it is checked as `touch ran.txt`.
        const rest = await gated('shell', { op: 'write', session_id: id, chars: 'ch ran.txt\n' });
        expect(rest.success).toBe(false);
        expect(rest.error).toContain('touch ran.txt');
      } finally {
        // Submits the harmless unfinished `tou` (command not found), then exits.
        await gated('shell', { op: 'write', session_id: id, chars: '\nexit\n' });
      }
      await settle();
      await expect(stat(path.join(dir, 'ran.txt'))).rejects.toThrow();
    });

    it('a write that leaves a quote open is refused before it reaches the shell', async () => {
      const id = await startBash();
      try {
        // Had it landed, bash would read the next write as the rest of this
        // string, while the gate read that write on its own.
        const open = await gated('shell', { op: 'write', session_id: id, chars: 'echo "\n' });
        expect(open.success).toBe(false);
        expect(open.error).toMatch(/could not be checked .* \(a quote is left open\)/);
        // bash never got the quote, so this line runs as its own command.
        const ok = await gated('shell', {
          op: 'write',
          session_id: id,
          chars: 'echo fine > ok.txt\n',
          yield_time_ms: 300,
        });
        expect(ok.success).toBe(true);
        await settle();
        expect(await readFile(path.join(dir, 'ok.txt'), 'utf8')).toBe('fine\n');
      } finally {
        await gated('shell', { op: 'write', session_id: id, chars: 'exit\n' });
      }
    });

    it('a denied command is refused with background: true too, before anything runs', async () => {
      const result = await gated('shell', {
        op: 'run',
        cmd: 'touch ran.txt',
        workdir: dir,
        background: true,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked: /);
      await settle();
      await expect(stat(path.join(dir, 'ran.txt'))).rejects.toThrow();
    });

    it('legacy write_stdin is denied the same way; allowed lines and polls still work', async () => {
      const id = await startBash();
      try {
        const legacy = await gated('write_stdin', { session_id: id, chars: 'touch ran.txt\n' });
        expect(legacy.success).toBe(false);
        const ok = await gated('shell', {
          op: 'write',
          session_id: id,
          chars: 'echo fine > ok.txt\n',
          yield_time_ms: 300,
        });
        expect(ok.success).toBe(true);
        await settle();
        expect(await readFile(path.join(dir, 'ok.txt'), 'utf8')).toBe('fine\n');
        const poll = await gated('shell', { op: 'write', session_id: id, yield_time_ms: 100 });
        expect(poll.success).toBe(true);
      } finally {
        await gated('shell', { op: 'write', session_id: id, chars: 'exit\n' });
      }
      await expect(stat(path.join(dir, 'ran.txt'))).rejects.toThrow();
    });
  });

  describe('execute — shell(op:run) background: true goes through the same gates', () => {
    let dir: string;
    const reporter = {
      started: jest.fn(async () => {}),
      ended: jest.fn(),
    };
    const context = { agentId: 'test-agent-a', threadId: 'thread-1111111111111-execbgaaa' };
    const gated = async (
      policy: { mode: 'allow_list' | 'deny_list'; allowList: string[]; denyList: string[] },
      input: Record<string, unknown>
    ) => {
      const { evaluateToolPermission } =
        await import('@server/services/ToolService/lib/toolPermission');
      const verdict = evaluateToolPermission(policy, 'shell', input);
      if (verdict.decision !== 'allow') {
        return {
          success: false,
          output: '',
          error: `Blocked (${verdict.decision}): ${verdict.reason}`,
        };
      }
      return toolExecutor.execute({ name: 'shell', input }, makeAgentTool(), context);
    };

    beforeEach(async () => {
      dir = path.join(os.tmpdir(), `snaglet-test-shell-bg-${Date.now()}-${Math.random()}`);
      await mkdir(dir, { recursive: true });
      const { setBackgroundJobReporter } =
        await import('@server/services/ToolService/tools/shell/backgroundJobs');
      setBackgroundJobReporter(reporter);
    });
    afterEach(async () => {
      const { setBackgroundJobReporter } =
        await import('@server/services/ToolService/tools/shell/backgroundJobs');
      setBackgroundJobReporter(null);
      const { killAllShellSessions } =
        await import('@server/services/ToolService/tools/shell/codex-shell-sessions');
      killAllShellSessions();
      await rm(dir, { recursive: true, force: true });
    });

    it('an allow list must cover the command; a smuggled second command is not allowed', async () => {
      const policy = {
        mode: 'allow_list' as const,
        allowList: ['shell_exec(echo:*)'],
        denyList: [],
      };
      const ok = await gated(policy, {
        op: 'run',
        cmd: 'echo fine',
        workdir: dir,
        background: true,
      });
      expect(ok.success).toBe(true);
      expect(ok.output).toContain('fine');
      for (const cmd of ['touch ran.txt', 'echo hi && touch ran.txt']) {
        const refused = await gated(policy, { op: 'run', cmd, workdir: dir, background: true });
        expect(refused.success).toBe(false);
        expect(refused.error).toMatch(/Blocked \((ask|deny)\)/);
      }
      await expect(stat(path.join(dir, 'ran.txt'))).rejects.toThrow();
    });

    it('runs in the resolved workdir, like a foreground run', async () => {
      const policy = { mode: 'deny_list' as const, allowList: [], denyList: [] };
      const result = await gated(policy, { op: 'run', cmd: 'pwd', workdir: dir, background: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain(path.basename(dir));
    });

    it('a still-running job returns at once with its session id and is reported later', async () => {
      const policy = { mode: 'deny_list' as const, allowList: [], denyList: [] };
      const result = await gated(policy, {
        op: 'run',
        cmd: 'sleep 1; echo later',
        workdir: dir,
        background: true,
        yield_time_ms: 250,
      });
      expect(result.success).toBe(true);
      expect(result.output).toMatch(/Process running with session ID \d+/);
      expect(result.output).toContain('Running in the background');
      expect(reporter.started).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'test-agent-a', cwd: dir })
      );
    });
  });

  describe('execute — shell_exec legacy contract (via the shell alias)', () => {
    it('reports a non-zero exit as a failure with the exit code', async () => {
      const result = await toolExecutor.execute(
        { name: 'shell_exec', input: { command: 'echo boom 1>&2; exit 3' } },
        makeAgentTool()
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('exit code 3');
      expect(result.error).toContain('boom');
    });

    it('returns plain output with no session envelope', async () => {
      const result = await toolExecutor.execute(
        { name: 'shell_exec', input: { command: 'echo plain' } },
        makeAgentTool()
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('plain');
      expect(result.output).not.toContain('Chunk ID');
    });

    it('returns (no output) for a silent command', async () => {
      const result = await toolExecutor.execute(
        { name: 'shell_exec', input: { command: 'true' } },
        makeAgentTool()
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('(no output)');
    });

    it('fails on timeout', async () => {
      const result = await toolExecutor.execute(
        { name: 'shell_exec', input: { command: 'sleep 5', timeout_ms: 300 } },
        makeAgentTool()
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out|killed/i);
    });

    it('exec_command and shell keep the session envelope', async () => {
      for (const call of [
        { name: 'exec_command', input: { cmd: 'echo env' } },
        { name: 'shell', input: { op: 'run', cmd: 'echo env' } },
      ]) {
        const result = await toolExecutor.execute(call, makeAgentTool());
        expect(result.success).toBe(true);
        expect(result.output).toContain('Chunk ID');
        expect(result.output).toContain('env');
      }
    });
  });

  describe('execute — settings merge', () => {
    it('runs when both agent settings and tool config_json are present', async () => {
      // Smoke check that the merge (config_json spread, then agent settings)
      // does not break execution. Precedence itself isn't observable here: a
      // system-wide shell_exec setting, when set, outranks both layers.
      const result = await toolExecutor.execute(
        { name: 'shell_exec', input: { command: 'echo test' } },
        makeAgentTool(
          { maxBufferKb: 1024 }, // agent settings
          { maxBufferKb: 512 } // tool config_json
        )
      );

      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('test');
    });
  });

  // file_edit

  describe('execute — file_edit', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = path.join(os.tmpdir(), `snaglet-test-edit-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should replace old_text with new_text successfully', async () => {
      const filePath = path.join(tmpDir, 'edit-target.txt');
      await writeFile(filePath, 'hello world foo bar');

      const result = await toolExecutor.execute(
        { name: 'file_edit', input: { path: filePath, old_text: 'world', new_text: 'planet' } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain(filePath);
      const updated = await readFile(filePath, 'utf-8');
      expect(updated).toBe('hello planet foo bar');
    });

    it('should fail when path is missing', async () => {
      const result = await toolExecutor.execute(
        { name: 'file_edit', input: { old_text: 'x', new_text: 'y' } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('path is required');
    });

    it('should fail when old_text is missing', async () => {
      const filePath = path.join(tmpDir, 'edit-target.txt');
      await writeFile(filePath, 'content');

      const result = await toolExecutor.execute(
        { name: 'file_edit', input: { path: filePath, new_text: 'y' } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Must provide either');
    });

    it('should fail when old_text is not found in the file', async () => {
      const filePath = path.join(tmpDir, 'edit-target.txt');
      await writeFile(filePath, 'hello world');

      const result = await toolExecutor.execute(
        { name: 'file_edit', input: { path: filePath, old_text: 'nonexistent', new_text: 'y' } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('old_text not found');
    });

    it('should fail when old_text appears multiple times', async () => {
      const filePath = path.join(tmpDir, 'edit-target.txt');
      await writeFile(filePath, 'foo bar foo baz');

      const result = await toolExecutor.execute(
        { name: 'file_edit', input: { path: filePath, old_text: 'foo', new_text: 'qux' } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('old_text appears multiple times');
    });

    it('should fail when old_text and new_text are the same', async () => {
      const filePath = path.join(tmpDir, 'edit-target.txt');
      await writeFile(filePath, 'foo bar');

      const result = await toolExecutor.execute(
        { name: 'file_edit', input: { path: filePath, old_text: 'foo', new_text: 'foo' } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('old_text and new_text must be different');
      const updated = await readFile(filePath, 'utf-8');
      expect(updated).toBe('foo bar');
    });
  });

  // file_list

  describe('execute — file_list', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = path.join(os.tmpdir(), `snaglet-test-list-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
      await writeFile(path.join(tmpDir, 'alpha.txt'), 'a');
      await writeFile(path.join(tmpDir, 'beta.txt'), 'b');
      await mkdir(path.join(tmpDir, 'subdir'), { recursive: true });
      await writeFile(path.join(tmpDir, 'subdir', 'nested.txt'), 'n');
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should list directory contents with type prefixes', async () => {
      const result = await toolExecutor.execute(
        { name: 'file_list', input: { path: tmpDir } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('[file] alpha.txt');
      expect(result.output).toContain('[file] beta.txt');
      expect(result.output).toContain('[dir] subdir');
    });

    it('should default to cwd when path is missing', async () => {
      const result = await toolExecutor.execute({ name: 'file_list', input: {} }, makeAgentTool());

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });

    it('should list recursively when recursive is true', async () => {
      const result = await toolExecutor.execute(
        { name: 'file_list', input: { path: tmpDir, recursive: true } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('[file]');
      expect(result.output).toContain('nested.txt');
    });
  });

  // code_search

  (hasRg ? describe : describe.skip)('execute — code_search', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = path.join(os.tmpdir(), `snaglet-test-search-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
      await writeFile(path.join(tmpDir, 'one.txt'), 'the quick brown fox');
      await writeFile(path.join(tmpDir, 'two.txt'), 'jumped over the lazy dog');
      await writeFile(path.join(tmpDir, 'three.txt'), 'no match here');
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should find a pattern in files', async () => {
      const result = await toolExecutor.execute(
        { name: 'code_search', input: { query: 'the', path: tmpDir } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('one.txt');
      expect(result.output).toContain('two.txt');
    });

    it('should return no-matches message when nothing matches', async () => {
      const result = await toolExecutor.execute(
        { name: 'code_search', input: { query: 'zzzznotexist', path: tmpDir } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('No matches found');
    });

    it('should fail when query is missing', async () => {
      const result = await toolExecutor.execute(
        { name: 'code_search', input: { path: tmpDir } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('query is required');
    });
  });

  // web_fetch

  describe('execute — web_fetch', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should perform a successful GET request', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'text/html']]),
        text: () => Promise.resolve('<html>hello</html>'),
      });

      const result = await toolExecutor.execute(
        { name: 'web_fetch', input: { url: 'https://example.com' } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('HTTP 200 OK');
      expect(result.output).toContain('<html>hello</html>');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should perform a POST request with body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 201,
        statusText: 'Created',
        headers: new Map([['content-type', 'application/json']]),
        text: () => Promise.resolve('{"id":1}'),
      });

      const result = await toolExecutor.execute(
        {
          name: 'web_fetch',
          input: { url: 'https://api.example.com/items', method: 'POST', body: '{"name":"test"}' },
        },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('HTTP 201 Created');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/items',
        expect.objectContaining({ method: 'POST', body: '{"name":"test"}' })
      );
    });

    it('should fail when url is missing', async () => {
      const result = await toolExecutor.execute({ name: 'web_fetch', input: {} }, makeAgentTool());

      expect(result.success).toBe(false);
      expect(result.error).toContain('url is required');
    });
  });

  // web_search

  describe('execute — web_search', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should parse DuckDuckGo HTML results', async () => {
      const fakeHtml = `
        <a class="result__a" href="https://example.com/page1">Example Page 1</a>
        <a class="result__snippet">This is a snippet about example page one.</a>
        <a class="result__a" href="https://example.com/page2">Example Page 2</a>
        <a class="result__snippet">This is a snippet about example page two.</a>
      `;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(fakeHtml),
      });

      const result = await toolExecutor.execute(
        { name: 'web_search', input: { query: 'example search' } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('Example Page 1');
      expect(result.output).toContain('https://example.com/page1');
      expect(result.output).toContain('Example Page 2');
      expect(result.output).toContain('snippet about example page');
    });

    it('should return no-results message when HTML has no matches', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>No results</body></html>'),
      });

      const result = await toolExecutor.execute(
        { name: 'web_search', input: { query: 'zzzznotfound' } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('No results found');
    });

    it('should fail with a blocked error on the bot-challenge page', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 202,
        text: () =>
          Promise.resolve(
            '<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>'
          ),
      });

      const result = await toolExecutor.execute(
        { name: 'web_search', input: { query: 'example search' } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Web search was blocked by the search provider');
      expect(result.error).toContain('Firecrawl');
    });

    it('should fail with a named error when the search provider is unreachable', async () => {
      global.fetch = jest.fn().mockRejectedValue(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND html.duckduckgo.com'), {
            code: 'ENOTFOUND',
          }),
        })
      );

      const result = await toolExecutor.execute(
        { name: 'web_search', input: { query: 'example search' } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('could not reach the search provider (ENOTFOUND)');
      expect(result.error).toContain('Firecrawl');
    });

    it('should fail when query is missing', async () => {
      const result = await toolExecutor.execute({ name: 'web_search', input: {} }, makeAgentTool());

      expect(result.success).toBe(false);
      expect(result.error).toContain('query is required');
    });
  });

  // database_query

  /** database_query requires an admin-authorized agentId. */
  function makeAdminAgentTool(settings: Record<string, unknown> = {}) {
    return { ...makeAgentTool(settings), agentId: 'clio' };
  }

  // The sandbox itself (reader role, grants, timeouts) is covered against a
  // real reader in tests/integration/apps/server/db/workspaceQuery.test.ts;
  // here the executor contract is checked with the engine stubbed.
  describe('execute — database_query', () => {
    let select: jest.SpiedFunction<typeof WorkspaceQuery.select>;

    beforeEach(() => {
      select = jest.spyOn(WorkspaceQuery, 'select');
    });

    afterEach(() => {
      select.mockRestore();
    });

    it('should format SELECT results as a table', async () => {
      select.mockResolvedValue({
        ok: true,
        columns: ['id', 'name'],
        rows: [
          ['1', 'Test User'],
          ['2', 'Test Agent'],
        ],
        capped: false,
      });

      const result = await toolExecutor.execute(
        { name: 'database_query', input: { sql: 'SELECT id, name FROM users' } },
        makeAdminAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('id | name');
      expect(result.output).toContain('Test User');
      expect(result.output).toContain('Test Agent');
    });

    it('should refuse write queries before they reach the database', async () => {
      const result = await toolExecutor.execute(
        { name: 'database_query', input: { sql: 'DELETE FROM users WHERE id = 1' } },
        makeAdminAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('database_query is read-only');
      expect(result.error).toContain('DELETE');
    });

    it('should refuse write queries even when read_only is false', async () => {
      const result = await toolExecutor.execute(
        { name: 'database_query', input: { sql: "INSERT INTO users (name) VALUES ('test')" } },
        makeAdminAgentTool({ read_only: false })
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('database_query is read-only');
    });

    it('should fail when sql is missing', async () => {
      const result = await toolExecutor.execute(
        { name: 'database_query', input: {} },
        makeAdminAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('sql is required');
    });

    it('should handle empty result set', async () => {
      select.mockResolvedValue({ ok: true, columns: [], rows: [], capped: false });

      const result = await toolExecutor.execute(
        { name: 'database_query', input: { sql: 'SELECT * FROM users WHERE false' } },
        makeAdminAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('No rows returned');
    });
  });

  // screenshot

  describe('execute — screenshot', () => {
    it('should fail when url is missing', async () => {
      const result = await toolExecutor.execute({ name: 'screenshot', input: {} }, makeAgentTool());

      expect(result.success).toBe(false);
      expect(result.error).toContain('url is required');
    });
  });

  // date_time

  describe('execute — date_time', () => {
    it('should return structured datetime payload', async () => {
      const result = await toolExecutor.execute(
        { name: 'date_time', input: { timezone: 'UTC' } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed.timezone).toBe('UTC');
      expect(typeof parsed.iso).toBe('string');
      expect(typeof parsed.formatted).toBe('string');
    });

    it('should fail on invalid timezone', async () => {
      const result = await toolExecutor.execute(
        { name: 'date_time', input: { timezone: 'Invalid/Timezone' } },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid timezone');
    });
  });

  // retired tools

  describe('execute — a retired tool', () => {
    it.each([
      ['url_parse', { url: 'https://example.com/a?x=1' }, /parse the url natively/i],
      ['database_update', { table: 'agents', values: {} }, /table \{op: "write"/],
      ['eslint_check', { path: '.' }, /guarded shell tool/i],
    ])('%s returns its tombstone guidance instead of running', async (name, input, guidance) => {
      const result = await toolExecutor.execute({ name, input }, makeAgentTool());

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/intentionally removed/i);
      expect(result.error).toMatch(guidance);
    });
  });

  // path_resolve

  describe('execute — path_resolve', () => {
    it('should resolve a project file to absolute path', async () => {
      const result = await toolExecutor.execute(
        { name: 'path_resolve', input: { path: 'package.json' } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output) as {
        absolutePath: string;
        exists: boolean;
        kind: string;
      };
      expect(parsed.absolutePath.startsWith('/')).toBe(true);
      expect(parsed.exists).toBe(true);
      expect(parsed.kind).toBe('file');
    });

    it('should fail when path is missing', async () => {
      const result = await toolExecutor.execute(
        { name: 'path_resolve', input: {} },
        makeAgentTool()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required parameter: path');
    });
  });

  // repo_tree

  describe('execute — repo_tree', () => {
    it('should return a tree string', async () => {
      const result = await toolExecutor.execute(
        { name: 'repo_tree', input: { path: '.', depth: 1, maxEntries: 30 } },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('/');
    });
  });

  // find_files

  (hasRg ? describe : describe.skip)('execute — find_files', () => {
    it('should return absolute file paths', async () => {
      const result = await toolExecutor.execute(
        {
          name: 'find_files',
          input: { path: '.', glob: '**/*.ts', nameContains: 'ToolExecutor', maxResults: 20 },
        },
        makeAgentTool()
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output) as { files: string[] };
      expect(Array.isArray(parsed.files)).toBe(true);
      for (const filePath of parsed.files) {
        expect(filePath.startsWith('/')).toBe(true);
      }
    });
  });

  // execute — result structure

  describe('execute — result structure', () => {
    it('should return correct structure on success', async () => {
      const tmpDir = path.join(os.tmpdir(), `snaglet-test-struct-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, 'test.txt');
      await writeFile(tmpFile, 'content');

      try {
        const result = await toolExecutor.execute(
          { name: 'file_read', input: { path: tmpFile } },
          makeAgentTool()
        );

        expect(result.success).toBe(true);
        expect(typeof result.output).toBe('string');
        expect(result.output.length).toBeGreaterThan(0);
        expect(result.error).toBeUndefined();
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should return correct structure on failure', async () => {
      const result = await toolExecutor.execute({ name: 'file_read', input: {} }, makeAgentTool());

      expect(result.success).toBe(false);
      expect(result.output).toBe('');
      expect(typeof result.error).toBe('string');
      expect(result.error!.length).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('canonical catalog lists — old ids stay resolve-only', () => {
    // Lists people pick from drop retired old ids; everything that resolves
    // them (executor, access checks) must keep working against the real registry.
    const live = () => ({ activeToolIds: new Set(toolRegistry.getToolIds()) });

    it('drops old ids the registry does not define, keeps every live tool', () => {
      const ids = ['shell', 'exec_command', 'write_stdin', 'node', 'get_node', 'file'];
      const rows = [...ids, 'file_read', 'sandbox_run'].map((id) => ({ id }));
      expect(canonicalToolRows(rows).map((row) => row.id)).toEqual(['shell', 'node', 'file']);
      const registered = toolRegistry.getToolIds().map((id) => ({ id }));
      expect(canonicalToolRows(registered)).toHaveLength(registered.length);
    });

    it('still runs a call made under an old id', async () => {
      const result = await toolExecutor.execute(
        { name: 'exec_command', input: { cmd: 'echo alias-still-runs' } },
        makeAgentTool()
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('alias-still-runs');
    });

    it('still matches access rules stored under old ids, scoped to their op', () => {
      const allow = {
        mode: 'allow_list' as const,
        allowList: ['exec_command(echo:*)'],
        denyList: [],
      };
      const run = (cmd: string) => ({ op: 'run', cmd });
      expect(evaluateToolPermission(allow, 'shell', run('echo hi'), live()).decision).toBe('allow');
      expect(evaluateToolPermission(allow, 'shell', run('touch x'), live()).decision).toBe('ask');
      expect(
        evaluateToolPermission(allow, 'exec_command', { cmd: 'echo hi' }, live()).decision
      ).toBe('allow');

      const deny = { mode: 'deny_list' as const, allowList: [], denyList: ['archive_node'] };
      expect(evaluateToolPermission(deny, 'node', { op: 'archive' }, live()).decision).toBe('deny');
      expect(evaluateToolPermission(deny, 'node', { op: 'get' }, live()).decision).toBe('allow');
    });
  });

  describe("param-pinned old ids: an allow covers only that old id's calls (real registry)", () => {
    // The production gate (chat dispatch, /execute, the action gateway): judge
    // the call, run it only on `allow`. Old ids such as git_status pin a param
    // other than `op` (git{subcommand}); an allow rule naming one must not
    // turn into an allow for the whole tool.
    type Policy = { mode: 'allow_list' | 'deny_list'; allowList: string[]; denyList: string[] };
    const live = () => ({ activeToolIds: new Set(toolRegistry.getToolIds()) });
    const gated = async (policy: Policy, name: string, input: Record<string, unknown>) => {
      const verdict = evaluateToolPermission(policy, name, input, live());
      if (verdict.decision !== 'allow') {
        return {
          success: false,
          output: '',
          error: `Blocked (${verdict.decision}): ${verdict.reason}`,
        };
      }
      return toolExecutor.execute({ name, input }, makeAgentTool());
    };
    const allowOnly = (...allowList: string[]): Policy => ({
      mode: 'allow_list',
      allowList,
      denyList: [],
    });

    let repo: string;
    let remote: string;
    const remoteBranches = () => execSync('git branch --list', { cwd: remote }).toString().trim();

    beforeEach(async () => {
      const root = path.join(os.tmpdir(), `snaglet-test-gitpins-${Date.now()}-${Math.random()}`);
      repo = path.join(root, 'work');
      remote = path.join(root, 'remote.git');
      await mkdir(repo, { recursive: true });
      execSync(`git init -q --bare ${JSON.stringify(remote)}`);
      execSync(
        'git init -q -b main && git config user.email user@example.com && ' +
          'git config user.name "Test User" && echo a > a.txt && git add a.txt && ' +
          `git commit -qm init && git remote add origin ${JSON.stringify(remote)}`,
        { cwd: repo }
      );
    });
    afterEach(async () => {
      await rm(path.dirname(repo), { recursive: true, force: true });
    });

    it('allow git_status: git status runs, git push is refused and never reaches the remote', async () => {
      const policy = allowOnly('git_status');
      const status = await gated(policy, 'git', { subcommand: 'status', cwd: repo });
      expect(status.success).toBe(true);
      expect(status.output).toContain('main');

      const push = await gated(policy, 'git', {
        subcommand: 'push',
        remote: 'origin',
        branch: 'main',
        cwd: repo,
      });
      expect(push.success).toBe(false);
      expect(push.error).toMatch(/Blocked \(ask\)/);
      expect(remoteBranches()).toBe('');

      // The old push id is refused the same way.
      const oldPush = await gated(policy, 'git_push', {
        remote: 'origin',
        branch: 'main',
        cwd: repo,
      });
      expect(oldPush.success).toBe(false);
      expect(remoteBranches()).toBe('');
    });

    it('a call through the old id itself still runs under its own allow', async () => {
      const result = await gated(allowOnly('git_status'), 'git_status', { cwd: repo });
      expect(result.success).toBe(true);
      expect(result.output).toContain('main');
    });

    it('allow git (canonical) still pushes', async () => {
      const push = await gated(allowOnly('git'), 'git', {
        subcommand: 'push',
        remote: 'origin',
        branch: 'main',
        cwd: repo,
      });
      expect(push.success).toBe(true);
      expect(remoteBranches()).toContain('main');
    });

    it('deny git_push blocks the whole git tool (status too)', async () => {
      const policy: Policy = { mode: 'deny_list', allowList: [], denyList: ['git_push'] };
      for (const subcommand of ['push', 'status']) {
        const result = await gated(policy, 'git', {
          subcommand,
          remote: 'origin',
          branch: 'main',
          cwd: repo,
        });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Blocked \(deny\)/);
      }
      expect(remoteBranches()).toBe('');
    });

    it('allow google_gmail_send: send is covered, read/list/delete are refused', () => {
      const policy = allowOnly('google_gmail_send');
      const judge = (input: Record<string, unknown>) =>
        evaluateToolPermission(policy, 'google_gmail', input, live()).decision;
      expect(judge({ operation: 'send', to: 'user@example.com' })).toBe('allow');
      for (const operation of ['get_message', 'list', 'search', 'delete', 'trash']) {
        expect(judge({ operation })).toBe('ask');
      }
    });

    it.each([
      ['send_imessage', 'imessage', { operation: 'send' }, { operation: 'read' }],
      ['snapshot_doc', 'doc_history', { operation: 'snapshot' }, { operation: 'delete' }],
      ['doc_search', 'search', { kind: 'docs' }, { kind: 'code' }],
      ['path_resolve', 'resolve_path', { domain: 'filesystem' }, { domain: 'workspace' }],
      ['workspace_orient', 'orient', { mode: 'workspace' }, { mode: 'local' }],
      ['update_identity', 'agent', { op: 'update', scope: 'self' }, { op: 'update' }],
      ['view_image', 'file', { op: 'read', mode: 'image' }, { op: 'read' }],
    ])('allow %s covers only its own calls on %s', (entry, toolId, covered, refused) => {
      const policy = allowOnly(entry);
      expect(evaluateToolPermission(policy, toolId, covered, live()).decision).toBe('allow');
      expect(evaluateToolPermission(policy, toolId, refused, live()).decision).toBe('ask');
    });

    it('shell rules stored under old ids are unaffected', async () => {
      const policy = allowOnly('shell_exec(echo:*)');
      const ok = await gated(policy, 'shell', { op: 'run', cmd: 'echo pins-ok' });
      expect(ok.success).toBe(true);
      expect(ok.output).toContain('pins-ok');
      const refused = await gated(policy, 'shell', { op: 'run', cmd: 'touch x', workdir: repo });
      expect(refused.success).toBe(false);
    });
  });
});
