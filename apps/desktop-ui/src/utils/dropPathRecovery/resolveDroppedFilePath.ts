// resolveDroppedFilePath — recover a dropped file's absolute path via the
// Tauri shell's Spotlight-backed `resolve_dropped_file_path` command.
//
// The native OS drag-drop handler is disabled (`.disable_drag_drop_handler()`
// in `apps/desktop/src-tauri/src/main.rs`) because it conflicts with in-app
// chip and pane drags on macOS, and the File API never exposes a path. So a
// Finder drop gives only a `File` (name, size, bytes). This hashes the bytes
// and asks the Rust shell to find the matching file on disk (`mdfind` + size
// + content hash, see `drop_path_recovery.rs`). Without Tauri it always
// resolves to `not_found`.
import { isTauriEnv } from '../tauriEnv';
import { computeSha256Hex } from './sha256';

type DropPathResolution =
  | { status: 'unique'; path: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not_found' };

/**
 * Resolve `file`'s absolute path, or `{status: 'not_found'}` if it can't be
 * (no Tauri shell to ask, `mdfind` came up empty, or the invoke itself
 * failed for any reason — this never throws).
 *
 * Folders: a dropped directory arrives as a `File` whose bytes can't be read
 * (`arrayBuffer()` rejects), so it is never hashed. Pass `isDirectory` when
 * the drop event said so (`webkitGetAsEntry().isDirectory`); if it wasn't
 * known and hashing rejects, the drop is treated as a directory too.
 */
export async function resolveDroppedFilePath(
  file: File,
  options: { isDirectory?: boolean } = {}
): Promise<DropPathResolution> {
  // Mirrors the `__TAURI_INTERNALS__`/`__TAURI__` check in
  // nativeFileDropRegistry.ts: skip hashing + the dynamic import entirely
  // when we already know there's no Tauri shell to invoke (plain browser).
  if (!isTauriEnv()) return { status: 'not_found' };
  try {
    let isDirectory = options.isDirectory === true;
    let contentHash = '';
    if (!isDirectory) {
      try {
        contentHash = await computeSha256Hex(file);
      } catch {
        isDirectory = true;
      }
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<DropPathResolution>('resolve_dropped_file_path', {
      name: file.name,
      size: file.size,
      contentHash,
      isDirectory,
    });
  } catch {
    // Not actually running under Tauri (isTauriEnv false positive), the
    // command isn't registered, or the invoke failed for some other
    // reason — treat it the same as "couldn't find it", never crash the
    // drop.
    return { status: 'not_found' };
  }
}
