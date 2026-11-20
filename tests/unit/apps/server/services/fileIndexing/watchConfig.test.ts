/**
 * Unit tests for watchConfig — the per-folder indexing gate.
 *
 * `ensureWatchConfig` auto-writes `snaglet.config.json` with embeddings enabled so a
 * user setting a project folder doesn't have to add the gate by hand, but it
 * never clobbers an existing config (an explicit `enabled: false` opt-out is
 * kept) and fails soft when the folder can't be written to. These run
 * against temp dirs and touch nothing under ~/.snaglet.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  ensureWatchConfig,
  isWatchEnabled,
  readWatchConfig,
  watchConfigPath,
  WATCH_CONFIG_FILENAME,
} from '@server/services/fileIndexing/watchConfig';

describe('ensureWatchConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'snaglet-watchconfig-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates snaglet.config.json with embeddings enabled when absent', async () => {
    expect(await isWatchEnabled(dir)).toBe(false); // no gate yet

    const created = await ensureWatchConfig(dir);
    expect(created).toBe(true);

    const raw = await readFile(watchConfigPath(dir), 'utf8');
    expect(JSON.parse(raw)).toEqual({ embeddings: { enabled: true } });
    expect(await isWatchEnabled(dir)).toBe(true);
  });

  it('does not overwrite an existing config (keeps an explicit opt-out)', async () => {
    const optOut = JSON.stringify({ embeddings: { enabled: false } });
    await writeFile(path.join(dir, WATCH_CONFIG_FILENAME), optOut);

    const created = await ensureWatchConfig(dir);
    expect(created).toBe(false); // already present → untouched

    const raw = await readFile(watchConfigPath(dir), 'utf8');
    expect(raw).toBe(optOut); // byte-for-byte unchanged
    expect(await isWatchEnabled(dir)).toBe(false);
  });

  it('writes identity alongside a new gate', async () => {
    await ensureWatchConfig(dir, 'container-test');
    expect(JSON.parse(await readFile(watchConfigPath(dir), 'utf8'))).toEqual({
      projectId: 'container-test',
      embeddings: { enabled: true },
    });
  });

  it('adds identity without changing opt-out or custom fields', async () => {
    await writeFile(
      watchConfigPath(dir),
      JSON.stringify({
        embeddings: { enabled: false, ignorePaths: ['private'] },
        custom: 'keep',
      })
    );
    expect(await ensureWatchConfig(dir, 'container-test')).toBe(false);
    expect(JSON.parse(await readFile(watchConfigPath(dir), 'utf8'))).toEqual({
      projectId: 'container-test',
      embeddings: { enabled: false, ignorePaths: ['private'] },
      custom: 'keep',
    });
  });

  it.each(['{broken', '[]', 'null', '{"projectId":"container-other"}'])(
    'leaves malformed and claimed configs unchanged: %s',
    async (raw) => {
      await writeFile(watchConfigPath(dir), raw);
      await ensureWatchConfig(dir, 'container-test');
      expect(await readFile(watchConfigPath(dir), 'utf8')).toBe(raw);
    }
  );

  it('fails soft (returns false, no throw) when the folder cannot be written', async () => {
    const missing = path.join(dir, 'does', 'not', 'exist');
    await expect(ensureWatchConfig(missing)).resolves.toBe(false);
  });
});

describe('readWatchConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'snaglet-readconfig-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (obj: unknown) =>
    writeFile(path.join(dir, WATCH_CONFIG_FILENAME), JSON.stringify(obj));

  it('parses enabled + includePaths + ignorePaths + ignoreFileTypes', async () => {
    await write({
      embeddings: {
        enabled: true,
        includePaths: ['src', 'docs'],
        ignorePaths: ['.playwright-mcp/*', 'dist'],
        ignoreFileTypes: ['png', 'pdf'],
      },
    });
    await expect(readWatchConfig(dir)).resolves.toEqual({
      status: 'present',
      enabled: true,
      includePaths: ['src', 'docs'],
      ignorePaths: ['.playwright-mcp/*', 'dist'],
      ignoreFileTypes: ['png', 'pdf'],
    });
  });

  it('defaults arrays to empty when the keys are absent', async () => {
    await write({ embeddings: { enabled: true } });
    await expect(readWatchConfig(dir)).resolves.toEqual({
      status: 'present',
      enabled: true,
      includePaths: [],
      ignorePaths: [],
      ignoreFileTypes: [],
    });
  });

  it('drops non-string array entries instead of rejecting the file', async () => {
    await write({ embeddings: { enabled: true, ignorePaths: ['ok', 3, null, { x: 1 }] } });
    const cfg = await readWatchConfig(dir);
    expect(cfg.ignorePaths).toEqual(['ok']);
  });

  it('is fail-safe (disabled, empty) for missing or malformed config', async () => {
    const empty = { includePaths: [], ignorePaths: [], ignoreFileTypes: [] };
    // No file in an existing folder → the destructive-signal provenance.
    await expect(readWatchConfig(dir)).resolves.toEqual({
      ...empty,
      status: 'missing',
      enabled: false,
    });
    // Bad JSON → invalid, never 'missing': a hand-edit typo must stay
    // distinguishable from deliberate removal (only removal may purge).
    await writeFile(path.join(dir, WATCH_CONFIG_FILENAME), '{ not json');
    await expect(readWatchConfig(dir)).resolves.toEqual({
      ...empty,
      status: 'invalid',
      enabled: false,
    });
  });

  // Provenance is the load-bearing distinction for the pause-vs-purge
  // lifecycle: 'missing' is the only status the sweep treats destructively.
  it('reports an explicit enabled:false as present (the reversible pause)', async () => {
    await write({ embeddings: { enabled: false } });
    const cfg = await readWatchConfig(dir);
    expect(cfg.status).toBe('present');
    expect(cfg.enabled).toBe(false);
  });

  it('reports a config without an embeddings block as present, not missing', async () => {
    await write({ someOtherTool: { setting: 1 } });
    const cfg = await readWatchConfig(dir);
    expect(cfg.status).toBe('present');
    expect(cfg.enabled).toBe(false);
  });

  it('reports a non-object root as invalid', async () => {
    await writeFile(path.join(dir, WATCH_CONFIG_FILENAME), '["not", "an", "object"]');
    const cfg = await readWatchConfig(dir);
    expect(cfg.status).toBe('invalid');
    expect(cfg.enabled).toBe(false);
  });

  it('reports an unreachable folder as unreadable, never missing', async () => {
    // The folder itself is gone (unmounted volume / deleted tree). ENOENT on
    // the gate file must not read as "config removed" — that would let a
    // disconnected drive masquerade as a destructive unconfigure.
    const gone = path.join(dir, 'not', 'mounted');
    const cfg = await readWatchConfig(gone);
    expect(cfg.status).toBe('unreadable');
    expect(cfg.enabled).toBe(false);
  });
});
