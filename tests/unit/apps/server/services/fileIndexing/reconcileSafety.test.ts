/**
 * reconcileSafety — the DB → disk half of a reconcile only deletes what the
 * walk saw was gone.
 *
 * The walk runs against real temp folders; the file table and ingest are mocked
 * so each test can seed "indexed rows" and observe exactly which removals ran.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dbRows: string[] = [];
const removed: string[] = [];
let onRemove: ((relPath: string) => Promise<void>) | null = null;
let onIngest: ((relPath: string) => Promise<void>) | null = null;

jest.mock('@snaglet/db/tables/files', () => ({
  Files: {
    listByProject: async () => dbRows.map((relativePath) => ({ relativePath })),
  },
}));

jest.mock('@server/services/fileIndexing/ingest', () => ({
  ingestFile: async (_project: unknown, relPath: string) => {
    if (onIngest) await onIngest(relPath);
    return 'unchanged';
  },
  removeFile: async (_project: unknown, relPath: string) => {
    removed.push(relPath);
    if (onRemove) await onRemove(relPath);
    return true;
  },
}));

jest.mock('@server/realtime/surfaces/fileEmbeddings', () => ({
  emitFileIndexingImpactChanged: () => undefined,
  emitProjectIndexingStatusChanged: () => undefined,
}));

jest.mock('@server/config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { ProjectRow } from '@snaglet/db/tables/projects';
import { compileIgnoreRules } from '@server/services/fileIndexing/exclusions';
import { getProjectIndexingRuntime } from '@server/services/fileIndexing/projectIndexingStatus';
import { reconcileProject } from '@server/services/fileIndexing/reconcile';
import { heldRemovalsMatch } from '@server/services/fileIndexing/removalSafety';

const rules = compileIgnoreRules({});
let folder = '';
let seq = 0;

function project(): ProjectRow {
  seq += 1;
  return { id: `proj-safety-${seq}`, folderPath: folder } as unknown as ProjectRow;
}

async function makeTree(files: string[]): Promise<void> {
  for (const rel of files) {
    await mkdir(path.join(folder, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(folder, rel), `// ${rel}\n`);
  }
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'snaglet-reconcile-safety-'));
  dbRows = [];
  removed.length = 0;
  onRemove = null;
  onIngest = null;
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
  await rm(`${folder}-moved`, { recursive: true, force: true });
});

describe('reconcile removal safety', () => {
  it('keeps the rows of a folder it cannot read and reports them', async () => {
    if (process.getuid?.() === 0) return;
    await makeTree(['src/a.ts', 'locked/b.ts', 'locked/deep/c.ts']);
    dbRows = ['src/a.ts', 'locked/b.ts', 'locked/deep/c.ts'];
    await chmod(path.join(folder, 'locked'), 0o000);
    const p = project();
    try {
      const result = await reconcileProject(p, rules);
      expect(removed).toEqual([]);
      expect(result).toMatchObject({ removed: 0, kept: 2 });
      expect(getProjectIndexingRuntime(p.id).lastWarning).toMatch(/kept 2 file\(s\).*locked/);
      expect(getProjectIndexingRuntime(p.id).lastError).toBeNull();
    } finally {
      await chmod(path.join(folder, 'locked'), 0o755);
    }
  });

  it('still removes rows genuinely deleted elsewhere while keeping the unreadable subtree', async () => {
    if (process.getuid?.() === 0) return;
    await makeTree(['src/a.ts', 'locked/b.ts']);
    dbRows = ['src/a.ts', 'src/deleted.ts', 'locked/b.ts'];
    await chmod(path.join(folder, 'locked'), 0o000);
    try {
      const result = await reconcileProject(project(), rules);
      expect(removed).toEqual(['src/deleted.ts']);
      expect(result).toMatchObject({ removed: 1, kept: 1 });
    } finally {
      await chmod(path.join(folder, 'locked'), 0o755);
    }
  });

  it('removes nothing when the root is missing', async () => {
    await makeTree(['a.ts']);
    dbRows = ['a.ts', 'b.ts'];
    await rename(folder, `${folder}-moved`);
    const p = project();
    await expect(reconcileProject(p, rules)).rejects.toThrow(/missing or was moved/);
    expect(removed).toEqual([]);
    expect(getProjectIndexingRuntime(p.id).lastError).toMatch(/no files were removed/);
  });

  it('removes nothing when the root is swapped between the walk and the delete phase', async () => {
    await makeTree(['a.ts', 'b.ts']);
    dbRows = ['a.ts', 'b.ts', 'gone.ts'];
    // Ingest runs after the walk and before any delete: swap the root there,
    // leaving an empty directory at the same path (a different inode).
    onIngest = async () => {
      onIngest = null;
      await rename(folder, `${folder}-moved`);
      await mkdir(folder);
    };
    await expect(reconcileProject(project(), rules)).rejects.toThrow(/missing or was moved/);
    expect(removed).toEqual([]);
  });

  it('stops deleting when the root moves mid-delete', async () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    await makeTree(['keep.ts']);
    dbRows = ['keep.ts', ...files];
    onRemove = async (relPath) => {
      if (relPath === 'f2.ts') await rename(folder, `${folder}-moved`);
    };
    await expect(reconcileProject(project(), rules)).rejects.toThrow(/missing or was moved/);
    expect(removed).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
  });

  it('holds back a mass removal (> half and > 200 rows)', async () => {
    await makeTree(['keep.ts']);
    const gone = Array.from({ length: 250 }, (_, i) => `gone/${i}.ts`);
    dbRows = ['keep.ts', ...gone];
    const p = project();
    const result = await reconcileProject(p, rules);
    expect(removed).toEqual([]);
    expect(result).toMatchObject({ removed: 0, kept: 250 });
    expect(getProjectIndexingRuntime(p.id).lastWarning).toMatch(
      /250 of 251 indexed files are missing from the folder; Snaglet kept them/
    );
  });

  it('applies a large removal that is not most of the project', async () => {
    const present = Array.from({ length: 300 }, (_, i) => `keep/${i}.ts`);
    await makeTree(present);
    const gone = Array.from({ length: 250 }, (_, i) => `gone/${i}.ts`);
    dbRows = [...present, ...gone];
    const result = await reconcileProject(project(), rules);
    expect(result).toMatchObject({ removed: 250, kept: 0 });
  });

  it('applies a small removal even when it is most of the project', async () => {
    await makeTree(['keep.ts']);
    dbRows = ['keep.ts', 'x.ts', 'y.ts', 'z.ts'];
    const p = project();
    const result = await reconcileProject(p, rules);
    expect(removed.sort()).toEqual(['x.ts', 'y.ts', 'z.ts']);
    expect(result).toMatchObject({ removed: 3, kept: 0 });
    expect(getProjectIndexingRuntime(p.id).lastWarning).toBeNull();
  });
  /* ---- a person-confirmed release of a mass-removal hold ---- */

  async function heldProject(): Promise<{ p: ProjectRow; gone: string[] }> {
    await makeTree(['keep.ts']);
    const gone = Array.from({ length: 250 }, (_, i) => `gone/${i}.ts`);
    dbRows = ['keep.ts', ...gone];
    const p = project();
    await reconcileProject(p, rules);
    return { p, gone };
  }

  it('records the hold (count, total, since) on the status', async () => {
    const { p } = await heldProject();
    const held = getProjectIndexingRuntime(p.id).heldRemovals;
    expect(held).toMatchObject({ count: 250, total: 251 });
    expect(typeof held?.since).toBe('string');
    expect(removed).toEqual([]);
  });

  it('keeps `since` while the hold persists across reconciles', async () => {
    const { p } = await heldProject();
    const first = getProjectIndexingRuntime(p.id).heldRemovals?.since;
    expect(typeof first).toBe('string');
    await new Promise((r) => setTimeout(r, 5));
    await reconcileProject(p, rules);
    expect(getProjectIndexingRuntime(p.id).heldRemovals?.since).toBe(first);
    expect(removed).toEqual([]);
  });

  it('never releases on its own: repeated reconciles keep holding', async () => {
    const { p } = await heldProject();
    for (let i = 0; i < 3; i++) await reconcileProject(p, rules);
    expect(removed).toEqual([]);
    expect(getProjectIndexingRuntime(p.id).heldRemovals?.count).toBe(250);
  });

  it('a confirmed release with the matching count removes them and clears the hold', async () => {
    const { p, gone } = await heldProject();
    const result = await reconcileProject(p, rules, undefined, {
      allowMassRemoval: { expected: 250 },
    });
    expect(result).toMatchObject({ removed: 250, kept: 0 });
    expect(result.releaseRefused).toBeUndefined();
    expect(removed.sort()).toEqual([...gone].sort());
    expect(getProjectIndexingRuntime(p.id).heldRemovals).toBeNull();
    expect(getProjectIndexingRuntime(p.id).lastWarning).toBeNull();
  });

  it('refuses a release when more are missing than ceil(expected x 1.1)', async () => {
    const { p } = await heldProject();
    // 250 missing; the person saw 220 -> cap is 242, so refuse.
    const result = await reconcileProject(p, rules, undefined, {
      allowMassRemoval: { expected: 220 },
    });
    expect(result.releaseRefused).toMatchObject({
      reason: 'count-changed',
      found: 250,
      expected: 220,
      total: 251,
    });
    expect(removed).toEqual([]);
    expect(getProjectIndexingRuntime(p.id).heldRemovals?.count).toBe(250);
  });

  it('refuses a release when far fewer are missing than the person saw', async () => {
    const { p } = await heldProject();
    const result = await reconcileProject(p, rules, undefined, {
      allowMassRemoval: { expected: 300 },
    });
    expect(result.releaseRefused?.reason).toBe('count-changed');
    expect(removed).toEqual([]);
  });

  it('a release still stops when the root moves mid-delete', async () => {
    const { p } = await heldProject();
    onRemove = async (relPath) => {
      if (relPath === 'gone/2.ts') await rename(folder, `${folder}-moved`);
    };
    await expect(
      reconcileProject(p, rules, undefined, { allowMassRemoval: { expected: 250 } })
    ).rejects.toThrow(/missing or was moved/);
    expect(removed).toEqual(['gone/0.ts', 'gone/1.ts', 'gone/2.ts']);
  });

  it('a release still keeps rows under an unreadable folder', async () => {
    if (process.getuid?.() === 0) return; // root ignores chmod
    await makeTree(['keep.ts', 'locked/a.ts']);
    const gone = Array.from({ length: 250 }, (_, i) => `gone/${i}.ts`);
    dbRows = ['keep.ts', 'locked/a.ts', ...gone];
    const p = project();
    await chmod(path.join(folder, 'locked'), 0o000);
    try {
      const result = await reconcileProject(p, rules, undefined, {
        allowMassRemoval: { expected: 250 },
      });
      expect(removed).not.toContain('locked/a.ts');
      expect(result.removed).toBe(250);
      expect(result.kept).toBe(1);
    } finally {
      await chmod(path.join(folder, 'locked'), 0o755);
    }
  });

  it('yields to the event loop between batches of files', async () => {
    const files = Array.from({ length: 250 }, (_, i) => `f${i}.ts`);
    await makeTree(files);
    dbRows = [...files];
    let ingested = 0;
    let ingestedWhenOtherWorkRan: number | null = null;
    // The mocked ingest never touches I/O, so only the reconcile's own yields
    // let an immediate queued by other work run before the scan ends.
    onIngest = async () => {
      if (ingested === 0) setImmediate(() => (ingestedWhenOtherWorkRan = ingested));
      ingested += 1;
    };

    const result = await reconcileProject(project(), rules);

    expect(result).toMatchObject({ unchanged: 250, removed: 0 });
    expect(ingestedWhenOtherWorkRan).not.toBeNull();
    expect(ingestedWhenOtherWorkRan).toBeLessThan(files.length);
  });

  it('heldRemovalsMatch: \u00b110% band, capped at ceil(expected x 1.1)', () => {
    expect(heldRemovalsMatch(250, 250)).toBe(true);
    expect(heldRemovalsMatch(275, 250)).toBe(true);
    expect(heldRemovalsMatch(276, 250)).toBe(false);
    expect(heldRemovalsMatch(225, 250)).toBe(true);
    expect(heldRemovalsMatch(224, 250)).toBe(false);
    expect(heldRemovalsMatch(222, 201)).toBe(true); // ceil(221.1) = 222
    expect(heldRemovalsMatch(223, 201)).toBe(false);
    expect(heldRemovalsMatch(0, 0)).toBe(false);
    expect(heldRemovalsMatch(5, 2.5)).toBe(false);
  });
});
