import { describe, expect, it } from '@jest/globals';
import {
  COMPACTION_FOLDS_TRIMMED_MARKER,
  COMPACTION_SUMMARY_MAX_CHARS,
  appendFoldSection,
} from '@server/services/summary/compactionSummarySections';

describe('appendFoldSection', () => {
  it('starts with Fold 1 and appends numbered sections verbatim', () => {
    const one = appendFoldSection(null, '  first notes ');
    expect(one).toBe('## Fold 1\nfirst notes');
    const two = appendFoldSection(one, 'second notes');
    expect(two).toBe('## Fold 1\nfirst notes\n\n## Fold 2\nsecond notes');
  });

  it('keeps notes containing blank lines inside their own section', () => {
    const one = appendFoldSection(null, 'para a\n\npara b');
    const two = appendFoldSection(one, 'next');
    expect(two).toBe('## Fold 1\npara a\n\npara b\n\n## Fold 2\nnext');
  });

  it('treats a summary saved before fold headings as one section', () => {
    expect(appendFoldSection('legacy notes\n\nmore legacy', 'new')).toBe(
      'legacy notes\n\nmore legacy\n\n## Fold 2\nnew'
    );
  });

  it('stays under the cap over many folds, dropping the oldest folds with a marker', () => {
    const notes = (n: number) => `notes for fold ${n} ` + 'x'.repeat(3_000);
    let summary: string | null = null;
    for (let n = 1; n <= 40; n++) {
      summary = appendFoldSection(summary, notes(n));
      expect(summary.length).toBeLessThanOrEqual(COMPACTION_SUMMARY_MAX_CHARS);
    }
    const text = summary!;
    expect(text.startsWith(`${COMPACTION_FOLDS_TRIMMED_MARKER}\n\n## Fold `)).toBe(true);
    expect(text.split(COMPACTION_FOLDS_TRIMMED_MARKER)).toHaveLength(2);
    expect(text).toContain('## Fold 40\nnotes for fold 40');
    expect(text).not.toContain('## Fold 1\n');
    // Numbering continues past trimmed folds, and the kept folds are the newest, in order.
    const kept = [...text.matchAll(/## Fold (\d+)\n/g)].map((m) => Number(m[1]));
    expect(kept[kept.length - 1]).toBe(40);
    expect(kept).toEqual(kept.map((_, i) => 40 - kept.length + 1 + i));
  });

  it('always keeps the newest fold, even when it alone is over the cap', () => {
    const huge = 'y'.repeat(COMPACTION_SUMMARY_MAX_CHARS + 10);
    const text = appendFoldSection('## Fold 1\nold', huge);
    expect(text).toBe(`${COMPACTION_FOLDS_TRIMMED_MARKER}\n\n## Fold 2\n${huge}`);
  });

  it('keeps the previous fold when a new fold is as large as the summarizer may write', () => {
    const earlier = appendFoldSection(null, 'e'.repeat(20_000));
    const next = appendFoldSection(earlier, 'n'.repeat(40_000));
    expect(next.length).toBeLessThanOrEqual(COMPACTION_SUMMARY_MAX_CHARS);
    expect(next).toContain('## Fold 1');
    expect(next).toContain('## Fold 2');
  });
});
