/**
 * reindexAll lifecycle — the pause-vs-purge safety contract. Pausing
 * background indexing and deleting stored embeddings are different actions,
 * so the sweep never purges a paused project: explicit `enabled: false`, the
 * DB mirror `fileIndexingEnabled: false`, a malformed snaglet.config.json, or an
 * unreachable folder all pause. Only snaglet.config.json removed from an existing
 * folder, or satellite dedup (two active projects on one tree), purge.
 *
 * `purgeProjectIndex` is a spy, so one unexpected call fails the test. Gate
 * files are real files in temp dirs, so the real provenance parser runs.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const purgeProjectIndex = jest.fn(async () => undefined);
const stopProjectWatcher = jest.fn(async () => undefined);
const startProjectWatcher = jest.fn();
const isWatchingProject = jest.fn(() => false);
const stopAllWatchers = jest.fn(async () => undefined);
const reconcileProject = jest.fn(async () => ({
  upserted: 0,
  unchanged: 0,
  removed: 0,
  skipped: 0,
}));
const gcOrphanFileEmbeddings = jest.fn(async () => 0);
const loggerError = jest.fn();

jest.mock('@server/services/fileIndexing/watcher', () => ({
  purgeProjectIndex: (...args: unknown[]) => purgeProjectIndex(...(args as [])),
  stopProjectWatcher: (...args: unknown[]) => stopProjectWatcher(...(args as [])),
  startProjectWatcher: (...args: unknown[]) => startProjectWatcher(...(args as [])),
  isWatchingProject: (...args: unknown[]) => isWatchingProject(...(args as [])),
  stopAllWatchers: (...args: unknown[]) => stopAllWatchers(...(args as [])),
}));

jest.mock('@server/services/fileIndexing/reconcile', () => ({
  reconcileProject: (...args: unknown[]) => reconcileProject(...(args as [])),
}));

jest.mock('@server/services/embedding/fileContentEmbedding', () => ({
  gcOrphanFileEmbeddings: (...args: unknown[]) => gcOrphanFileEmbeddings(...(args as [])),
}));

jest.mock('@server/config/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => loggerError(...args),
  },
}));

import type { ProjectRow } from '@snaglet/db/tables/projects';
import { reindexAll } from '@server/services/fileIndexing';
import { WATCH_CONFIG_FILENAME } from '@server/services/fileIndexing/watchConfig';

const tmpDirs: string[] = [];

async function makeFolder(config?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'snaglet-lifecycle-'));
  tmpDirs.push(dir);
  if (config !== undefined) await writeFile(path.join(dir, WATCH_CONFIG_FILENAME), config);
  return dir;
}

let nextId = 0;
function project(folderPath: string, fileIndexingEnabled = true): ProjectRow {
  nextId += 1;
  return {
    id: `proj-lifecycle-${nextId}`,
    name: `lifecycle-${nextId}`,
    containerId: `container-lifecycle-${nextId}`,
    githubUrl: null,
    folderPath,
    description: null,
    fileIndexingEnabled,
    archived: false,
    createdAt: new Date(2026, 0, nextId).toISOString(),
    updatedAt: new Date(2026, 0, nextId).toISOString(),
  } as unknown as ProjectRow;
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('reindexAll pause-vs-purge lifecycle', () => {
  it('explicit enabled:false pauses — stops the watcher, never purges', async () => {
    const dir = await makeFolder(JSON.stringify({ embeddings: { enabled: false } }));
    const paused = project(dir);

    await reindexAll('test:paused-config', undefined, [paused]);

    expect(purgeProjectIndex).not.toHaveBeenCalled();
    expect(stopProjectWatcher).toHaveBeenCalledWith(paused.id);
    expect(reconcileProject).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('a false DB mirror pauses without purging even when the file says enabled', async () => {
    const dir = await makeFolder(JSON.stringify({ embeddings: { enabled: true } }));
    const paused = project(dir, false);

    await reindexAll('test:paused-db-flag', undefined, [paused]);

    expect(purgeProjectIndex).not.toHaveBeenCalled();
    expect(stopProjectWatcher).toHaveBeenCalledWith(paused.id);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('a malformed config pauses — a hand-edit typo must not delete the index', async () => {
    const dir = await makeFolder('{ "embeddings": { "enabled": tru'); // torn write
    const broken = project(dir);

    await reindexAll('test:invalid-config', undefined, [broken]);

    expect(purgeProjectIndex).not.toHaveBeenCalled();
    expect(stopProjectWatcher).toHaveBeenCalledWith(broken.id);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('an unreachable folder pauses — an unmounted drive is not an unconfigure', async () => {
    const gone = path.join(tmpdir(), 'snaglet-lifecycle-definitely-missing', 'nested');
    const unplugged = project(gone);

    await reindexAll('test:unreachable', undefined, [unplugged]);

    expect(purgeProjectIndex).not.toHaveBeenCalled();
    expect(stopProjectWatcher).toHaveBeenCalledWith(unplugged.id);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('removing snaglet.config.json from an existing folder still purges (unchanged contract)', async () => {
    const dir = await makeFolder(); // folder exists, no gate file
    const unconfigured = project(dir);

    await reindexAll('test:config-removed', undefined, [unconfigured]);

    expect(purgeProjectIndex).toHaveBeenCalledWith(unconfigured.id);
    expect(reconcileProject).not.toHaveBeenCalled();
  });

  it('an active project reconciles and is never purged or stopped', async () => {
    const dir = await makeFolder(JSON.stringify({ embeddings: { enabled: true } }));
    const active = project(dir);

    await reindexAll('test:active', undefined, [active]);

    expect(purgeProjectIndex).not.toHaveBeenCalled();
    expect(reconcileProject).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('satellite dedup still purges the non-owner of a shared active tree', async () => {
    const dir = await makeFolder(JSON.stringify({ embeddings: { enabled: true } }));
    const older = project(dir);
    const newer = project(dir);

    await reindexAll('test:satellite', undefined, [older, newer]);

    // Exactly one of the two owns the tree; the other is deduped destructively
    // (unrelated to pausing).
    expect(purgeProjectIndex).toHaveBeenCalledTimes(1);
    expect(reconcileProject).toHaveBeenCalledTimes(1);
  });

  it('pausing one project does not stop the sweep from purging a removed-config one', async () => {
    const pausedDir = await makeFolder(JSON.stringify({ embeddings: { enabled: false } }));
    const removedDir = await makeFolder();
    const paused = project(pausedDir);
    const removed = project(removedDir);

    await reindexAll('test:mixed', undefined, [paused, removed]);

    expect(purgeProjectIndex).toHaveBeenCalledTimes(1);
    expect(purgeProjectIndex).toHaveBeenCalledWith(removed.id);
    expect(stopProjectWatcher).toHaveBeenCalledWith(paused.id);
  });
});
