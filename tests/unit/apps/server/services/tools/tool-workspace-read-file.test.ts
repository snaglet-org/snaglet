/**
 * ToolWorkspaceService.readFile — the 404-vs-500 contract.
 *
 * Absence of a workspace file must surface as an AppError NOT_FOUND (→ HTTP
 * 404 via the global errorHandler), not a plain Error (→ generic 500). The
 * desktop tool builder branches on exactly this distinction: a 404 means
 * "file genuinely absent, start the Code editor empty", while any other
 * failure blocks code editing so a transient crash can never be mistaken for
 * an empty file and silently overwritten on save (updateFiles is a
 * full-file overwrite). See ToolBuilderPanel's code-load effect.
 *
 * TOOL_WORKSPACES_DIR is read at module load, so it's set before the dynamic
 * import (the standard ESM pattern for env-sensitive modules).
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';

const TOOL_TS_CONTENT = 'export default async function handler(input) {\n  return input;\n}\n';

let workspacesDir: string;
let service: typeof import('@server/services/ToolService/ToolWorkspaceService').toolWorkspaceService;

beforeAll(async () => {
  workspacesDir = await mkdtemp(path.join(tmpdir(), 'snaglet-tool-ws-readfile-'));
  process.env.TOOL_WORKSPACES_DIR = workspacesDir;
  ({ toolWorkspaceService: service } =
    await import('@server/services/ToolService/ToolWorkspaceService'));

  await mkdir(path.join(workspacesDir, 'my-tool'), { recursive: true });
  await writeFile(path.join(workspacesDir, 'my-tool', 'tool.ts'), TOOL_TS_CONTENT, 'utf-8');
});

afterAll(async () => {
  delete process.env.TOOL_WORKSPACES_DIR;
  await rm(workspacesDir, { recursive: true, force: true });
});

describe('ToolWorkspaceService.readFile', () => {
  it('returns the file content when the file exists', () => {
    expect(service.readFile('my-tool', 'tool.ts')).toBe(TOOL_TS_CONTENT);
  });

  it('throws an operational AppError NOT_FOUND (→ 404) for a missing file in an existing workspace', () => {
    let thrown: unknown;
    try {
      service.readFile('my-tool', 'definition.json');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    expect(appError.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    expect(appError.code).toBe(ErrorCode.NOT_FOUND);
    // Operational → the errorHandler forwards the real statusCode instead of
    // collapsing to a generic 500.
    expect(appError.isOperational).toBe(true);
    expect(appError.message).toContain('definition.json');
  });

  it('throws the same AppError NOT_FOUND when the whole workspace folder is missing', () => {
    let thrown: unknown;
    try {
      service.readFile('no-such-tool', 'tool.ts');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(HTTP_STATUS.NOT_FOUND);
  });
});

describe('ToolWorkspaceService — path-traversal defenses', () => {
  it('readFile rejects a non-whitelisted file name with a 400 (not a 404, not a read)', () => {
    let thrown: unknown;
    try {
      service.readFile('my-tool', 'package.json'); // real file the service writes, but not readable via this path
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    expect((thrown as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('readFile rejects ../ traversal file names (decoded %2f arrives as literal ../) with a 400', () => {
    for (const evil of ['../../../../etc/passwd', '../tool.ts', 'sub/tool.ts', '/etc/passwd']) {
      let thrown: unknown;
      try {
        service.readFile('my-tool', evil);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    }
  });

  it('updateFiles rejects an adversarial body key that escapes the sandbox — and writes nothing', async () => {
    await mkdir(path.join(workspacesDir, 'write-guard'), { recursive: true });
    await writeFile(
      path.join(workspacesDir, 'write-guard', 'tool.ts'),
      'export default 1;\n',
      'utf-8'
    );
    const canary = path.join(workspacesDir, '..', 'snaglet-tool-escape-canary.txt');
    await rm(canary, { force: true });

    await expect(
      service.updateFiles('write-guard', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['../../../../snaglet-tool-escape-canary.txt' as any]: 'pwned',
      } as never)
    ).rejects.toBeInstanceOf(AppError);

    expect(existsSync(canary)).toBe(false);
    expect(service.readFile('write-guard', 'tool.ts')).toBe('export default 1;\n');
  });

  it('updateFiles rejects a mixed valid+adversarial body atomically (the valid tool.ts is not written either)', async () => {
    await mkdir(path.join(workspacesDir, 'atomic-guard'), { recursive: true });
    await writeFile(
      path.join(workspacesDir, 'atomic-guard', 'tool.ts'),
      'export default 1;\n',
      'utf-8'
    );
    await expect(
      service.updateFiles('atomic-guard', {
        'tool.ts': 'export default 2;\n',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['../evil.txt' as any]: 'x',
      } as never)
    ).rejects.toBeInstanceOf(AppError);
    expect(service.readFile('atomic-guard', 'tool.ts')).toBe('export default 1;\n');
  });

  it('the legitimate whitelisted files still read and write normally (definition.json, tool.ts, TOOL.md)', async () => {
    await mkdir(path.join(workspacesDir, 'happy-tool'), { recursive: true });
    await service.updateFiles('happy-tool', {
      'definition.json': '{"name":"happy-tool"}',
      'tool.ts': 'export default async () => 42;\n',
      'TOOL.md': '# happy-tool\n',
    });
    expect(service.readFile('happy-tool', 'tool.ts')).toBe('export default async () => 42;\n');
    expect(service.readFile('happy-tool', 'definition.json')).toBe('{"name":"happy-tool"}');
    expect(service.readFile('happy-tool', 'TOOL.md')).toBe('# happy-tool\n');
  });

  it('toolDir sanitizing to empty is an operational 400, not a plain-Error 500', () => {
    let thrown: unknown;
    try {
      service.readFile('!!!', 'tool.ts');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
  });
});
