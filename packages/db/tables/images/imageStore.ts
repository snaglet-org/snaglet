/**
 * On-disk blob store for image bytes.
 *
 * The DB `images` row is the source of truth for an image's identity, metadata,
 * and tree placement; the raw bytes live here, in `<SNAGLET_HOME>/images/` (override
 * with `SNAGLET_IMAGES_DIR`), referenced by a storage key (the filename) stored in
 * `images.url`. The key is deliberately a relative filename — not an absolute
 * path — so the store can reorganize (e.g. hash-sharding into `ab/cd/…`) later
 * without touching any node. Readers always take the key from `images.url`;
 * they never derive it from the id.
 *
 * Key shapes, both read the same way:
 *   - `<id>.<ext>`: a new image, or one whose name has no usable file-name
 *     characters.
 *   - `<name>-<id>.<ext>`: a renamed image. The name comes first so the folder
 *     sorts by name in Finder; the id suffix keeps keys collision-free.
 *
 * Older rows keep a `data:<mime>;base64,…` URL inline in `images.url` instead
 * of a key; `ImageModel` resolves both shapes.
 */

import { constants } from 'fs';
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { extname, join } from 'path';
import { resolveDbHome } from '../../runtime/snaglet-home';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/**
 * UTF-8 byte cap for the name part of a key. With `-<id>.<ext>` appended the
 * file name stays well under the 255-byte limit of APFS, ext4 and NTFS.
 */
const MAX_STEM_BYTES = 150;

/** Characters no file name may hold on macOS, Windows or Linux. */
const UNSAFE_FILENAME_CHARS = /[/\\:*?"<>|]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Errors `link` raises on a volume without hard links; the bytes are copied instead. */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS']);

/**
 * The directory image bytes are written to. Defaults to `<SNAGLET_HOME>/images`;
 * `SNAGLET_IMAGES_DIR` overrides it (used for a user-configured location and for
 * test isolation).
 */
export function imagesDir(): string {
  const override = process.env.SNAGLET_IMAGES_DIR?.trim();
  return override && override.length > 0 ? override : join(resolveDbHome(), 'images');
}

export function imageBlobPath(key: string): string {
  return join(imagesDir(), key);
}

function extForMime(mimeType: string): string {
  return EXT_BY_MIME[mimeType.toLowerCase()] ?? 'bin';
}

/** A stable, collision-free storage key for a node id + mime type. */
export function storageKeyFor(id: string, mimeType: string): string {
  return `${id}.${extForMime(mimeType)}`;
}

/** The extension (no dot) an existing key stores its bytes under. */
export function storageKeyExt(key: string, mimeType: string): string {
  const ext = extname(key).slice(1);
  return ext.length > 0 ? ext : extForMime(mimeType);
}

/**
 * A display name made safe as a file-name stem on macOS, Windows and Linux:
 * no path separators, reserved or control characters, no leading dots (they
 * hide the file) or trailing dots and spaces, at most {@link MAX_STEM_BYTES}.
 * A typed `.<ext>` matching the stored extension is not repeated. Returns ''
 * when nothing usable remains.
 */
export function imageFileStem(name: string, ext: string): string {
  let stem = name
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(UNSAFE_FILENAME_CHARS, '-')
    .trim();
  const dotted = `.${ext.toLowerCase()}`;
  if (stem.toLowerCase().endsWith(dotted)) stem = stem.slice(0, -dotted.length);
  stem = stem.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  let bytes = 0;
  let capped = '';
  for (const ch of stem) {
    bytes += Buffer.byteLength(ch, 'utf8');
    if (bytes > MAX_STEM_BYTES) break;
    capped += ch;
  }
  return capped.replace(/[.\s]+$/, '');
}

/** The storage key an image with this display name is saved under. */
export function storageKeyForName(id: string, name: string, ext: string): string {
  const stem = imageFileStem(name, ext);
  return stem ? `${stem}-${id}.${ext}` : `${id}.${ext}`;
}

/** True when an `images.url` value is a storage key rather than an inline data URL. */
export function isStorageKey(url: string): boolean {
  return !url.startsWith('data:');
}

export async function writeImageBlob(key: string, data: Buffer): Promise<void> {
  await mkdir(imagesDir(), { recursive: true });
  await writeFile(imageBlobPath(key), data);
}

/** Remove a blob; an already-missing file is not an error. */
export async function removeImageBlob(key: string): Promise<void> {
  await rm(imageBlobPath(key), { force: true });
}

export async function readImageBlob(key: string): Promise<Buffer | null> {
  try {
    return await readFile(imageBlobPath(key));
  } catch {
    // Missing/unreadable bytes resolve to null; the DB node still exists (it is
    // the source of truth) — callers surface a "bytes missing" state rather than
    // throwing.
    return null;
  }
}

/** True when a file exists at `key`. */
export async function hasImageBlob(key: string): Promise<boolean> {
  return (await stat(imageBlobPath(key)).catch(() => null)) !== null;
}

/**
 * The key of the file holding an image's bytes, found by its id: `<id>.<ext>`
 * or any `<name>-<id>.<ext>`. Used when the row's key has no file, e.g. after
 * restoring a database backup taken before the image was renamed.
 */
export async function locateImageBlob(id: string, ext: string): Promise<string | null> {
  const exact = `${id}.${ext}`;
  const suffix = `-${exact}`;
  try {
    const names = await readdir(imagesDir());
    return names.find((name) => name === exact) ?? names.find((n) => n.endsWith(suffix)) ?? null;
  } catch {
    return null;
  }
}

/**
 * How a blob rename was staged:
 *   - `linked`: the bytes now have both names, as two directory entries;
 *     finishing removes the old one.
 *   - `same-file`: both keys name one directory entry (a case-only change on
 *     a case-insensitive volume); finishing renames it to fix the case.
 *   - `missing`: the old key has no bytes, so nothing moves and the key stays.
 */
export type BlobRenameStage = 'linked' | 'same-file' | 'missing';

async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

/**
 * Give `from`'s bytes the name `to`, failing with EEXIST if `to` is taken. A
 * volume without hard links gets a copy, flushed to disk before the caller
 * may remove the old name.
 */
async function linkOrCopy(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
    return;
  } catch (err) {
    if (!LINK_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }
  await copyFile(from, to, constants.COPYFILE_EXCL);
  const copy = await open(to, 'r');
  try {
    await copy.sync();
  } finally {
    await copy.close();
  }
}

/**
 * First half of a blob rename: give the bytes at `fromKey` the name `toKey`
 * while the old name stays readable, so the DB can point at either key at
 * every instant and a crash between the halves loses nothing.
 *
 * A name already at `toKey` is checked before anything is removed. If it is
 * the old entry itself under another case, the rename fixes the case. If it
 * is a second hard link to the same file (left by an interrupted rename), the
 * old name is the one retired. A different file with identical bytes is a
 * leftover copy and is replaced; one with other bytes is refused rather than
 * overwritten.
 */
export async function stageImageBlobRename(
  fromKey: string,
  toKey: string
): Promise<BlobRenameStage> {
  const from = imageBlobPath(fromKey);
  const to = imageBlobPath(toKey);
  try {
    await linkOrCopy(from, to);
    return 'linked';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const source = await stat(from).catch(() => null);
      if (!source) return 'missing';
      throw err;
    }
    if (code !== 'EEXIST') throw err;
  }
  if (await sameFile(from, to)) {
    // Two listed entries are two links; otherwise `toKey` only resolves to
    // the old entry by case, and unlinking either name would lose the bytes.
    const entries = new Set(await readdir(imagesDir()));
    return entries.has(fromKey) && entries.has(toKey) ? 'linked' : 'same-file';
  }
  const [ours, theirs] = await Promise.all([readFile(from), readFile(to)]);
  if (!ours.equals(theirs)) {
    throw new Error(`Image file ${toKey} already exists with different bytes`);
  }
  await rm(to, { force: true });
  await linkOrCopy(from, to);
  return 'linked';
}

/** Second half, after the DB points at `toKey`: retire the old name. */
export async function finishImageBlobRename(
  fromKey: string,
  toKey: string,
  stage: BlobRenameStage
): Promise<void> {
  if (stage === 'linked') await rm(imageBlobPath(fromKey), { force: true });
  else if (stage === 'same-file') await rename(imageBlobPath(fromKey), imageBlobPath(toKey));
}

/** Undo a staged rename when the DB write failed: the old key stays the only name. */
export async function abandonImageBlobRename(toKey: string, stage: BlobRenameStage): Promise<void> {
  if (stage === 'linked') await rm(imageBlobPath(toKey), { force: true });
}
