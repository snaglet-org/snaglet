/**
 * HookWorkspaceService.finalizeDeleteToTrash — the finalize every hook
 * deletion runs (see HookLifecycleService.deleteHook): the quarantined source
 * folder and the generated build output move to the OS Trash on macOS (Finder
 * via osascript, injected here so tests never invoke the real Finder), with an
 * `<SNAGLET_HOME>/trash`-style fallback elsewhere or on Finder failure. Runs the
 * real service against temp dirs; HOOK_WORKSPACES_DIR is set before the
 * dynamic import.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let root: string;
let hooksDir: string;
let buildDir: string;
let trashDir: string;
let service: typeof import('@server/services/customHooks/HookWorkspaceService').hookWorkspaceService;

const HOOK_TS = "export default { on: 'message:create', run() {} };\n";

async function seedHook(name: string, { withBuild = true } = {}): Promise<void> {
  await mkdir(path.join(hooksDir, name), { recursive: true });
  await writeFile(path.join(hooksDir, name, 'hook.ts'), HOOK_TS, 'utf-8');
  if (withBuild) {
    await mkdir(path.join(buildDir, name), { recursive: true });
    await writeFile(path.join(buildDir, name, 'hook.cjs'), 'module.exports = {};\n', 'utf-8');
  }
}

/** Entries of the fallback trash root (each deletion creates `<ts>-<name>/`). */
async function fallbackEntries(): Promise<string[]> {
  if (!existsSync(trashDir)) return [];
  return readdir(trashDir);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-hook-trash-'));
  hooksDir = path.join(root, 'hooks');
  buildDir = path.join(root, 'build');
  trashDir = path.join(root, 'trash');
  await mkdir(hooksDir, { recursive: true });
  process.env.HOOK_WORKSPACES_DIR = hooksDir;
  ({ hookWorkspaceService: service } =
    await import('@server/services/customHooks/HookWorkspaceService'));
});

afterAll(async () => {
  delete process.env.HOOK_WORKSPACES_DIR;
  await rm(root, { recursive: true, force: true });
});

describe('finalizeDeleteToTrash — macOS Finder path (injected)', () => {
  it('renames the quarantine back to its real hooks-dir identity before Finder-deleting it, so "Put Back" restores it where the scanner re-registers', async () => {
    await seedHook('digest');
    const stage = service.stageDelete('digest');
    const trashed: string[] = [];
    const systemTrash = jest.fn(async (target: string) => {
      trashed.push(target);
      await rm(target, { recursive: true, force: true }); // emulate Finder moving it away
    });

    const outcome = await service.finalizeDeleteToTrash(stage, {
      platform: 'darwin',
      systemTrash,
      buildDir,
      trashDir,
    });

    expect(outcome).toEqual({ disposition: 'system-trash', fallbackDir: null });
    // Source went to the Trash under its real path (not the quarantine name)…
    expect(trashed[0]).toBe(path.join(hooksDir, 'digest'));
    // …and the build output under a `<name>.build` alias (never two identical
    // `<name>` items in the Trash).
    expect(trashed[1]).toBe(path.join(buildDir, 'digest.build'));
    expect(existsSync(path.join(buildDir, 'digest'))).toBe(false);
    // Nothing left behind: no quarantine, no live folder, no fallback dir.
    expect((await readdir(hooksDir)).filter((n) => n.includes('digest'))).toEqual([]);
    expect(await fallbackEntries()).toEqual([]);
  });

  it('falls back to the Snaglet trash folder when the Finder call fails — never a silent permanent delete, never a throw', async () => {
    await seedHook('flaky-finder');
    const stage = service.stageDelete('flaky-finder');
    const systemTrash = jest.fn<(target: string) => Promise<void>>(async () => {
      throw new Error('osascript: Finder got an error');
    });

    const outcome = await service.finalizeDeleteToTrash(stage, {
      platform: 'darwin',
      systemTrash,
      buildDir,
      trashDir,
    });

    expect(outcome.disposition).toBe('snaglet-trash');
    expect(outcome.fallbackDir).not.toBeNull();
    expect(path.basename(outcome.fallbackDir!)).toMatch(/^\d+-flaky-finder$/);
    expect(existsSync(path.join(outcome.fallbackDir!, 'flaky-finder', 'hook.ts'))).toBe(true);
    expect(existsSync(path.join(outcome.fallbackDir!, 'flaky-finder.build', 'hook.cjs'))).toBe(
      true
    );
    expect((await readdir(hooksDir)).filter((n) => n.includes('flaky-finder'))).toEqual([]);
    expect(existsSync(path.join(buildDir, 'flaky-finder'))).toBe(false);
  });
});

describe('finalizeDeleteToTrash — fallback path', () => {
  it('moves source and build output into <trashDir>/<timestamp>-<name>/ on non-macOS platforms', async () => {
    await seedHook('linux-hook');
    const stage = service.stageDelete('linux-hook');

    const outcome = await service.finalizeDeleteToTrash(stage, {
      platform: 'linux',
      buildDir,
      trashDir,
    });

    expect(outcome.disposition).toBe('snaglet-trash');
    expect(existsSync(path.join(outcome.fallbackDir!, 'linux-hook', 'hook.ts'))).toBe(true);
    expect(existsSync(path.join(outcome.fallbackDir!, 'linux-hook.build', 'hook.cjs'))).toBe(true);
    expect(service.exists('linux-hook')).toBe(false);
    expect(existsSync(path.join(buildDir, 'linux-hook'))).toBe(false);
  });

  it('defaults to the fallback path under jest even on darwin — the real Finder must never run from tests', async () => {
    await seedHook('guarded-hook', { withBuild: false });
    const stage = service.stageDelete('guarded-hook');

    // No platform, no injected systemTrash: the NODE_ENV=test guard applies.
    const outcome = await service.finalizeDeleteToTrash(stage, { buildDir, trashDir });

    expect(outcome.disposition).toBe('snaglet-trash');
    expect(existsSync(path.join(outcome.fallbackDir!, 'guarded-hook', 'hook.ts'))).toBe(true);
  });

  it('is idempotent: nothing left on disk to move is a success, not an error', async () => {
    const stage = service.stageDelete('never-existed-hook');
    const outcome = await service.finalizeDeleteToTrash(stage, {
      platform: 'linux',
      buildDir,
      trashDir,
    });
    expect(outcome).toEqual({ disposition: 'none', fallbackDir: null });
    expect((await fallbackEntries()).filter((n) => n.includes('never-existed-hook'))).toEqual([]);
  });

  it('still refuses to touch a path outside the validated same-hook quarantine set', async () => {
    await seedHook('victim', { withBuild: false });
    const stage = service.stageDelete('victim');
    const evil = {
      ...stage,
      cleanupPaths: [path.join(root, 'not-a-quarantine')],
    };
    await expect(
      service.finalizeDeleteToTrash(evil, { platform: 'linux', buildDir, trashDir })
    ).rejects.toThrow(/invalid hook quarantine path/i);
    // Compensate so later tests aren't polluted.
    service.restoreDelete(stage);
  });
});
