import { describe, expect, it } from '@jest/globals';
import { assertSafeRealEmbeddingChildEnv } from '../../../../support/searchEval/safety';

describe('real embedding eval safety', () => {
  const valid = {
    NODE_ENV: 'test',
    SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS: '1',
    SNAGLET_PG_TEST_DATABASE: 'test_eval_worker_abc',
    SNAGLET_PG_TEST_HOME: '/tmp/snaglet-pg-test-home-abc',
    SNAGLET_HOME: '/tmp/snaglet-pg-test-home-abc',
    SNAGLET_DATABASE_URL:
      'postgresql://user:password@127.0.0.1:54321/test_eval_worker_abc?sslmode=disable',
  };

  it('accepts only an opted-in test database and matching disposable home', () => {
    expect(() => assertSafeRealEmbeddingChildEnv(valid)).not.toThrow();
  });

  it.each([
    ['inside CI', { CI: 'true' }],
    ['inside CI even with false text', { CI: 'false' }],
    ['without opt-in', { SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS: '0' }],
    ['outside test mode', { NODE_ENV: 'development' }],
    ['with a non-test database name', { SNAGLET_PG_TEST_DATABASE: 'snaglet_production' }],
    [
      'with a URL database mismatch',
      {
        SNAGLET_DATABASE_URL: valid.SNAGLET_DATABASE_URL.replace(
          'test_eval_worker_abc',
          'test_other'
        ),
      },
    ],
    ['with a home mismatch', { SNAGLET_HOME: '/tmp/other-home' }],
    ['without the per-file database marker', { SNAGLET_PG_TEST_DATABASE: '' }],
  ])('rejects unsafe environment %s', (_label, overrides) => {
    expect(() => assertSafeRealEmbeddingChildEnv({ ...valid, ...overrides })).toThrow(
      /real embedding eval/i
    );
  });

  it('rejects malformed database URLs rather than falling back to a default', () => {
    expect(() =>
      assertSafeRealEmbeddingChildEnv({ ...valid, SNAGLET_DATABASE_URL: 'not-a-url' })
    ).toThrow(/real embedding eval/i);
  });

  it('rejects an invalidly encoded database pathname', () => {
    expect(() =>
      assertSafeRealEmbeddingChildEnv({
        ...valid,
        SNAGLET_DATABASE_URL: valid.SNAGLET_DATABASE_URL.replace(
          '/test_eval_worker_abc',
          '/test_eval_worker_%ZZ'
        ),
      })
    ).toThrow(/real embedding eval/i);
  });
});
