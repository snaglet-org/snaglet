import { describe, expect, it } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { fuzzyScore, treeHitsFor } from './treeSearch';

// Minimal tree-node fixtures — treeHitsFor only reads kind/id and the label
// column (`title` for doc/thread, `name` for container), so cast the rest away.
function doc(id: string, title: string): LibraryTreeChild {
  return { kind: 'doc', id, title } as unknown as LibraryTreeChild;
}
function container(id: string, name: string): LibraryTreeChild {
  return { kind: 'container', id, name } as unknown as LibraryTreeChild;
}

describe('fuzzyScore', () => {
  it('scores a substring match in the strongest tier (>= 2)', () => {
    expect(fuzzyScore('reranker swap plan', 'swap')).toBeGreaterThanOrEqual(2);
  });

  it('scores a subsequence-only match below the substring tier', () => {
    const sub = fuzzyScore('reranker swap plan', 'rrnkr'); // r-r-n-k-r, in order
    expect(sub).not.toBeNull();
    expect(sub as number).toBeGreaterThan(1);
    expect(sub as number).toBeLessThan(2);
  });

  it('returns null when the query is not even a subsequence', () => {
    expect(fuzzyScore('grocery list', 'rrnkr')).toBeNull();
  });

  it('ranks a substring above a subsequence-only match', () => {
    const substring = fuzzyScore('swap now', 'swap') as number;
    const subsequence = fuzzyScore('sxwxaxp', 'swap') as number;
    expect(substring).toBeGreaterThan(subsequence);
  });
});

describe('treeHitsFor', () => {
  const grocery = doc('doc-2', 'Grocery List');
  const plan = doc('doc-1', 'Reranker Swap Plan');
  const folder = container('container-1', 'Reranker Swap Folder');
  const nodes = [grocery, plan, folder];

  it('matches by approximate subsequence and excludes non-matches', () => {
    const ids = treeHitsFor(nodes, 'rrnkr', null).map((n) => n.id);
    expect(ids).toContain('doc-1');
    expect(ids).toContain('container-1');
    expect(ids).not.toContain('doc-2');
  });

  it('respects the kinds filter', () => {
    const ids = treeHitsFor(nodes, 'reranker', ['doc']).map((n) => n.id);
    expect(ids).toEqual(['doc-1']);
  });

  it('ranks a substring match ahead of a subsequence-only match', () => {
    const exact = doc('doc-exact', 'Swap');
    const subseq = doc('doc-subseq', 'S w a p arts'); // "swap" only as a subsequence
    const ranked = treeHitsFor([subseq, exact], 'swap', null).map((n) => n.id);
    expect(ranked[0]).toBe('doc-exact');
  });

  it('returns every node in tree order for an empty term', () => {
    const ids = treeHitsFor(nodes, '', null).map((n) => n.id);
    expect(ids).toEqual(['doc-2', 'doc-1', 'container-1']);
  });
});
