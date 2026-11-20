/**
 * HookWorkspaceService — the on-disk CRUD surface for the GUI hook builder:
 * readFile's 404-vs-500 contract (as in ToolWorkspaceService.readFile), the
 * create/updateFiles/getInfo/listAll/quarantine-delete round trip, and
 * folder-safe name sanitization. HOOK_WORKSPACES_DIR is read at module load,
 * so it is set before the dynamic import.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';

const HOOK_TS_CONTENT =
  "import { defineHook, snaglet } from '@snaglet/sdk';\n\nexport default defineHook({\n  on: 'message:create',\n  async run(event) {\n    await snaglet.log.info(String(event.type));\n  },\n});\n";

let hooksDir: string;
let service: typeof import('@server/services/customHooks/HookWorkspaceService').hookWorkspaceService;

beforeAll(async () => {
  hooksDir = await mkdtemp(path.join(tmpdir(), 'snaglet-hook-ws-'));
  process.env.HOOK_WORKSPACES_DIR = hooksDir;
  ({ hookWorkspaceService: service } =
    await import('@server/services/customHooks/HookWorkspaceService'));

  await mkdir(path.join(hooksDir, 'my-hook'), { recursive: true });
  await writeFile(path.join(hooksDir, 'my-hook', 'hook.ts'), HOOK_TS_CONTENT, 'utf-8');
});

afterAll(async () => {
  delete process.env.HOOK_WORKSPACES_DIR;
  await rm(hooksDir, { recursive: true, force: true });
});

describe('HookWorkspaceService.readFile', () => {
  it('returns the file content when the file exists', () => {
    expect(service.readFile('my-hook', 'hook.ts')).toBe(HOOK_TS_CONTENT);
  });

  it('throws an operational AppError NOT_FOUND (→ 404) for a whitelisted-but-absent file in an existing workspace', async () => {
    // A folder that exists but has no hook.ts yet — hook.ts is a legitimate
    // (whitelisted) name, so this reaches the existsSync check and is a real
    // 404, distinct from the 400 an unknown name gets.
    await mkdir(path.join(hooksDir, 'empty-ws'), { recursive: true });
    let thrown: unknown;
    try {
      service.readFile('empty-ws', 'hook.ts');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    expect(appError.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    expect(appError.code).toBe(ErrorCode.NOT_FOUND);
    expect(appError.isOperational).toBe(true);
  });

  it('throws the same AppError NOT_FOUND when the whole workspace folder is missing', () => {
    let thrown: unknown;
    try {
      service.readFile('no-such-hook', 'hook.ts');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(HTTP_STATUS.NOT_FOUND);
  });
});

describe('HookWorkspaceService — path-traversal defenses', () => {
  // A canary written outside the hooks root: no traversal read/write may ever
  // reach it, because the service must 400 before touching the fs at all.
  it('readFile rejects a non-whitelisted file name with a 400 (not a 404, not a read)', () => {
    let thrown: unknown;
    try {
      service.readFile('my-hook', 'HOOK.md');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    expect((thrown as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('readFile rejects a ../ traversal file name (decoded %2f arrives as literal ../) with a 400', () => {
    // Express percent-decodes route params, so ..%2f..%2fetc%2fpasswd reaches
    // the service as this literal string. It must be rejected before any fs read.
    for (const evil of ['../../../../etc/passwd', '../hook.ts', 'sub/hook.ts', '/etc/passwd']) {
      let thrown: unknown;
      try {
        service.readFile('my-hook', evil);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    }
  });

  it('updateFiles rejects an adversarial body key that escapes the sandbox — and writes nothing', async () => {
    await service.create('write-guard', { 'hook.ts': 'export default 1;\n' });
    const canary = path.join(hooksDir, '..', 'snaglet-hook-escape-canary.txt');
    await rm(canary, { force: true });

    await expect(
      service.updateFiles('write-guard', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['../../../../snaglet-hook-escape-canary.txt' as any]: 'pwned',
      } as never)
    ).rejects.toBeInstanceOf(AppError);

    expect(existsSync(canary)).toBe(false);
    // The legitimate file is untouched — the whole request was rejected atomically.
    expect(service.readFile('write-guard', 'hook.ts')).toBe('export default 1;\n');
  });

  it('updateFiles rejects a mixed valid+adversarial body atomically (the valid key is not written either)', async () => {
    await service.create('atomic-guard', { 'hook.ts': 'export default 1;\n' });
    await expect(
      service.updateFiles('atomic-guard', {
        'hook.ts': 'export default 2;\n',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['../evil.txt' as any]: 'x',
      } as never)
    ).rejects.toBeInstanceOf(AppError);
    // hook.ts must still be the original — no half-applied write.
    expect(service.readFile('atomic-guard', 'hook.ts')).toBe('export default 1;\n');
  });

  it('the legitimate hook.ts path still reads and writes normally', async () => {
    await service.create('happy-path', { 'hook.ts': 'export default 1;\n' });
    await service.updateFiles('happy-path', { 'hook.ts': 'export default 42;\n' });
    expect(service.readFile('happy-path', 'hook.ts')).toBe('export default 42;\n');
  });
});

describe('HookWorkspaceService — create/update/list/quarantine delete', () => {
  it('create() writes hook.ts and getInfo() reflects it', async () => {
    const info = await service.create('created-hook', { 'hook.ts': HOOK_TS_CONTENT });
    expect(info.hookName).toBe('created-hook');
    expect(info.files).toContain('hook.ts');
    expect(info.hasBuild).toBe(false); // never builds — the scanner owns that
    expect(service.readFile('created-hook', 'hook.ts')).toBe(HOOK_TS_CONTENT);
  });

  it('create() is idempotent-overwrite, matching ToolWorkspaceService.create', async () => {
    await service.create('overwrite-hook', { 'hook.ts': 'export default 1;\n' });
    await service.create('overwrite-hook', { 'hook.ts': 'export default 2;\n' });
    expect(service.readFile('overwrite-hook', 'hook.ts')).toBe('export default 2;\n');
  });

  it('updateFiles() overwrites hook.ts for an existing workspace', async () => {
    await service.create('update-me', { 'hook.ts': 'export default 1;\n' });
    const updated = 'export default 2;\n';
    await service.updateFiles('update-me', { 'hook.ts': updated });
    expect(service.readFile('update-me', 'hook.ts')).toBe(updated);
  });

  it('updateFiles() throws a plain (non-AppError) Error for a nonexistent workspace — a 500, not a 404', async () => {
    await expect(service.updateFiles('never-created', { 'hook.ts': 'x' })).rejects.toThrow(
      /does not exist/
    );
    await expect(
      service.updateFiles('never-created', { 'hook.ts': 'x' })
    ).rejects.not.toBeInstanceOf(AppError);
  });

  it('listAll() only includes folders with every required file present', async () => {
    await service.create('listed-hook', { 'hook.ts': HOOK_TS_CONTENT });
    await mkdir(path.join(hooksDir, 'incomplete-hook'), { recursive: true }); // no hook.ts
    const all = service.listAll();
    const names = all.map((h) => h.hookName);
    expect(names).toContain('listed-hook');
    expect(names).not.toContain('incomplete-hook');
  });

  it('stageDelete() atomically hides the folder and finalizeDelete() removes its quarantine', async () => {
    await service.create('to-delete', { 'hook.ts': HOOK_TS_CONTENT });
    expect(service.exists('to-delete')).toBe(true);
    const stage = service.stageDelete('to-delete');
    expect(service.exists('to-delete')).toBe(false);
    expect(stage.stagedPath).not.toBeNull();
    expect(existsSync(stage.stagedPath!)).toBe(true);
    service.finalizeDelete(stage);
    expect(existsSync(stage.stagedPath!)).toBe(false);
    expect(existsSync(path.join(hooksDir, 'to-delete'))).toBe(false);
  });

  it('stageDelete() on a nonexistent workspace is a harmless cleanup-only stage', () => {
    const stage = service.stageDelete('never-existed-at-all');
    expect(stage.stagedPath).toBeNull();
    expect(stage.cleanupPaths).toEqual([]);
    expect(() => service.finalizeDelete(stage)).not.toThrow();
  });

  it('restoreDelete() compensates a pre-commit failure without overwriting a source', async () => {
    await service.create('restore-me', { 'hook.ts': HOOK_TS_CONTENT });
    const stage = service.stageDelete('restore-me');
    service.restoreDelete(stage);
    expect(service.readFile('restore-me', 'hook.ts')).toBe(HOOK_TS_CONTENT);
    expect(stage.stagedPath && existsSync(stage.stagedPath)).toBe(false);
  });

  it('never guesses between a pending quarantine and a new live same-name hook', async () => {
    await service.create('incarnation-guard', { 'hook.ts': 'export default 1;\n' });
    const first = service.stageDelete('incarnation-guard');
    await service.create('incarnation-guard', { 'hook.ts': 'export default 2;\n' });

    expect(() => service.stageDelete('incarnation-guard')).toThrow(/both a live source folder/i);
    expect(service.readFile('incarnation-guard', 'hook.ts')).toBe('export default 2;\n');

    service.finalizeDelete(first);
  });
});

describe('HookWorkspaceService — folder-safe name sanitization', () => {
  it('strips unsafe characters from the folder name (mirrors ToolWorkspaceService.toolDir)', async () => {
    const info = await service.create('My Hook! v2', { 'hook.ts': HOOK_TS_CONTENT });
    expect(path.basename(info.dir)).toBe('MyHookv2');
  });

  it('throws an operational AppError 400 when the name sanitizes to empty (client input error, not a 500)', async () => {
    let thrown: unknown;
    try {
      await service.create('!!!', { 'hook.ts': HOOK_TS_CONTENT });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    expect((thrown as AppError).message).toMatch(/Invalid hook name/);
  });
});
