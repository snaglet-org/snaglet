/**
 * File-indexing auto-skip set — the canonical list of binary / non-text file
 * extensions that can never be usefully indexed or embedded and are therefore
 * always skipped, regardless of a project's user config.
 *
 * Single source of truth shared by:
 *   - the server denylist (apps/server/.../fileIndexing/exclusions.ts) which
 *     enforces the skip in `shouldExcludePath` before any per-project rule runs;
 *   - the settings UI (IndexingRulesPanel) which uses it to keep these extensions
 *     out of the user-editable "Ignore file types" chip list and to explain that
 *     non-text files are auto-skipped.
 *
 * Entries are lowercase with NO leading dot (the form users write in
 * `ignoreFileTypes` and the form the settings API returns). Consumers that need
 * a dotted `path.extname` comparison add the dot themselves. User rules for
 * genuinely text-ish custom extensions (e.g. `csv`) stay separate and additive —
 * they are not part of this set.
 */

/** Canonical binary / non-text extensions, grouped by category (lowercase, no dot). */
export const AUTO_SKIP_FILE_EXTENSIONS: readonly string[] = [
  // images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
  'bmp',
  'tiff',
  // media
  'mp3',
  'mp4',
  'mov',
  'avi',
  'wav',
  'flac',
  'webm',
  'mkv',
  // archives
  'zip',
  'tar',
  'gz',
  'tgz',
  'rar',
  '7z',
  'bz2',
  'xz',
  // binaries / compiled
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'o',
  'a',
  'class',
  'wasm',
  // fonts
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  // bundled documents (Office). PDF is deliberately not here — it is binary on
  // disk but text-extractable, so it belongs to EXTRACTABLE_FILE_EXTENSIONS
  // below and flows through indexing via server-side text extraction.
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  // logs / local data stores
  'log',
  'sqlite',
  'db',
];

/** O(1) membership set of {@link AUTO_SKIP_FILE_EXTENSIONS}. */
export const AUTO_SKIP_FILE_EXTENSION_SET: ReadonlySet<string> = new Set(AUTO_SKIP_FILE_EXTENSIONS);

/**
 * True if `ext` names a binary / non-text type that is always auto-skipped.
 * Tolerant of the forms callers hold it in: leading dot optional, any case
 * (e.g. `png`, `.PNG`, `.png` all match).
 */
export function isAutoSkippedFileExtension(ext: string): boolean {
  return AUTO_SKIP_FILE_EXTENSION_SET.has(ext.trim().toLowerCase().replace(/^\./, ''));
}

/**
 * Extractable documents: binary on disk, but indexable because the server
 * derives a text layer at read time (currently PDF via unpdf). Discovery
 * accepts these; the indexing read step extracts text instead of decoding raw
 * bytes. Not part of the auto-skip set, so a user's `ignoreFileTypes: ["pdf"]`
 * remains a meaningful, additive opt-out (lowercase, no leading dot — same
 * form as AUTO_SKIP_FILE_EXTENSIONS).
 */
export const EXTRACTABLE_FILE_EXTENSIONS: readonly string[] = ['pdf'];

/** O(1) membership set of {@link EXTRACTABLE_FILE_EXTENSIONS}. */
export const EXTRACTABLE_FILE_EXTENSION_SET: ReadonlySet<string> = new Set(
  EXTRACTABLE_FILE_EXTENSIONS
);

/**
 * True if `ext` names an extractable document type (see
 * {@link EXTRACTABLE_FILE_EXTENSIONS}). Leading dot optional, any case.
 */
export function isExtractableFileExtension(ext: string): boolean {
  return EXTRACTABLE_FILE_EXTENSION_SET.has(ext.trim().toLowerCase().replace(/^\./, ''));
}
