/**
 * moveToSystemTrash — macOS Finder-backed "move to Trash".
 *
 * Deleting through Finder (rather than `rm` or a manual move into
 * `~/.Trash`) is what makes the OS Trash entry first-class: Finder records
 * the original location, so the user can right-click → "Put Back" and the
 * folder returns exactly where it came from — for a hook, back under
 * `<SNAGLET_HOME>/hooks/<name>`, where the registry's FolderScanner re-registers
 * it on its next pass. No npm dependency; `osascript` ships with macOS.
 *
 * Callers own the platform decision (and tests inject a fake instead —
 * this module must never run under jest, see finalizeDeleteToTrash).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Quote a path as an AppleScript string literal (escapes `\` and `"`). */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** How a set of hook artifacts left the machine's visible filesystem. */
type HookTrashDisposition = 'system-trash' | 'snaglet-trash' | 'none';

export interface HookTrashOutcome {
  disposition: HookTrashDisposition;
  /**
   * `<SNAGLET_HOME>/trash/<timestamp>-<hookName>` when any artifact had to fall
   * back to the Snaglet-local trash folder (non-macOS, or Finder unavailable);
   * null when everything went to the system Trash or nothing needed moving.
   */
  fallbackDir: string | null;
}

/** Signature tests inject in place of the real Finder call. */
export type SystemTrashFn = (targetPath: string) => Promise<void>;

export async function moveToSystemTrash(targetPath: string): Promise<void> {
  const script = `tell application "Finder" to delete (POSIX file ${appleScriptString(targetPath)})`;
  await execFileAsync('osascript', ['-e', script], { timeout: 10_000 });
}
