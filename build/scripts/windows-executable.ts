import { createHash } from 'node:crypto';

const PORTABLE_MARKER = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const NSIS_MARKER = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');

/** Tauri patches this marker for NSIS, then restores the portable executable. */
export function nsisExecutableSha256(portable: Buffer): string {
  const offset = portable.indexOf(PORTABLE_MARKER);
  if (offset < 0 || portable.indexOf(PORTABLE_MARKER, offset + PORTABLE_MARKER.length) >= 0) {
    throw new Error('Expected exactly one Tauri portable bundle marker');
  }
  return createHash('sha256')
    .update(portable.subarray(0, offset))
    .update(NSIS_MARKER)
    .update(portable.subarray(offset + PORTABLE_MARKER.length))
    .digest('hex');
}
