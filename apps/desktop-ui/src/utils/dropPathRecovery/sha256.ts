// Hash a dropped `File`'s bytes so the Tauri shell can match it against a
// candidate found on disk (see `resolveDroppedFilePath.ts` for why: the
// browser's File API never carries a real filesystem path, by design).
// Web Crypto's `subtle.digest` is built into every browser and Node 19+ —
// no new dependency needed for this.

/** Lowercase hex-encoded sha256 of `file`'s full content. */
export async function computeSha256Hex(file: File | Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
