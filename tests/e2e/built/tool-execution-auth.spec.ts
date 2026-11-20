import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { BuiltWorkspace } from '../helpers/builtWorkspace';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CLI_ENTRY = resolve(REPO_ROOT, 'packages/snaglet-cli/bin/snaglet.mjs');

interface CapturedProcess {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

interface HookRunResponse {
  runs: Array<{
    result: {
      ok: boolean;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    };
  }>;
}

function runCaptured(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<CapturedProcess> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolveProcess({ code, signal, stdout, stderr });
    });
  });
}

function filesContaining(root: string, needle: string): string[] {
  const matches: string[] = [];
  const visit = (path: string): void => {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (!stats.isFile()) return;
    try {
      if (readFileSync(path).includes(Buffer.from(needle))) matches.push(relative(root, path));
    } catch {
      // A live PostgreSQL file can disappear between directory enumeration and read.
    }
  };
  visit(root);
  return matches.sort();
}

test.describe.configure({ mode: 'serial' });

test('built server compiles a hook and supports packaged CLI and child-dispatch auth', async () => {
  test.setTimeout(300_000);
  const authToken = `built-auth-${randomBytes(32).toString('hex')}`;
  const workspace = await BuiltWorkspace.boot({ authToken });
  let disposed = false;

  try {
    const runtimeDir = join(workspace.homePath, 'runtime');
    const sessionPath = join(runtimeDir, 'desktop-cli-session.json');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      sessionPath,
      `${JSON.stringify({ serverUrl: workspace.baseUrl, sidecarToken: authToken })}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    chmodSync(sessionPath, 0o600);

    const cliScriptPath = join(workspace.homePath, 'scripts', 'built-auth-smoke.mjs');
    mkdirSync(dirname(cliScriptPath), { recursive: true });
    writeFileSync(
      cliScriptPath,
      [
        "import { tools } from '@snaglet/sdk';",
        'const result = await tools.get_current_datetime({});',
        "console.log('CLI_TOOL_AUTH_OK', JSON.stringify(result));",
        '',
      ].join('\n'),
      'utf8'
    );

    const cli = await runCaptured(process.execPath, [CLI_ENTRY, 'run', cliScriptPath], {
      cwd: workspace.homePath,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        SNAGLET_HOME: workspace.homePath,
      },
    });
    expect(cli).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(cli.stdout).toContain('CLI_TOOL_AUTH_OK');
    expect(cli.stdout).not.toContain(authToken);
    expect(cli.stderr).not.toContain(authToken);

    const headers = {
      'Content-Type': 'application/json',
      'X-Snaglet-Token': authToken,
      'X-Snaglet-Sidecar-Token': authToken,
    };
    const hookName = 'built-auth-child-dispatch';
    const hookSource = [
      "import { defineHook, snaglet } from '@snaglet/sdk';",
      'export default defineHook({',
      "  on: 'schedule:fire',",
      '  async run() {',
      "    const result = await snaglet.tools.execute('get_current_datetime', {});",
      "    if (!result?.success) throw new Error('nested tool execution failed');",
      "    console.log('HOOK_CHILD_AUTH_OK', result.output);",
      '  },',
      '});',
      '',
    ].join('\n');

    const createResponse = await fetch(`${workspace.apiUrl}/hooks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ hookName, files: { 'hook.ts': hookSource } }),
    });
    expect(createResponse.status).toBe(201);

    const checkResponse = await fetch(`${workspace.apiUrl}/hooks/${hookName}/check`, {
      method: 'POST',
      headers,
    });
    expect(checkResponse.ok).toBe(true);
    const check = (await checkResponse.json()) as ApiEnvelope<{
      registration: { buildStatus: string; lastError: string | null };
    }>;
    expect(check.success).toBe(true);
    expect(check.data.registration).toMatchObject({ buildStatus: 'ready', lastError: null });
    expect(
      statSync(join(workspace.homePath, 'build', 'hooks', hookName, 'hook.cjs')).isFile()
    ).toBe(true);

    const runResponse = await fetch(`${workspace.apiUrl}/hooks/${hookName}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ eventName: 'schedule:fire' }),
    });
    expect(runResponse.ok).toBe(true);
    const hookRun = (await runResponse.json()) as ApiEnvelope<HookRunResponse>;
    expect(hookRun.success).toBe(true);
    expect(hookRun.data.runs).toHaveLength(1);
    expect(hookRun.data.runs[0]?.result).toMatchObject({
      ok: true,
      exitCode: 0,
      stderr: '',
      timedOut: false,
    });
    expect(hookRun.data.runs[0]?.result.stdout).toContain('HOOK_CHILD_AUTH_OK');
    expect(hookRun.data.runs[0]?.result.stdout).not.toContain(authToken);

    expect(workspace.serverOutput).not.toContain(authToken);
    expect(workspace.sensitiveServerOutputSeen).toBe(false);
    expect(filesContaining(workspace.runtimePath, authToken)).toEqual([
      'home/runtime/desktop-cli-session.json',
    ]);

    await expect(workspace.dispose()).resolves.toBeUndefined();
    disposed = true;
    expect(workspace.sensitiveServerOutputSeen).toBe(false);
  } finally {
    if (!disposed) await workspace.dispose();
  }
});
