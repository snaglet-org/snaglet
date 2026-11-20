import { execFile, spawn } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import type { ExecFileOptions } from 'node:child_process';
import { tmpdir } from 'os';
import path from 'path';
import { isHttpUrl } from '@snaglet/shared/utils';
import { buildCommandEnv } from '@server/services/ToolService/lib/buildSafeEnv';

export function validatePathConstraint(filePath: string, settings: Record<string, unknown>): void {
  const rootDir = settings.root_dir as string | undefined;
  if (rootDir) {
    const canonicalize = (target: string): string => {
      const absolute = path.resolve(target);
      let existing = absolute;
      while (!existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
      return path.join(realpathSync(existing), path.relative(existing, absolute));
    };
    const resolved = canonicalize(filePath);
    const root = canonicalize(rootDir);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Path '${filePath}' is outside the allowed root directory: ${rootDir}`);
    }
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readPathOrLiteral(
  candidate: string,
  settings: Record<string, unknown>
): Promise<{ value: string; source: 'path' | 'literal' }> {
  if (await pathExists(candidate)) {
    validatePathConstraint(candidate, settings);
    return { value: await readFile(candidate, 'utf8'), source: 'path' };
  }

  return { value: candidate, source: 'literal' };
}

/**
 * Run a fixed program for a tool call. Without an explicit `env` it gets buildCommandEnv(),
 * never the server's own environment: git in particular runs hooks and other commands the
 * (agent-chosen) working directory controls.
 */
export async function runExecFile(
  command: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = options.env ?? buildCommandEnv();
    execFile(command, args, { ...options, env }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code !== 'number') {
        reject(error);
        return;
      }

      resolve({
        code:
          typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
            ? Number((error as NodeJS.ErrnoException).code)
            : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

/** runExecFile with binary stdout; the same environment rule applies. */
export async function runExecFileBuffer(
  command: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = options.env ?? buildCommandEnv();
    execFile(command, args, { ...options, env, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code !== 'number') {
        reject(error);
        return;
      }

      resolve({
        code:
          typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
            ? Number((error as NodeJS.ErrnoException).code)
            : 0,
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
        stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
      });
    });
  });
}

/** `env` is required: without one the child would inherit the server's environment. */
async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    stdin?: string;
    timeoutMs?: number;
  }
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs)
        : null;

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr, timedOut });
    });

    if (typeof options.stdin === 'string' && options.stdin.length > 0) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export async function resolvePathOrDownload(
  source: string,
  settings: Record<string, unknown>,
  prefix: string,
  fallbackExtension = '.bin'
): Promise<{ path: string; source: 'path' | 'url'; cleanup: () => Promise<void> }> {
  if (!isHttpUrl(source)) {
    validatePathConstraint(source, settings);
    return {
      path: source,
      source: 'path',
      cleanup: async () => {},
    };
  }

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to download ${source}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const tempDir = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  const url = new URL(source);
  const baseName = path.basename(url.pathname) || 'input';
  const extension = path.extname(baseName) || fallbackExtension;
  const filePath = path.join(tempDir, `download${extension}`);
  await writeFile(filePath, bytes);

  return {
    path: filePath,
    source: 'url',
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function runSwiftScript(
  source: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return runProcess('swift', ['-module-cache-path', '/tmp/swift-module-cache', '-', ...args], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 60_000,
    stdin: source,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
  });
}
