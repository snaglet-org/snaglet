/**
 * memoryRecallFloor — the admission rule for auto-injected memories.
 * Calibration on real embeddings is covered by
 * tests/integration/apps/server/services/summary/memoryRecallFloor.test.ts;
 * these cases pin the rule's arithmetic and edge paths.
 */
import { describe, expect, it } from '@jest/globals';
import type { MemorySearchResult } from '@snaglet/db/tables/memories';
import {
  MEMORY_RECALL_MARGIN,
  MEMORY_RECALL_MIN_POOL,
  MEMORY_RECALL_MIN_SIMILARITY,
  MEMORY_RECALL_SMALL_POOL_FLOOR,
  selectRecalledMemories,
} from '@server/services/summary/memoryRecallFloor';

function row(
  key: string,
  vectorScore: number | null,
  keywordScore: number | null = 0
): MemorySearchResult {
  return {
    id: `memory-${key}`,
    agentId: 'agent-1',
    memberId: null,
    key,
    content: key,
    sourceThreadId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    combinedScore: vectorScore ?? 0,
    vectorScore,
    keywordScore,
  };
}

/** n rows at `score`, keys noise0..noiseN. */
const noise = (n: number, score: number) =>
  Array.from({ length: n }, (_, i) => row(`noise${i}`, score));

const keys = (rows: MemorySearchResult[]) => rows.map((r) => r.key);

describe('selectRecalledMemories', () => {
  it('uses the calibrated constants', () => {
    expect(MEMORY_RECALL_MARGIN).toBe(0.1);
    expect(MEMORY_RECALL_MIN_SIMILARITY).toBe(0.55);
    expect(MEMORY_RECALL_MIN_POOL).toBe(5);
    expect(MEMORY_RECALL_SMALL_POOL_FLOOR).toBe(0.75);
  });

  it('a flat high band (generic agent prose) admits nothing, however high', () => {
    const rows = [0.82, 0.8, 0.79, 0.78, 0.77, 0.76, 0.75, 0.74, 0.73, 0.72].map((v, i) =>
      row(`g${i}`, v)
    );
    expect(selectRecalledMemories(rows)).toEqual([]);
  });

  it('admits a row standing at least the margin above the mean', () => {
    // mean = (0.70 + 9*0.55)/10 = 0.565 → 0.70 leads by 0.135
    expect(keys(selectRecalledMemories([row('hit', 0.7), ...noise(9, 0.55)]))).toEqual(['hit']);
  });

  it('rejects a row just under the margin', () => {
    // mean = (0.64 + 9*0.55)/10 = 0.559 → lead 0.081
    expect(selectRecalledMemories([row('near', 0.64), ...noise(9, 0.55)])).toEqual([]);
  });

  it('a standout below the absolute minimum is rejected', () => {
    // mean = (0.54 + 9*0.3)/10 = 0.324 → huge lead, but 0.54 < 0.55
    expect(selectRecalledMemories([row('weak', 0.54), ...noise(9, 0.3)])).toEqual([]);
  });

  it('a keyword match alone does not admit a row inside the band', () => {
    const rows = [row('kw', 0.56, 0.4), ...noise(9, 0.55)];
    expect(selectRecalledMemories(rows)).toEqual([]);
  });

  it('keeps recall order among admitted rows', () => {
    const rows = [row('b', 0.8), row('a', 0.85), ...noise(8, 0.5)];
    expect(keys(selectRecalledMemories(rows))).toEqual(['b', 'a']);
  });

  it('small pool: falls back to the absolute small-pool floor', () => {
    const rows = [row('strong', 0.78), row('mid', 0.7), row('low', 0.5)];
    expect(keys(selectRecalledMemories(rows))).toEqual(['strong']);
  });

  it('keyword-only recall (no embedder): FTS-matched rows are admitted', () => {
    const rows = [row('fts', null, 0.2), row('none', null, 0)];
    expect(keys(selectRecalledMemories(rows))).toEqual(['fts']);
  });

  it('empty input → empty output', () => {
    expect(selectRecalledMemories([])).toEqual([]);
  });
});
