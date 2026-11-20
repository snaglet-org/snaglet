/**
 * Unit tests for projectConfig — the write side of a folder's `snaglet.config.json`.
 *
 * The settings UI edits only the fields Snaglet manages (`embeddings.enabled`,
 * `ignorePaths`, `ignoreFileTypes`). These tests pin the three hard guarantees:
 *   1. unknown keys (top-level and inside `embeddings`) survive a round-trip,
 *   2. writes are atomic (no leftover temp files, valid JSON on disk),
 *   3. a hand-broken (unparseable) file is refused, never clobbered.
 * They run against temp dirs and touch nothing under ~/.snaglet.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { AppError } from '@snaglet/shared/utils';
import { WATCH_CONFIG_FILENAME } from '@server/services/fileIndexing/watchConfig';
import { readIndexConfig, writeIndexConfig } from '@server/services/fileIndexing/projectConfig';

describe('projectConfig read/write round-trip', () => {
  let dir: string;
  const configFile = () => path.join(dir, WATCH_CONFIG_FILENAME);
  const write = (obj: unknown) => writeFile(configFile(), JSON.stringify(obj, null, 2));
  const readJson = async () => JSON.parse(await readFile(configFile(), 'utf8'));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'snaglet-projectconfig-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the file with embeddings.enabled=true when absent', async () => {
    expect((await readIndexConfig(dir)).configExists).toBe(false);

    const result = await writeIndexConfig(dir, { ignorePaths: ['dist'] });
    expect(result.created).toBe(true);
    expect(result.enabled).toBe(true); // opt-in ON by default on creation
    expect(result.ignorePaths).toEqual(['dist']);

    expect(await readJson()).toEqual({
      embeddings: { enabled: true, ignorePaths: ['dist'] },
    });
  });

  it('preserves unknown keys — top-level and inside embeddings — on write', async () => {
    await write({
      $schema: 'https://example.com/snaglet.schema.json',
      customTool: { retries: 3 },
      embeddings: {
        enabled: true,
        provider: 'nomic', // unmanaged field inside embeddings
        ignorePaths: ['dist'],
      },
    });

    await writeIndexConfig(dir, {
      includePaths: ['src', 'docs'],
      ignorePaths: ['dist', 'docs/generated'],
      ignoreFileTypes: ['csv'],
    });

    expect(await readJson()).toEqual({
      $schema: 'https://example.com/snaglet.schema.json',
      customTool: { retries: 3 },
      embeddings: {
        enabled: true,
        provider: 'nomic',
        includePaths: ['src', 'docs'],
        ignorePaths: ['dist', 'docs/generated'],
        ignoreFileTypes: ['csv'],
      },
    });
  });

  it('does not silently enable indexing when editing an existing file that lacks `enabled`', async () => {
    // A folder gated off by omission: `embeddings` exists but has no `enabled`
    // key (readWatchConfig/GET treat this as disabled).
    await write({ embeddings: { ignorePaths: ['dist'] } });

    // Editing only the ignore rules must not flip indexing on.
    const result = await writeIndexConfig(dir, { ignorePaths: ['dist', 'build'] });

    expect(result.created).toBe(false);
    expect(result.enabled).toBe(false);
    // No `enabled` key was injected into the on-disk file …
    const onDisk = await readJson();
    expect(onDisk.embeddings.enabled).toBeUndefined();
    expect(onDisk.embeddings.ignorePaths).toEqual(['dist', 'build']);
    // … and GET still reads the folder as disabled.
    expect((await readIndexConfig(dir)).enabled).toBe(false);
  });

  it('round-trips through readIndexConfig and leaves untouched fields alone', async () => {
    await writeIndexConfig(dir, {
      enabled: false,
      includePaths: ['src'],
      ignorePaths: ['a', 'b'],
      ignoreFileTypes: ['png'],
    });
    // A later edit that omits ignoreFileTypes must not drop it.
    await writeIndexConfig(dir, { ignorePaths: ['a'] });

    const view = await readIndexConfig(dir);
    expect(view).toMatchObject({
      configExists: true,
      parseError: false,
      enabled: false,
      includePaths: ['src'],
      ignorePaths: ['a'],
      ignoreFileTypes: ['png'],
    });
  });

  it('trims, de-dupes, and drops blank rule entries', async () => {
    const result = await writeIndexConfig(dir, {
      ignorePaths: [' dist ', 'dist', '', '   ', 'docs'],
      ignoreFileTypes: ['CSV', 'csv', ''],
    });
    expect(result.ignorePaths).toEqual(['dist', 'docs']);
    // File types are cleaned (blanks/dupes) but not case-folded here — the UI
    // lower-cases before sending; compileIgnoreRules lower-cases at read time.
    expect(result.ignoreFileTypes).toEqual(['CSV', 'csv']);
  });

  it('writes atomically — no leftover temp files, always valid JSON on disk', async () => {
    await writeIndexConfig(dir, { ignorePaths: ['dist'] });
    await writeIndexConfig(dir, { ignorePaths: ['dist', 'build'] });

    const entries = await readdir(dir);
    expect(entries).toEqual([WATCH_CONFIG_FILENAME]); // only the config, no *.tmp
    await expect(readJson()).resolves.toBeDefined(); // parses cleanly
  });

  it('refuses to overwrite an unparseable file (never clobbers user content)', async () => {
    const broken = '{ "embeddings": { "enabled": true, ';
    await writeFile(configFile(), broken);

    expect((await readIndexConfig(dir)).parseError).toBe(true);
    await expect(writeIndexConfig(dir, { enabled: false })).rejects.toBeInstanceOf(AppError);
    // The broken bytes are left exactly as the user had them.
    expect(await readFile(configFile(), 'utf8')).toBe(broken);
  });
});
