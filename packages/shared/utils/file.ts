/**
 * Shared file utilities
 */

/**
 * Size messages count megabytes of 1024 × 1024 bytes, the unit the image
 * limit is set in, so a size and the limit it is compared with always agree.
 */
const MEGABYTE = 1024 * 1024;

/**
 * Largest image file Snaglet takes, from any entry point: chat composer, workspace
 * tree drop, the upload route and agents reading image files from disk.
 */
export const MAX_IMAGE_BYTES = 50 * MEGABYTE;

/**
 * `bytes` as megabytes for a size message, rounded up to one decimal so a
 * file over a limit always reads as larger than it.
 */
function megabytesLabel(bytes: number): string {
  return `${Math.ceil((bytes * 10) / MEGABYTE) / 10} MB`;
}

/** The image limit as size messages show it: "50 MB". */
export const MAX_IMAGE_SIZE_LABEL = megabytesLabel(MAX_IMAGE_BYTES);

/**
 * Why an image of `sizeBytes` is refused, or null when it fits the limit.
 * Pass `name` to say which file when several are handled at once.
 */
export function imageSizeProblem(sizeBytes: number, name?: string): string | null {
  if (sizeBytes <= MAX_IMAGE_BYTES) return null;
  const subject = name ? `"${name}"` : 'This image';
  return `${subject} is ${megabytesLabel(sizeBytes)}. Images can be up to ${MAX_IMAGE_SIZE_LABEL}.`;
}

/**
 * Max file size for drop-to-doc imports (md/txt/json/pdf/…). Base64
 * inflates 4/3 on the wire, so this must stay under ~3/4 of the
 * server's express.json body limit (8 MB).
 */
export const MAX_DOC_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * File extensions the doc-import pipeline accepts (drop a file onto the
 * workspace tree → regular doc). Canonical list shared by the client
 * drop filter and the server converter (apps/server docImport.ts) so
 * the two can't drift: anything here that the server has no special
 * handling for is imported as plain text.
 */
export const DOC_IMPORT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.text',
  '.log',
  '.json',
  '.jsonl',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.pdf',
]);

/** Longest display name a Snaglet image may have, in characters. */
export const IMAGE_NAME_MAX_LENGTH = 120;

/**
 * Why a Snaglet image name is refused, or null when it can be saved. Checks the
 * trimmed value; the stored name is the trimmed one.
 */
export function imageNameProblem(value: string): string | null {
  const name = value.trim();
  if (!name) return 'Enter a name for the image.';
  if (name.length > IMAGE_NAME_MAX_LENGTH) {
    return `Image names can be at most ${IMAGE_NAME_MAX_LENGTH} characters.`;
  }
  return null;
}

/** Image file extensions, lowercase with no dot. */
const IMAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'tif',
  'tiff',
  'ico',
  'heic',
  'heif',
  'avif',
]);

/** True when a file name ends in an image extension (any case). */
export function isImageFileName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && IMAGE_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Whether a file in a linked project folder can be renamed from Snaglet. The server
 * route and every rename affordance in the UI share this gate, so returning
 * true here turns rename on for all files.
 */
export function isRenamableProjectFile(name: string): boolean {
  return isImageFileName(name);
}

/** Read a File as a data-URL string. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
