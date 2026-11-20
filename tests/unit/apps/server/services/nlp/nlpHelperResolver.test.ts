/**
 * nlpHelperResolver — pure path/availability logic, mirroring
 * sttEngineResolver.test.ts. Exercises the resolver's own functions against
 * the real filesystem/PATH (no mocking of fs/child_process): on this
 * (developer) darwin machine the helper should be buildable via swiftc; the
 * resolver must never throw regardless of platform.
 */

import { describe, expect, it } from '@jest/globals';
import {
  nlpHelperBinaryExists,
  nlpHelperBinaryPath,
  swiftcAvailable,
} from '@server/services/nlp/nlpHelperResolver';

describe('nlpHelperResolver', () => {
  it('resolves a stable absolute binary path', () => {
    const p = nlpHelperBinaryPath();
    expect(p.endsWith('snaglet-nlp-helper')).toBe(true);
    expect(p).toContain('nlp-helper');
  });

  it('honors SNAGLET_NLP_HELPER_BIN override', () => {
    const prior = process.env.SNAGLET_NLP_HELPER_BIN;
    process.env.SNAGLET_NLP_HELPER_BIN = '/tmp/custom-snaglet-nlp-helper';
    try {
      expect(nlpHelperBinaryPath()).toBe('/tmp/custom-snaglet-nlp-helper');
    } finally {
      if (prior === undefined) delete process.env.SNAGLET_NLP_HELPER_BIN;
      else process.env.SNAGLET_NLP_HELPER_BIN = prior;
    }
  });

  it('nlpHelperBinaryExists never throws, regardless of whether the binary is built', () => {
    expect(() => nlpHelperBinaryExists()).not.toThrow();
    expect(typeof nlpHelperBinaryExists()).toBe('boolean');
  });

  it('swiftcAvailable never throws and is memoized (repeat calls are cheap/consistent)', () => {
    expect(() => swiftcAvailable()).not.toThrow();
    const first = swiftcAvailable();
    const second = swiftcAvailable();
    expect(second).toBe(first);
  });
});
