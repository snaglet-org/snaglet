import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDb, HookRegistrations, HookRuns } from '@snaglet/db';
import { ConflictError } from '@snaglet/shared/utils';

const PREFIX = 'hook-lifecycle-pg';
const hookName = `${PREFIX}-digest`;
const managedDeletes = new Set<string>();
const registry = {
  beginManagedDelete(name: string) {
    managedDeletes.add(name);
  },
  finishManagedDelete(name: string) {
    managedDeletes.delete(name);
  },
  async cancelManagedDelete(name: string) {
    managedDeletes.delete(name);
  },
  isManagedDelete(name: string) {
    return managedDeletes.has(name);
  },
};

let hooksDir: string;
let trashDir: string;
let buildsDir: string;
let deleteHook: typeof import('@server/services/customHooks/HookLifecycleService').deleteHook;
let clearHookRunHistory: typeof import('@server/services/customHooks/HookLifecycleService').clearHookRunHistory;
let hookWorkspaceService: typeof import('@server/services/customHooks/HookWorkspaceService').hookWorkspaceService;
let hookExecutionCoordinator: typeof import('@server/services/customHooks/HookExecutionCoordinator').hookExecutionCoordinator;
let scheduleService: typeof import('@server/services/ScheduleService').scheduleService;

async function cleanupDb(): Promise<void> {
  await getDb().query(`DELETE FROM public.hook_runs WHERE hook_name LIKE $1`, [`${PREFIX}%`]);
  await getDb().query(
    `DELETE FROM public.schedules
      WHERE action_kind='hook' AND action_json->>'hookName' LIKE $1`,
    [`${PREFIX}%`]
  );
  await getDb().query(`DELETE FROM public.hook_registrations WHERE name LIKE $1`, [`${PREFIX}%`]);
}

async function seedOwnedHook(): Promise<void> {
  await hookWorkspaceService.create(hookName, { 'hook.ts': 'export default {};\n' });
  await HookRegistrations.discover({
    id: `${PREFIX}-registration`,
    name: hookName,
    sourcePath: path.join(hooksDir, hookName, 'hook.ts'),
    enabledForFirstRegistration: true,
  });
  await getDb().query(
    `INSERT INTO public.schedules
       (id, name, schedule_kind, schedule_json, action_kind, action_json)
     VALUES ($1, $2, 'interval', '{"every":1,"unit":"day"}', 'hook', $3::jsonb)`,
    [
      `${PREFIX}-schedule`,
      'Lifecycle schedule',
      JSON.stringify({ source: 'hook-definition', hookName }),
    ]
  );
  await HookRuns.start({
    id: `${PREFIX}-run`,
    hookName,
    source: 'event',
    eventName: 'message:create',
  });
  await HookRuns.finish(`${PREFIX}-run`, {
    status: 'succeeded',
    durationMs: 1,
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
}

beforeAll(async () => {
  hooksDir = await mkdtemp(path.join(tmpdir(), 'snaglet-hook-lifecycle-pg-'));
  // Deletion finalizes by moving files to the Trash. Under jest the
  // Finder path is force-disabled (NODE_ENV=test guard in
  // finalizeDeleteToTrash), so artifacts land in HOOK_TRASH_DIR — point it
  // (and the build-output root) at temp dirs so the real Snaglet home is never
  // touched.
  trashDir = await mkdtemp(path.join(tmpdir(), 'snaglet-hook-lifecycle-trash-'));
  buildsDir = await mkdtemp(path.join(tmpdir(), 'snaglet-hook-lifecycle-builds-'));
  process.env.HOOK_WORKSPACES_DIR = hooksDir;
  process.env.HOOK_TRASH_DIR = trashDir;
  process.env.HOOK_BUILDS_DIR = buildsDir;
  const { getHookRegistry } = await import('@server/services/customHooks/HookRegistryService');
  const liveRegistry = getHookRegistry();
  jest
    .spyOn(liveRegistry, 'beginManagedDelete')
    .mockImplementation((name) => registry.beginManagedDelete(name));
  jest
    .spyOn(liveRegistry, 'finishManagedDelete')
    .mockImplementation((name) => registry.finishManagedDelete(name));
  jest
    .spyOn(liveRegistry, 'cancelManagedDelete')
    .mockImplementation((name) => registry.cancelManagedDelete(name));
  jest
    .spyOn(liveRegistry, 'isManagedDelete')
    .mockImplementation((name) => registry.isManagedDelete(name));
  ({ deleteHook, clearHookRunHistory } =
    await import('@server/services/customHooks/HookLifecycleService'));
  ({ hookWorkspaceService } = await import('@server/services/customHooks/HookWorkspaceService'));
  ({ hookExecutionCoordinator } =
    await import('@server/services/customHooks/HookExecutionCoordinator'));
  ({ scheduleService } = await import('@server/services/ScheduleService'));
  jest.spyOn(scheduleService, 'notifySchedulesRemoved').mockImplementation(() => undefined);
});

beforeEach(async () => {
  jest.clearAllMocks();
  managedDeletes.clear();
  hookExecutionCoordinator.reset();
  await cleanupDb();
  await rm(hooksDir, { recursive: true, force: true });
  await mkdir(hooksDir, { recursive: true });
  await rm(trashDir, { recursive: true, force: true });
  await mkdir(trashDir, { recursive: true });
});

afterAll(async () => {
  delete process.env.HOOK_WORKSPACES_DIR;
  delete process.env.HOOK_TRASH_DIR;
  delete process.env.HOOK_BUILDS_DIR;
  await rm(hooksDir, { recursive: true, force: true });
  await rm(trashDir, { recursive: true, force: true });
  await rm(buildsDir, { recursive: true, force: true });
});

describe('hook lifecycle transaction across PostgreSQL and filesystem quarantine', () => {
  afterAll(cleanupDb);

  it('commits history, schedules, registration, and the trash move as one operation', async () => {
    await seedOwnedHook();

    await expect(deleteHook(hookName)).resolves.toMatchObject({
      hookName,
      deletedRuns: 1,
      deletedRegistration: true,
      deletedSchedules: 1,
      // NODE_ENV=test forces the non-Finder path, so the files land in the
      // HOOK_TRASH_DIR fallback rather than the real system Trash.
      trash: { disposition: 'snaglet-trash' },
    });

    await expect(HookRuns.listByHook(hookName)).resolves.toEqual([]);
    await expect(HookRegistrations.findByName(hookName)).resolves.toBeNull();
    await expect(
      getDb().query(`SELECT id FROM public.schedules WHERE id=$1`, [`${PREFIX}-schedule`])
    ).resolves.toMatchObject({ rows: [] });
    expect(hookWorkspaceService.exists(hookName)).toBe(false);
    expect(
      (await readdir(hooksDir)).filter((name) => name.startsWith('.snaglet-hook-delete-'))
    ).toEqual([]);
    // The source folder was moved to the trash dir, not destroyed.
    const trashed = await readdir(trashDir);
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatch(new RegExp(`^\\d+-${hookName}$`));
    expect(await readdir(path.join(trashDir, trashed[0], hookName))).toContain('hook.ts');
  });

  it('rolls back all database deletes and restores the source when owner deletion throws', async () => {
    await seedOwnedHook();
    const registrationDelete = jest
      .spyOn(HookRegistrations, 'deleteByName')
      .mockRejectedValueOnce(new Error('forced owner failure'));

    await expect(deleteHook(hookName)).rejects.toThrow('forced owner failure');

    expect(hookWorkspaceService.exists(hookName)).toBe(true);
    await expect(HookRuns.listByHook(hookName)).resolves.toHaveLength(1);
    await expect(HookRegistrations.findByName(hookName)).resolves.not.toBeNull();
    await expect(
      getDb().query(`SELECT id FROM public.schedules WHERE id=$1`, [`${PREFIX}-schedule`])
    ).resolves.toMatchObject({ rows: [{ id: `${PREFIX}-schedule` }] });
    registrationDelete.mockRestore();
  });

  it('leaves a discoverable artifact after committed trash-move failure and safely reconciles it on retry', async () => {
    await seedOwnedHook();
    const finalizer = jest
      .spyOn(hookWorkspaceService, 'finalizeDeleteToTrash')
      .mockImplementationOnce(() => {
        throw new Error('forced cleanup failure');
      });

    await expect(deleteHook(hookName)).rejects.toThrow(/was deleted from Snaglet/i);

    expect(hookWorkspaceService.exists(hookName)).toBe(false);
    await expect(HookRuns.listByHook(hookName)).resolves.toEqual([]);
    await expect(HookRegistrations.findByName(hookName)).resolves.toBeNull();
    const quarantines = (await readdir(hooksDir)).filter((name) =>
      name.startsWith('.snaglet-hook-delete-')
    );
    expect(quarantines).toHaveLength(1);
    finalizer.mockRestore();
    await expect(deleteHook(hookName)).resolves.toMatchObject({
      deletedRuns: 0,
      deletedRegistration: false,
      deletedSchedules: 0,
    });
    expect(await readdir(hooksDir)).toEqual([]);
  });

  it('rejects an active invocation before touching PostgreSQL or the source folder', async () => {
    await seedOwnedHook();
    hookExecutionCoordinator.begin(hookName);

    await expect(clearHookRunHistory(hookName)).rejects.toBeInstanceOf(ConflictError);
    await expect(deleteHook(hookName)).rejects.toBeInstanceOf(ConflictError);

    expect(hookWorkspaceService.exists(hookName)).toBe(true);
    await expect(HookRuns.listByHook(hookName)).resolves.toHaveLength(1);
    await expect(HookRegistrations.findByName(hookName)).resolves.not.toBeNull();
    hookExecutionCoordinator.end(hookName);
  });
});
