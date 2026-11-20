import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertScratchPreviewPort,
  parseScratchPreviewArgs,
  sanitizeScratchPreviewEnvironment,
  scratchEmbeddingEnvironment,
  scratchTestCredentialEnvironment,
} from '../../scripts/preview-scratch';

test('scratch preview defaults to a fresh build, free port, and preserved runtime', () => {
  assert.deepEqual(parseScratchPreviewArgs([]), {
    reuseBuild: false,
    exitAfterReady: false,
    cleanupOnExit: false,
    help: false,
  });
});

test('scratch preview parses explicit automation and port options', () => {
  assert.deepEqual(
    parseScratchPreviewArgs([
      '--',
      '--reuse-build',
      '--port=45123',
      '--exit-after-ready',
      '--cleanup-on-exit',
    ]),
    {
      reuseBuild: true,
      port: 45123,
      exitAfterReady: true,
      cleanupOnExit: true,
      help: false,
    }
  );
});

test('scratch preview rejects reserved Snaglet dev ports and malformed options', () => {
  assert.throws(() => assertScratchPreviewPort(4000), /reserved Snaglet dev port/);
  assert.throws(() => assertScratchPreviewPort(3007), /reserved Snaglet dev port/);
  assert.throws(() => parseScratchPreviewArgs(['--port', 'nope']), /integer from 1024/);
  assert.throws(() => parseScratchPreviewArgs(['--unknown']), /Unknown scratch-preview option/);
});

test('scratch preview strips inherited live database, storage, port, and credential state', () => {
  const sanitized = sanitizeScratchPreviewEnvironment({
    PATH: '/usr/bin',
    PORT: '4000',
    CLIENT_PORT: '3000',
    API_BASE_URL: 'http://localhost:4000',
    CLIENT_BASE_URL: 'http://localhost:3000',
    SNAGLET_DB_MODE: 'external',
    SNAGLET_DATABASE_URL: 'postgresql://live.example/snaglet',
    DATABASE_URL: 'postgresql://live.example/snaglet',
    SNAGLET_PG_DATA_DIR: '/live/postgres',
    SNAGLET_HOME: '/live/home',
    SNAGLET_HOME_POINTER_FILE: '/live/pointer.json',
    SNAGLET_BACKUPS_DIR: '/live/backups',
    SNAGLET_LOG_DIR: '/live/logs',
    SNAGLET_ALLOWED_ORIGINS: 'http://localhost:3000',
    SNAGLET_API_RATE_LIMIT_MAX: '200',
    SNAGLET_API_RATE_LIMIT_PER_SECOND: '5',
    SNAGLET_API_RATE_LIMIT_BURST: '10',
    CREDENTIAL_ENCRYPTION_KEY: 'live-key',
    OPENAI_API_KEY: 'live-openai-key',
    CODEX_ACCESS_TOKEN: 'live-codex-token',
    TOGETHER_API_KEY: 'live-together-key',
    COPILOT_SECRET: 'live-copilot-secret',
  });

  assert.deepEqual(sanitized, { PATH: '/usr/bin' });
});

test('scratch preview passes only supported test credentials to the isolated child', () => {
  const selected = scratchTestCredentialEnvironment({
    ANTHROPIC_API_KEY: ' anthropic-key ',
    CODEX_ACCESS_TOKEN: 'codex-access',
    CODEX_REFRESH_TOKEN: 'codex-refresh',
    COPILOT_TOKEN: 'copilot-token',
    GROQ_API_KEY: 'unsupported-groq-key',
    GITHUB_COPILOT_TOKEN: 'ambient-copilot-fallback',
  });

  assert.equal(selected.ANTHROPIC_API_KEY, 'anthropic-key');
  assert.equal(selected.CODEX_ACCESS_TOKEN, 'codex-access');
  assert.equal(selected.CODEX_REFRESH_TOKEN, 'codex-refresh');
  assert.equal(selected.COPILOT_TOKEN, 'copilot-token');
  assert.equal(selected.GROQ_API_KEY, '');
  assert.equal(selected.GITHUB_COPILOT_TOKEN, '');
  assert.equal(selected.OPENAI_API_KEY, '');
});

test('scratch preview enables automatic local embeddings and background workers', () => {
  assert.deepEqual(scratchEmbeddingEnvironment(), {
    SNAGLET_LOCAL_INTELLIGENCE: 'true',
    RUN_BACKGROUND_WORKERS: 'true',
  });
});
