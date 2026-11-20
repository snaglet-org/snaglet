/**
 * ToolWorkspaceService: manages on-disk workspaces for user-created tools.
 *
 * Each tool gets its own directory under TOOL_WORKSPACES_DIR,
 * `{workspacesDir}/{tool-id}/`, holding package.json, definition.json,
 * tool.ts, TOOL.md and (after install) node_modules/.
 *
 * Lifecycle:  create → writeFiles → install → build → (execute via ToolExecutor)
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import crossSpawn from 'cross-spawn';
import { logger } from '@server/config/logger';
import {
  AppError,
  elapsedMs,
  getErrorMessage,
  isToolId,
  safeJsonParse,
} from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { SNAGLET_TOOLS_DIR } from '@server/services/snagletHome';
import { buildToolBundle, BUILT_TOOL_RELATIVE } from './customTools/buildToolBundle';
import { buildCommandEnv } from './lib/buildSafeEnv';
import { resolveLoginShellPath } from './lib/loginShellPath';
import { killProcessTree } from '@server/utils/processes';

// Default to `<snaglet-home>/tools` (respects SNAGLET_HOME / the per-worktree override) so
// the REST-created workspaces land in the same directory the folder-drop scanner
// watches. Still overridable via TOOL_WORKSPACES_DIR for tests/tooling.
const WORKSPACES_DIR = process.env.TOOL_WORKSPACES_DIR ?? SNAGLET_TOOLS_DIR;

const LOG_PREFIX = '\x1b[35m[tool-workspace]\x1b[0m';

/**
 * The only file names this service will read or write inside a workspace:
 * exactly the authored `WorkspaceFiles` set (`package.json` is scaffolded by
 * `create` under a fixed name and never read back through `readFile`). A hard
 * whitelist, not a sanitizer: `fileName` / PUT-body keys arrive
 * percent-decoded from HTTP (`..%2f..%2fetc%2fpasswd` reaches here as
 * `../../etc/passwd`), so a naive `path.join(toolDir, name)` would allow
 * arbitrary reads and writes outside the workspace. Anything not on this list
 * is a 400 before any fs call.
 */
export const TOOL_WORKSPACE_FILE_NAMES = ['definition.json', 'tool.ts', 'TOOL.md'] as const;

function assertAllowedWorkspaceFile(fileName: string): void {
  if (!(TOOL_WORKSPACE_FILE_NAMES as readonly string[]).includes(fileName)) {
    throw new AppError(
      `Invalid workspace file name "${fileName}" — expected one of: ${TOOL_WORKSPACE_FILE_NAMES.join(', ')}`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
}

/**
 * Belt-and-braces containment gate BEHIND the whitelist: resolve the final
 * path and require it to stay inside the workspace dir. The whitelist alone
 * already guarantees this (its entries are bare literal names); this second
 * check means a future whitelist edit can never silently reopen the
 * traversal — defense in depth, not the primary control.
 */
function assertInsideDir(baseDir: string, candidatePath: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(candidatePath);
  const relative = path.relative(resolvedBase, resolved);
  if (
    relative !== '' &&
    (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  ) {
    throw new AppError(
      'Resolved file path escapes the tool workspace',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
}

export interface WorkspaceFiles {
  'definition.json': string;
  'tool.ts': string;
  'TOOL.md': string;
}

export interface WorkspaceInfo {
  toolId: string;
  dir: string;
  files: string[];
  hasNodeModules: boolean;
  hasBuild: boolean;
  definition: Record<string, unknown> | null;
}

export interface BuildResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/**
 * Plain words for a spawn that failed because `command` is not on PATH (the
 * raw error is `spawn pnpm ENOENT`), else null.
 */
function missingCommandMessage(command: string, err: unknown): string | null {
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
  if (code !== 'ENOENT') return null;
  return `Snaglet could not find ${command}. Install it, or add its folder to your shell's PATH, then restart Snaglet.`;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // Snaglet.app opened from the Dock or Finder inherits launchd's PATH
  // (/usr/bin:/bin:/usr/sbin:/sbin), which has no pnpm; use the login shell's.
  // The lookup starts at boot, settles within about six seconds even when the
  // shell hangs (then the inherited PATH stays), and never rejects.
  await resolveLoginShellPath();
  // pnpm runs the workspace's install scripts and .pnpmfile.cjs, which an agent can write,
  // so it gets buildCommandEnv(), never the server's own environment. HOME and the XDG
  // folders stay, so pnpm finds its store, cache and ~/.npmrc; NODE_OPTIONS (startup hooks
  // that cannot resolve from a tool folder) and npm_config_* (registry tokens) stay out.
  const env = buildCommandEnv();
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function scaffoldPackageJson(toolId: string): string {
  // No `@snaglet/sdk` dependency and no `workspace:*` protocol: the SDK is vendored +
  // bundled by buildToolBundle (see customTools/), so a folder created OUTSIDE
  // the monorepo installs and builds cleanly. The build itself runs through the
  // server's esbuild — this script is only a convenience for hand builds.
  return JSON.stringify(
    {
      name: `snaglet-tool-${toolId}`,
      version: '1.0.0',
      private: true,
      main: BUILT_TOOL_RELATIVE,
    },
    null,
    2
  );
}

class ToolWorkspaceServiceClass {
  private get dir(): string {
    return WORKSPACES_DIR;
  }

  /** Ensure the root workspaces directory exists. */
  private ensureRoot(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      logger.info(`${LOG_PREFIX} Created workspaces directory: ${this.dir}`);
    }
  }

  /** Get the workspace directory for a tool. A name that sanitizes to
   *  nothing is a client input error → operational 400, not a generic 500
   *  (kept consistent with HookWorkspaceService.hookDir). */
  private toolDir(toolId: string): string {
    // Require the canonical direct-child spelling. Silently stripping invalid
    // characters aliases distinct request/DB identities onto one folder (for
    // example `foo!` and `foo?` both becoming `foo`), which breaks scanner
    // locking and removal ownership.
    if (!isToolId(toolId)) {
      throw new AppError(
        'Invalid tool id — use only letters, numbers, "-", or "_"',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    return path.join(this.dir, toolId);
  }

  /** Canonical direct-child name used by both workspace IO and FolderScanner locking. */
  getFolderName(toolId: string): string {
    return path.basename(this.toolDir(toolId));
  }

  /**
   * Create a new tool workspace and write the initial files.
   * If the workspace already exists, it will be overwritten.
   */
  async create(toolId: string, files: WorkspaceFiles): Promise<WorkspaceInfo> {
    this.ensureRoot();
    const dir = this.toolDir(toolId);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write package.json if it doesn't exist yet
    const pkgPath = path.join(dir, 'package.json');
    if (!existsSync(pkgPath)) {
      writeFileSync(pkgPath, scaffoldPackageJson(toolId), 'utf-8');
    }

    // Write user files
    writeFileSync(path.join(dir, 'definition.json'), files['definition.json'], 'utf-8');
    writeFileSync(path.join(dir, 'tool.ts'), files['tool.ts'], 'utf-8');
    writeFileSync(path.join(dir, 'TOOL.md'), files['TOOL.md'], 'utf-8');

    logger.info(`${LOG_PREFIX} Created workspace for "${toolId}" at ${dir}`);
    return this.getInfo(toolId);
  }

  /**
   * Update specific files in an existing workspace. Every key in `files` is
   * validated against the whitelist before any write: `files` is a raw HTTP
   * JSON body (PUT /workspaces/:toolId/files), so a key like
   * `"../../../../tmp/evil"` must be a 400, never a write. All keys are
   * checked first, then written, so a request mixing one valid and one
   * adversarial key is rejected atomically rather than half-applied.
   */
  async updateFiles(toolId: string, files: Partial<WorkspaceFiles>): Promise<WorkspaceInfo> {
    const dir = this.toolDir(toolId);
    if (!existsSync(dir)) {
      throw new Error(`Workspace for "${toolId}" does not exist`);
    }

    const entries = Object.entries(files).filter(([, content]) => content !== undefined);
    for (const [name] of entries) {
      assertAllowedWorkspaceFile(name);
      assertInsideDir(dir, path.join(dir, name));
    }
    for (const [name, content] of entries) {
      writeFileSync(path.join(dir, name), content as string, 'utf-8');
    }

    return this.getInfo(toolId);
  }

  /** Install dependencies for a tool workspace. */
  async install(toolId: string): Promise<BuildResult> {
    const dir = this.toolDir(toolId);
    if (!existsSync(dir)) {
      throw new Error(`Workspace for "${toolId}" does not exist`);
    }

    const t0 = Date.now();
    logger.info(`${LOG_PREFIX} Installing dependencies for "${toolId}"...`);

    try {
      const result = await runCommand('pnpm', ['install', '--no-frozen-lockfile'], dir, 120_000);
      const output = (result.stdout + '\n' + result.stderr).trim();

      if (result.code !== 0) {
        // The UI's error state only had room for the one-line `error` summary
        // before `output` was wired through end to end — log the
        // real pnpm stdout+stderr here too, at warn (not error: a bad
        // tool-authored package.json is an operational/user event, not a
        // server bug), so a report that isn't reproducible from the UI alone
        // still has the actual failure text in the server logs.
        logger.warn(
          `${LOG_PREFIX} pnpm install failed for "${toolId}" (exit ${result.code}):\n${output}`
        );
        return {
          success: false,
          output,
          error: `pnpm install exited with code ${result.code}`,
          durationMs: elapsedMs(t0),
        };
      }

      logger.info(`${LOG_PREFIX} Dependencies installed for "${toolId}" (${elapsedMs(t0)}ms)`);
      return { success: true, output, durationMs: elapsedMs(t0) };
    } catch (err) {
      const msg = getErrorMessage(err);
      logger.warn(`${LOG_PREFIX} pnpm install failed for "${toolId}":\n${msg}`);
      return {
        success: false,
        output: msg,
        error: missingCommandMessage('pnpm', err) ?? msg,
        durationMs: elapsedMs(t0),
      };
    }
  }

  /**
   * Build a tool workspace into a self-contained `dist/tool.cjs`. Delegates to
   * the shared bundler, which vendors `@snaglet/sdk` and runs the server's own
   * esbuild — no `pnpm install`, no registry, works outside the monorepo.
   */
  async build(toolId: string): Promise<BuildResult> {
    const dir = this.toolDir(toolId);
    if (!existsSync(dir)) {
      throw new Error(`Workspace for "${toolId}" does not exist`);
    }

    logger.info(`${LOG_PREFIX} Building "${toolId}"...`);
    const result = await buildToolBundle(dir);
    if (result.success) {
      logger.info(`${LOG_PREFIX} Built "${toolId}" (${result.durationMs}ms)`);
    }
    return {
      success: result.success,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
    };
  }

  /** Full pipeline: write files → install → build. */
  async createAndBuild(
    toolId: string,
    files: WorkspaceFiles
  ): Promise<{
    info: WorkspaceInfo;
    install: BuildResult;
    build: BuildResult;
  }> {
    const info = await this.create(toolId, files);
    const installResult = await this.install(toolId);
    if (!installResult.success) {
      return {
        info,
        install: installResult,
        build: { success: false, output: '', error: 'Skipped — install failed', durationMs: 0 },
      };
    }
    const buildResult = await this.build(toolId);
    return { info, install: installResult, build: buildResult };
  }

  /** Get info about a tool workspace. */
  getInfo(toolId: string): WorkspaceInfo {
    const dir = this.toolDir(toolId);
    if (!existsSync(dir)) {
      throw new Error(`Workspace for "${toolId}" does not exist`);
    }

    const files = readdirSync(dir).filter((f) => f !== 'node_modules' && f !== 'dist');
    const hasNodeModules = existsSync(path.join(dir, 'node_modules'));
    const hasBuild = existsSync(path.join(dir, BUILT_TOOL_RELATIVE));

    let definition: Record<string, unknown> | null = null;
    const defPath = path.join(dir, 'definition.json');
    if (existsSync(defPath)) {
      try {
        definition = safeJsonParse<Record<string, unknown> | null>(
          readFileSync(defPath, 'utf-8'),
          null
        );
      } catch {
        // the file can vanish between the existence check and the read
      }
    }

    return { toolId, dir, files, hasNodeModules, hasBuild, definition };
  }

  /** List all tool workspaces. */
  listAll(): WorkspaceInfo[] {
    this.ensureRoot();
    const entries = readdirSync(this.dir, { withFileTypes: true });
    const results: WorkspaceInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        results.push(this.getInfo(entry.name));
      } catch {
        // skip broken workspaces
      }
    }

    return results;
  }

  /** Delete a tool workspace. */
  delete(toolId: string): void {
    const dir = this.toolDir(toolId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      logger.info(`${LOG_PREFIX} Deleted workspace for "${toolId}"`);
    }
  }

  /** Check if a workspace exists. */
  exists(toolId: string): boolean {
    return existsSync(this.toolDir(toolId));
  }

  /**
   * Read a file from a workspace.
   *
   * Absence is an `AppError` NOT_FOUND (→ HTTP 404 via the global
   * errorHandler), not a plain Error (→ generic 500): the tool builder must
   * tell "this file doesn't exist" (it then starts its Code editor empty) from
   * a genuine read failure, or it could treat a crash as "absent" and
   * overwrite the real tool.ts on save. Genuine I/O failures still propagate
   * as a 500.
   *
   * `fileName` is whitelisted first (→ 400): it arrives percent-decoded from
   * an HTTP route param, so `../`-style values must never reach the fs. The
   * 404 stays reserved for a legitimately-named file that is absent.
   */
  readFile(toolId: string, fileName: string): string {
    assertAllowedWorkspaceFile(fileName);
    const dir = this.toolDir(toolId);
    const filePath = path.join(dir, fileName);
    assertInsideDir(dir, filePath);
    if (!existsSync(filePath)) {
      throw new AppError(
        `File "${fileName}" not found in workspace "${toolId}"`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    return readFileSync(filePath, 'utf-8');
  }

  /** Get the path to the built tool entry point. */
  getBuiltToolPath(toolId: string): string | null {
    const builtPath = path.join(this.toolDir(toolId), BUILT_TOOL_RELATIVE);
    return existsSync(builtPath) ? builtPath : null;
  }

  /** Get the workspaces root directory. */
  getWorkspacesDir(): string {
    return this.dir;
  }
}

export const toolWorkspaceService = new ToolWorkspaceServiceClass();
