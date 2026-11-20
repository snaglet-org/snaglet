/**
 * Unit tests for projectFolder.assertFolderExists — the validation gate behind
 * the project "Folder path" Save action. A real directory resolves; a missing
 * path or a non-directory rejects with a 400 AppError so the route never
 * persists (or symlinks) a bad path.
 *
 * Only assertFolderExists is covered here: it stats a caller-supplied path and
 * touches nothing under ~/.snaglet, so it's safe to exercise against temp dirs.
 * linkProjectFolder writes into the real Snaglet home and is left to integration.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { AppError } from '@snaglet/shared/utils';
import { assertFolderExists } from '@server/services/projectFolder';

describe('assertFolderExists', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'snaglet-projectfolder-'));
    file = path.join(dir, 'a-file.txt');
    await writeFile(file, 'hi');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the resolved absolute path for an existing directory', async () => {
    await expect(assertFolderExists(dir)).resolves.toBe(path.resolve(dir));
  });

  it('rejects with a 400 AppError when the path does not exist', async () => {
    const missing = path.join(dir, 'does-not-exist');
    await expect(assertFolderExists(missing)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(assertFolderExists(missing)).rejects.toThrow(/Folder not found/);
  });

  it('rejects when the path exists but is not a directory', async () => {
    await expect(assertFolderExists(file)).rejects.toBeInstanceOf(AppError);
    await expect(assertFolderExists(file)).rejects.toThrow(/Not a directory/);
  });
});
