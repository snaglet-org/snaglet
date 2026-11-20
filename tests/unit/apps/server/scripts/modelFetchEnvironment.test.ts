import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { loadModelFetchEnvironment } from '@server/scripts/modelFetchEnvironment';
import { embedderModelDir } from '@server/services/embedding/embedderModelManifest';
import { expandHome } from '@server/services/localModels/localModelManifest';
import { RERANKER_MODEL_MANIFEST } from '@server/services/reranking/rerankerModelManifest';

describe('model fetch environment', () => {
  let snapshot: NodeJS.ProcessEnv;
  let root: string;

  beforeEach(() => {
    snapshot = { ...process.env };
    delete process.env.SNAGLET_ENV;
    delete process.env.SNAGLET_HOME;
    root = mkdtempSync(join(tmpdir(), 'snaglet-model-fetch-'));
    // Bound the real env loader to a disposable checkout, not the user's files.
    writeFileSync(join(root, '.env'), '');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = snapshot;
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('targets dev runtime model paths when invoked from an ordinary shell', () => {
    loadModelFetchEnvironment(root);
    expect(embedderModelDir()).toBe(
      join(homedir(), '.snaglet-dev/models/embedders/nomic-embed-text-v1.5')
    );
    expect(expandHome(RERANKER_MODEL_MANIFEST.dir)).toContain(
      join(homedir(), '.snaglet-dev/models/rerankers/')
    );
  });

  it('uses checkout overrides with the same precedence as dev', () => {
    writeFileSync(join(root, '.env'), `SNAGLET_HOME=${root}/base\n`);
    writeFileSync(join(root, '.env.dev'), `SNAGLET_HOME=${root}/dev\n`);
    writeFileSync(join(root, '.env.local'), `SNAGLET_HOME=${root}/local\n`);
    loadModelFetchEnvironment(root);
    expect(embedderModelDir()).toBe(join(root, 'local/models/embedders/nomic-embed-text-v1.5'));
  });

  it('preserves an explicit home over checkout files, including tilde expansion', () => {
    writeFileSync(join(root, '.env.local'), `SNAGLET_HOME=${root}/ignored\n`);
    process.env.SNAGLET_HOME = '~/snaglet-model-test';
    loadModelFetchEnvironment(root);
    expect(embedderModelDir()).toBe(
      join(homedir(), 'snaglet-model-test/models/embedders/nomic-embed-text-v1.5')
    );
  });

  it('allows explicitly selecting the production home', () => {
    process.env.SNAGLET_ENV = 'prod';
    loadModelFetchEnvironment(root);
    expect(embedderModelDir()).toBe(
      join(homedir(), '.snaglet/models/embedders/nomic-embed-text-v1.5')
    );
  });

  it('rejects invalid modes instead of downloading into an unintended home', () => {
    process.env.SNAGLET_ENV = 'typo';
    expect(() => loadModelFetchEnvironment(root)).toThrow('Invalid SNAGLET_ENV');
  });
});
