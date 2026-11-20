/**
 * Settings → Storage → Clear on the `build` category deletes every compiled
 * hook bundle. Lifecycle-event dispatch runs a registered hook's bundle path
 * as is, so the route asks the registry to rebuild right away;
 * `rebuildRegisteredHooks` must put each bundle back from its untouched
 * source and leave the hook registered. Real scanner, real esbuild build and
 * `--describe` run, against this file's own database.
 */

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { getDb } from '@snaglet/db';
import { HookRegistryService } from '@server/services/customHooks/HookRegistryService';
import { writeHookScaffold } from '@server/services/ToolService/handlers/hooks/scaffold';

jest.setTimeout(60_000);

const HOOK_NAME = 'rebuilt-after-clear';

describe('HookRegistryService.rebuildRegisteredHooks', () => {
  let hooksRoot: string;

  beforeAll(async () => {
    hooksRoot = await mkdtemp(path.join(tmpdir(), 'snaglet-hook-rebuild-'));
    getDb();
  });

  afterAll(async () => {
    await rm(hooksRoot, { recursive: true, force: true });
  });

  it('rebuilds a registered hook whose bundle was cleared', async () => {
    await writeHookScaffold(hooksRoot, {
      name: HOOK_NAME,
      description: 'Scaffolded by the rebuild-after-clear test.',
      events: ['message:create'],
    });
    const registry = new HookRegistryService({ dir: hooksRoot, describeTimeoutMs: 15_000 });
    try {
      await registry.registerHookFolder(HOOK_NAME);
      const bundle = path.join(registry.buildDir, HOOK_NAME, 'hook.cjs');
      expect(existsSync(bundle)).toBe(true);

      // What clearSnagletStorageCategory('build') does: remove, then recreate empty.
      await rm(registry.buildDir, { recursive: true, force: true });
      await mkdir(registry.buildDir, { recursive: true });

      await registry.rebuildRegisteredHooks();

      expect(existsSync(bundle)).toBe(true);
      expect(existsSync(path.join(hooksRoot, HOOK_NAME, 'hook.ts'))).toBe(true);
      expect(registry.registeredHookNames).toContain(HOOK_NAME);
      const row = (await registry.listRegistrations()).find((item) => item.name === HOOK_NAME);
      expect(row?.buildStatus).toBe('ready');
    } finally {
      registry.stop();
    }
  });
});
