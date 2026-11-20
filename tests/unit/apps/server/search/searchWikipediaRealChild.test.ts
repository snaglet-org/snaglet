import { expect, it, jest } from '@jest/globals';
import { runOptionalWikipediaRealChild } from '../../../../support/searchEval/wikipedia/launchRealChild';

const safe = {
  NODE_ENV: 'test',
  SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS: '1',
  SNAGLET_PG_TEST_DATABASE: 'test_wikipedia',
  SNAGLET_DATABASE_URL: 'postgresql://localhost/test_wikipedia',
  SNAGLET_PG_TEST_HOME: '/tmp/wiki-test',
  SNAGLET_HOME: '/tmp/wiki-test',
};
const execute = () => jest.fn(async () => ({ stdout: 'report', stderr: '' }));
it('does not launch without exact opt-in', async () => {
  const exec = execute();
  for (const flag of [undefined, '', '0', 'true']) {
    expect(
      await runOptionalWikipediaRealChild(
        { ...safe, SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS: flag },
        exec
      )
    ).toBeNull();
  }
  expect(exec).not.toHaveBeenCalled();
});
it('rejects CI and unsafe database before launching', async () => {
  const exec = execute();
  for (const env of [
    { ...safe, CI: '' },
    { ...safe, SNAGLET_DATABASE_URL: 'postgresql://localhost/live' },
  ]) {
    await expect(runOptionalWikipediaRealChild(env, exec)).rejects.toThrow('Unsafe real embedding');
  }
  expect(exec).not.toHaveBeenCalled();
});
it('launches a bounded isolated Wikipedia child only after validation', async () => {
  const exec = execute();
  expect(await runOptionalWikipediaRealChild(safe, exec)).toEqual({ stdout: 'report', stderr: '' });
  expect(exec).toHaveBeenCalledWith(
    process.execPath,
    [
      expect.stringContaining('tsx/dist/cli.mjs'),
      expect.stringContaining('wikipedia/realEmbeddingChild.ts'),
    ],
    expect.objectContaining({ timeout: 600000, maxBuffer: 33554432, env: safe })
  );
});
it('propagates child failure with captured diagnostics', async () => {
  const exec = jest.fn(async () => {
    throw Object.assign(new Error('timeout'), { stderr: 'child diagnostic' });
  });
  await expect(runOptionalWikipediaRealChild(safe, exec)).rejects.toThrow('child diagnostic');
});
