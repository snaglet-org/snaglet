/**
 * Watcher gaps — which projects the short-cadence sweep covers, and that it
 * reconciles only those. A gap is a linked, non-archived project that has only
 * the sweep: a folder the sweep could not read, an owner without a live
 * watcher, or a failed gate-file watcher.
 *
 * Gate files are real files in temp dirs; the watchers, reconcile and project
 * table are mocks so each test sets who is watched and observes reconciles.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let listed: unknown[] = [];
const watching = new Set<string>();
const failedGateWatchers = new Set<string>();
const listAll = jest.fn(async () => listed);
const reconcileProject = jest.fn(async (_project: { id: string }) => ({
  upserted: 0,
  unchanged: 0,
  removed: 0,
  skipped: 0,
  kept: 0,
}));

jest.mock('@snaglet/db/tables/projects', () => ({
  Projects: { listAll: () => listAll() },
}));

jest.mock('@server/services/fileIndexing/watcher', () => ({
  purgeProjectIndex: async () => undefined,
  stopProjectWatcher: async () => undefined,
  startProjectWatcher: () => undefined,
  isWatchingProject: (id: string) => watching.has(id),
  stopAllWatchers: async () => undefined,
  clearScanOnly: () => undefined,
}));

jest.mock('@server/services/fileIndexing/configWatcher', () => ({
  startConfigWatcher: () => undefined,
  stopConfigWatcher: async () => undefined,
  stopAllConfigWatchers: async () => undefined,
  hasFailedConfigWatcher: (id: string) => failedGateWatchers.has(id),
}));

jest.mock('@server/services/fileIndexing/reconcile', () => ({
  reconcileProject: (project: { id: string }) => reconcileProject(project),
}));

jest.mock('@server/services/projectFolderRecovery', () => ({
  isProjectFolderMissing: async () => false,
  recoverProjectFolder: async () => ({ status: 'missing' }),
}));

jest.mock('@server/services/projectFolder', () => ({
  reconcileProjectFolderSymlinks: async () => undefined,
}));

jest.mock('@server/services/embedding/fileContentEmbedding', () => ({
  gcOrphanFileEmbeddings: async () => 0,
}));

jest.mock('@server/config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { ProjectRow } from '@snaglet/db/tables/projects';
import {
  projectsWithWatcherGap,
  reindexAll,
  sweepWatcherGaps,
} from '@server/services/fileIndexing';
import { WATCH_CONFIG_FILENAME } from '@server/services/fileIndexing/watchConfig';

const ENABLED = JSON.stringify({ embeddings: { enabled: true } });
const tmpDirs: string[] = [];
let nextId = 0;

async function makeFolder(config: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'snaglet-gaps-'));
  tmpDirs.push(dir);
  await writeFile(path.join(dir, WATCH_CONFIG_FILENAME), config);
  return dir;
}

function project(folderPath: string | null, overrides: Partial<ProjectRow> = {}): ProjectRow {
  nextId += 1;
  return {
    id: `proj-gaps-${nextId}`,
    name: `gaps-${nextId}`,
    containerId: `container-gaps-${nextId}`,
    githubUrl: null,
    folderPath,
    description: null,
    fileIndexingEnabled: true,
    archived: false,
    createdAt: new Date(2026, 0, nextId).toISOString(),
    updatedAt: new Date(2026, 0, nextId).toISOString(),
    ...overrides,
  } as ProjectRow;
}

const reconciledIds = () => reconcileProject.mock.calls.map(([p]) => p.id).sort();

beforeEach(() => {
  watching.clear();
  failedGateWatchers.clear();
  listAll.mockClear();
  reconcileProject.mockClear();
});

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('watcher gaps', () => {
  it('counts an unreadable folder, an unwatched owner and a failed gate watcher, nothing else', async () => {
    const watched = project(await makeFolder(ENABLED));
    const unplugged = project(path.join(tmpdir(), 'snaglet-gaps-definitely-missing', 'nested'));
    const unwatched = project(await makeFolder(ENABLED));
    const gateFailed = project(await makeFolder(ENABLED));
    const pausedByChoice = project(
      await makeFolder(JSON.stringify({ embeddings: { enabled: false } }))
    );
    const archived = project(await makeFolder(ENABLED), { archived: true });
    const unlinked = project(null);
    listed = [watched, unplugged, unwatched, gateFailed, pausedByChoice, archived, unlinked];
    watching.add(watched.id).add(gateFailed.id);
    failedGateWatchers.add(gateFailed.id).add(archived.id).add(unlinked.id);

    await reindexAll('test:full');

    expect([...projectsWithWatcherGap()].sort()).toEqual(
      [unplugged.id, unwatched.id, gateFailed.id].sort()
    );
  });

  it('reconciles only the projects with a gap on the short cadence', async () => {
    const watched = project(await makeFolder(ENABLED));
    const unwatched = project(await makeFolder(ENABLED));
    const gateFailed = project(await makeFolder(ENABLED));
    listed = [watched, unwatched, gateFailed];
    watching.add(watched.id).add(gateFailed.id);
    failedGateWatchers.add(gateFailed.id);
    await reindexAll('test:full');
    expect(reconciledIds()).toEqual([watched.id, unwatched.id, gateFailed.id].sort());
    reconcileProject.mockClear();

    await sweepWatcherGaps();

    expect(reconciledIds()).toEqual([unwatched.id, gateFailed.id].sort());
  });

  it('does nothing on the short cadence when every project is watched live', async () => {
    const watched = project(await makeFolder(ENABLED));
    listed = [watched];
    watching.add(watched.id);
    await reindexAll('test:full');
    listAll.mockClear();
    reconcileProject.mockClear();

    await sweepWatcherGaps();

    expect(listAll).not.toHaveBeenCalled();
    expect(reconcileProject).not.toHaveBeenCalled();
  });

  it('drops a folder from the gaps once the sweep can read it again', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'snaglet-gaps-later-'));
    tmpDirs.push(parent);
    const dir = path.join(parent, 'plugged-in-later');
    const later = project(dir);
    listed = [later];
    await reindexAll('test:full');
    expect([...projectsWithWatcherGap()]).toEqual([later.id]);

    await mkdir(dir);
    await writeFile(path.join(dir, WATCH_CONFIG_FILENAME), ENABLED);
    watching.add(later.id);
    await sweepWatcherGaps();

    expect(reconciledIds()).toEqual([later.id]);
    expect(projectsWithWatcherGap().size).toBe(0);
  });
});
