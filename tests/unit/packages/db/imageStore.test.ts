/**
 * Image blob store: file-name keys for renamed images and the two-phase blob
 * rename (stage, then finish or abandon) that keeps one readable name at
 * every step. Runs against a real temporary directory.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { link, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  abandonImageBlobRename,
  finishImageBlobRename,
  imageFileStem,
  locateImageBlob,
  readImageBlob,
  stageImageBlobRename,
  storageKeyExt,
  storageKeyFor,
  storageKeyForName,
  writeImageBlob,
} from '@snaglet/db/tables/images/imageStore';

/** Set to an errno code to make the store's hard links fail, as on a volume without them. */
let linkFailure: string | null = null;
jest.mock('fs/promises', () => {
  const actual = jest.requireActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    link: (from: string, to: string) =>
      linkFailure
        ? Promise.reject(Object.assign(new Error(linkFailure), { code: linkFailure }))
        : actual.link(from, to),
  };
});

const ID = 'image-1111111111111-aaaaaaaaa';
const BYTES = Buffer.from('png-bytes');

let dir: string;
const previousDir = process.env.SNAGLET_IMAGES_DIR;

beforeEach(async () => {
  linkFailure = null;
  dir = await mkdtemp(join(tmpdir(), 'snaglet-image-store-'));
  process.env.SNAGLET_IMAGES_DIR = dir;
});

afterEach(async () => {
  if (previousDir === undefined) delete process.env.SNAGLET_IMAGES_DIR;
  else process.env.SNAGLET_IMAGES_DIR = previousDir;
  await rm(dir, { recursive: true, force: true });
});

describe('imageFileStem', () => {
  it('replaces path separators and reserved characters', () => {
    expect(imageFileStem('a/b\\c:d*e?f"g<h>i|j', 'png')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('drops control characters and collapses whitespace', () => {
    expect(imageFileStem('  Sun\u0000set \t over\nbay  ', 'png')).toBe('Sunset over bay');
  });

  it('drops leading dots and trailing dots or spaces', () => {
    expect(imageFileStem('..hidden..', 'png')).toBe('hidden');
    expect(imageFileStem('../../etc', 'png')).toBe('-..-etc');
  });

  it('does not repeat a typed extension that matches the stored one', () => {
    expect(imageFileStem('Sunset.PNG', 'png')).toBe('Sunset');
    expect(imageFileStem('Sunset.jpg', 'png')).toBe('Sunset.jpg');
  });

  it('caps the stem by UTF-8 bytes without splitting a character', () => {
    const stem = imageFileStem('é'.repeat(200), 'png');
    expect(Buffer.byteLength(stem, 'utf8')).toBeLessThanOrEqual(150);
    expect(stem).toBe('é'.repeat(75));
  });

  it('returns an empty stem when nothing usable remains', () => {
    expect(imageFileStem(' ... ', 'png')).toBe('');
    expect(imageFileStem('.png', 'png')).toBe('');
  });
});

describe('storage keys', () => {
  it('puts the name first and keeps the id for uniqueness', () => {
    expect(storageKeyForName(ID, 'Sunset', 'png')).toBe(`Sunset-${ID}.png`);
  });

  it('falls back to the id-only key when the name has no usable characters', () => {
    expect(storageKeyForName(ID, '...', 'png')).toBe(`${ID}.png`);
    expect(storageKeyForName(ID, '\u0000\u0001', 'png')).toBe(`${ID}.png`);
  });

  it('reads the extension from an existing key, else from the mime type', () => {
    expect(storageKeyExt(`${ID}.jpg`, 'image/png')).toBe('jpg');
    expect(storageKeyExt('no-extension', 'image/webp')).toBe('webp');
    expect(storageKeyFor(ID, 'image/jpeg')).toBe(`${ID}.jpg`);
  });
});

describe('blob rename', () => {
  const oldKey = `${ID}.png`;
  const newKey = `Sunset-${ID}.png`;

  it('keeps both names readable until the rename is finished', async () => {
    await writeImageBlob(oldKey, BYTES);
    const stage = await stageImageBlobRename(oldKey, newKey);
    expect(stage).toBe('linked');
    expect(await readImageBlob(oldKey)).toEqual(BYTES);
    expect(await readImageBlob(newKey)).toEqual(BYTES);

    await finishImageBlobRename(oldKey, newKey, stage);
    expect(await readdir(dir)).toEqual([newKey]);
    expect(await readImageBlob(newKey)).toEqual(BYTES);
  });

  it('abandoning a staged rename leaves only the old name', async () => {
    await writeImageBlob(oldKey, BYTES);
    const stage = await stageImageBlobRename(oldKey, newKey);
    await abandonImageBlobRename(newKey, stage);
    expect(await readdir(dir)).toEqual([oldKey]);
    expect(await readImageBlob(oldKey)).toEqual(BYTES);
  });

  it('reports missing bytes without creating a file', async () => {
    expect(await stageImageBlobRename(oldKey, newKey)).toBe('missing');
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('replaces a leftover copy with identical bytes', async () => {
    await writeImageBlob(oldKey, BYTES);
    await writeFile(join(dir, newKey), BYTES);
    const stage = await stageImageBlobRename(oldKey, newKey);
    expect(stage).toBe('linked');
    await finishImageBlobRename(oldKey, newKey, stage);
    expect(await readdir(dir)).toEqual([newKey]);
  });

  it('refuses to overwrite a file with different bytes', async () => {
    await writeImageBlob(oldKey, BYTES);
    await writeFile(join(dir, newKey), Buffer.from('someone else'));
    await expect(stageImageBlobRename(oldKey, newKey)).rejects.toThrow(/different bytes/);
    expect(await readFile(join(dir, newKey), 'utf8')).toBe('someone else');
    expect(await readImageBlob(oldKey)).toEqual(BYTES);
  });

  it('retires the old name when the new one is a leftover hard link', async () => {
    await writeImageBlob(oldKey, BYTES);
    // An interrupted rename left both names on the one file.
    await link(join(dir, oldKey), join(dir, newKey));
    const stage = await stageImageBlobRename(oldKey, newKey);
    expect(stage).toBe('linked');
    await finishImageBlobRename(oldKey, newKey, stage);
    expect(await readdir(dir)).toEqual([newKey]);
    expect(await readImageBlob(newKey)).toEqual(BYTES);
  });

  it('copies on a volume without hard links and removes the old name after', async () => {
    linkFailure = 'EPERM';
    await writeImageBlob(oldKey, BYTES);
    const stage = await stageImageBlobRename(oldKey, newKey);
    expect(stage).toBe('linked');
    const [a, b] = await Promise.all([stat(join(dir, oldKey)), stat(join(dir, newKey))]);
    expect(a.ino).not.toBe(b.ino);
    await finishImageBlobRename(oldKey, newKey, stage);
    expect(await readdir(dir)).toEqual([newKey]);
    expect(await readImageBlob(newKey)).toEqual(BYTES);
  });

  it('never copies over a different file on a volume without hard links', async () => {
    linkFailure = 'ENOTSUP';
    await writeImageBlob(oldKey, BYTES);
    await writeFile(join(dir, newKey), Buffer.from('someone else'));
    await expect(stageImageBlobRename(oldKey, newKey)).rejects.toThrow(/different bytes/);
    expect(await readFile(join(dir, newKey), 'utf8')).toBe('someone else');

    await writeFile(join(dir, newKey), BYTES);
    expect(await stageImageBlobRename(oldKey, newKey)).toBe('linked');
  });

  it('never unlinks a name that reaches the same file', async () => {
    const lower = `sunset-${ID}.png`;
    const upper = `Sunset-${ID}.png`;
    await writeImageBlob(lower, BYTES);
    const stage = await stageImageBlobRename(lower, upper);
    await finishImageBlobRename(lower, upper, stage);
    // A case-insensitive volume keeps one entry with the new case; a
    // case-sensitive one ends with the new name only.
    expect(await readdir(dir)).toEqual([upper]);
    expect(await readImageBlob(upper)).toEqual(BYTES);
  });
});

describe('locateImageBlob', () => {
  it('finds the bytes by id under either key shape', async () => {
    expect(await locateImageBlob(ID, 'png')).toBeNull();
    await writeImageBlob(`Sunset-${ID}.png`, BYTES);
    await writeImageBlob('image-2222222222222-bbbbbbbbb.png', BYTES);
    expect(await locateImageBlob(ID, 'png')).toBe(`Sunset-${ID}.png`);
    await writeImageBlob(`${ID}.png`, BYTES);
    expect(await locateImageBlob(ID, 'png')).toBe(`${ID}.png`);
  });
});
