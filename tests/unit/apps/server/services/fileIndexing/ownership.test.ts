/**
 * Unit tests for ownership — the single-owner-per-folder resolver that stops
 * nested/overlapping projects from each indexing the same tree.
 *
 * Covers the two overlap shapes that matter: identical folders (inherited path)
 * and a subfolder nested under an already-indexed folder. Pure path math, so no
 * DB / filesystem needed.
 */

import { describe, expect, it } from '@jest/globals';
import path from 'node:path';
import {
  canonicalFolder,
  findFolderOverlaps,
  folderOverlapWarning,
  isAncestorOrSame,
  resolveOwnership,
} from '@server/services/fileIndexing/ownership';

const abs = (...p: string[]) => path.join('/repo', ...p);

describe('canonicalFolder / isAncestorOrSame', () => {
  it('strips trailing separators and resolves', () => {
    expect(canonicalFolder('/repo/apps/')).toBe(path.resolve('/repo/apps'));
  });

  it('keeps a filesystem root absolute', () => {
    expect(canonicalFolder(path.parse(process.cwd()).root)).toBe(path.parse(process.cwd()).root);
  });

  it('detects ancestor and same, but not sibling or prefix-collision', () => {
    expect(isAncestorOrSame(abs(), abs('apps'))).toBe(true);
    expect(isAncestorOrSame(abs(), abs())).toBe(true);
    expect(isAncestorOrSame(abs('apps'), abs())).toBe(false);
    expect(isAncestorOrSame(abs('app'), abs('apple'))).toBe(false); // not a real ancestor
  });
});

describe('resolveOwnership', () => {
  it('makes two projects on the same folder share one owner (oldest wins)', () => {
    const own = resolveOwnership([
      { id: 'b', folderPath: abs(), createdAt: '2026-01-02' },
      { id: 'a', folderPath: abs(), createdAt: '2026-01-01' },
    ]);
    expect(own.get('a')).toEqual({ ownerProjectId: 'a', isOwner: true, prefix: '' });
    expect(own.get('b')).toEqual({ ownerProjectId: 'a', isOwner: false, prefix: '' });
  });

  it('makes a subfolder project a satellite with a prefix into the owner', () => {
    const own = resolveOwnership([
      { id: 'root', folderPath: abs(), createdAt: '2026-01-01' },
      { id: 'srv', folderPath: abs('apps', 'server'), createdAt: '2026-01-02' },
    ]);
    expect(own.get('root')).toEqual({ ownerProjectId: 'root', isOwner: true, prefix: '' });
    expect(own.get('srv')).toEqual({
      ownerProjectId: 'root',
      isOwner: false,
      prefix: 'apps/server',
    });
  });

  it('picks the shallowest ancestor as owner across three nested levels', () => {
    const own = resolveOwnership([
      { id: 'mid', folderPath: abs('apps'), createdAt: '2026-01-02' },
      { id: 'root', folderPath: abs(), createdAt: '2026-01-01' },
      { id: 'leaf', folderPath: abs('apps', 'server'), createdAt: '2026-01-03' },
    ]);
    expect(own.get('root')?.isOwner).toBe(true);
    expect(own.get('mid')).toMatchObject({
      ownerProjectId: 'root',
      isOwner: false,
      prefix: 'apps',
    });
    expect(own.get('leaf')).toMatchObject({ ownerProjectId: 'root', prefix: 'apps/server' });
  });

  it('keeps unrelated sibling folders independent', () => {
    const own = resolveOwnership([
      { id: 'a', folderPath: abs('a'), createdAt: '1' },
      { id: 'b', folderPath: abs('b'), createdAt: '2' },
    ]);
    expect(own.get('a')).toMatchObject({ ownerProjectId: 'a', isOwner: true });
    expect(own.get('b')).toMatchObject({ ownerProjectId: 'b', isOwner: true });
  });

  it('a project owns its own subtree when only an unrelated/uneligible folder exists', () => {
    // Parent with indexing off is simply not passed in; child owns itself.
    const own = resolveOwnership([{ id: 'child', folderPath: abs('apps', 'server') }]);
    expect(own.get('child')).toEqual({
      ownerProjectId: 'child',
      isOwner: true,
      prefix: '',
    });
  });
});

describe('findFolderOverlaps / folderOverlapWarning — link-time overlap notice', () => {
  const others = [
    { id: 'p-root', name: 'Monorepo', folderPath: abs() },
    { id: 'p-srv', name: 'Server', folderPath: abs('apps', 'server') },
    { id: 'p-none', name: 'Unlinked', folderPath: null },
    { id: 'p-other', name: 'Elsewhere', folderPath: '/elsewhere' },
  ];

  it('flags same / inside / contains, ignores unlinked and unrelated folders', () => {
    expect(findFolderOverlaps(abs(), others)).toEqual([
      { projectId: 'p-root', projectName: 'Monorepo', relation: 'same' },
      { projectId: 'p-srv', projectName: 'Server', relation: 'contains' },
    ]);
    expect(findFolderOverlaps(abs('apps'), others)).toEqual([
      { projectId: 'p-root', projectName: 'Monorepo', relation: 'inside' },
      { projectId: 'p-srv', projectName: 'Server', relation: 'contains' },
    ]);
    expect(findFolderOverlaps(abs('apps', 'server', 'src'), others)).toEqual([
      { projectId: 'p-root', projectName: 'Monorepo', relation: 'inside' },
      { projectId: 'p-srv', projectName: 'Server', relation: 'inside' },
    ]);
    expect(findFolderOverlaps(path.resolve(abs(), '..', 'elsewhere-else'), others)).toEqual([]);
  });

  it('does not treat a path-prefix collision as an overlap', () => {
    expect(
      findFolderOverlaps(path.resolve(abs(), '..', 'repo-two'), [
        { id: 'p', name: 'P', folderPath: abs() },
      ])
    ).toEqual([]);
  });

  it('renders a shared-not-reindexed warning naming the first overlap', () => {
    const warning = folderOverlapWarning(findFolderOverlaps(abs('apps'), others));
    expect(warning).toContain('"Monorepo"');
    expect(warning).toContain('shared, not re-indexed');
    expect(warning).toContain('and 1 more');
    expect(folderOverlapWarning([])).toBeNull();
  });
});
