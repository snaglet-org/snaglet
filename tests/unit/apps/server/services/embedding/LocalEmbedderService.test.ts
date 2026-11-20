/**
 * LocalEmbedderService — unit tests for the pure pipeline pieces (prefix
 * contract, pooling math), plus a real-model integration block that runs when
 * the model files are installed (`pnpm embedder:fetch`) and self-skips
 * otherwise, so CI without the 137 MB download stays green.
 *
 * The real-model block shells out to `verify-embedder.ts` in a child process:
 * onnxruntime-node rejects typed arrays created inside jest's sandboxed VM
 * realm (`instanceof Float32Array` fails across realms), so the session can't
 * run in-process here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  applyTaskPrefix,
  l2Normalize,
  layerNorm,
  meanPool,
} from '@server/services/embedding/LocalEmbedderService';
import { embedderModelFilePath } from '@server/services/embedding/embedderModelManifest';

describe('applyTaskPrefix (the prefix contract)', () => {
  it('prefixes documents with search_document', () => {
    expect(applyTaskPrefix('document', 'hello world')).toBe('search_document: hello world');
  });

  it('prefixes queries with search_query', () => {
    expect(applyTaskPrefix('query', 'hello world')).toBe('search_query: hello world');
  });
});

describe('meanPool', () => {
  it('averages only attended positions', () => {
    // 3 tokens × 2 dims; third token is padding.
    const hidden = new Float32Array([1, 2, 3, 4, 100, 100]);
    expect(meanPool(hidden, 3, 2, [1, 1, 0])).toEqual([2, 3]);
  });

  it('returns zeros for an all-masked sequence instead of NaN', () => {
    const hidden = new Float32Array([1, 2]);
    expect(meanPool(hidden, 1, 2, [0])).toEqual([0, 0]);
  });
});

describe('layerNorm', () => {
  it('normalizes to zero mean and unit variance', () => {
    const out = layerNorm([1, 2, 3, 4]);
    const mean = out.reduce((s, v) => s + v, 0) / out.length;
    const variance = out.reduce((s, v) => s + (v - mean) ** 2, 0) / out.length;
    expect(mean).toBeCloseTo(0, 6);
    expect(variance).toBeCloseTo(1, 3);
  });

  it('handles a constant vector without dividing by zero', () => {
    const out = layerNorm([5, 5, 5]);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('l2Normalize', () => {
  it('produces a unit vector', () => {
    const out = l2Normalize([3, 4]);
    expect(out[0]).toBeCloseTo(0.6);
    expect(out[1]).toBeCloseTo(0.8);
  });

  it('leaves the zero vector untouched', () => {
    expect(l2Normalize([0, 0])).toEqual([0, 0]);
  });
});

// Real-model integration (self-skips when the model isn't installed)

const modelInstalled = existsSync(embedderModelFilePath('model'));
const serverDir = path.resolve(__dirname, '../../../../../../apps/server');

(modelInstalled ? describe : describe.skip)('LocalEmbedderService (real ONNX model)', () => {
  it('verify-embedder passes: 768 dims, unit norm, prefixes applied, sane ordering', () => {
    const stdout = execFileSync('pnpm', ['exec', 'tsx', 'src/scripts/verify-embedder.ts'], {
      cwd: serverDir,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const report = JSON.parse(stdout.trim().split('\n').at(-1)!) as {
      ok: boolean;
      dimensions: number;
      docNorm: number;
      cosSameTextDocVsQuery: number;
      cosRelated: number;
      cosUnrelated: number;
    };
    expect(report.ok).toBe(true);
    expect(report.dimensions).toBe(768);
    expect(report.docNorm).toBeCloseTo(1, 4);
    expect(report.cosSameTextDocVsQuery).toBeLessThan(0.999);
    expect(report.cosRelated).toBeGreaterThan(report.cosUnrelated);
  }, 150_000);
});
