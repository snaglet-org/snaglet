/**
 * FolderScanner — a generic, reusable "drop-in folder" registrar.
 *
 * Watches a root directory (e.g. `~/.snaglet/tools/` or `~/.snaglet/hooks/`) whose direct
 * children are self-contained item folders. On boot and on change it reconciles
 * the filesystem against a set of registration callbacks:
 *
 *   - a NEW or CHANGED folder (whose required files are all present) → `onUpsert`
 *   - a folder that DISAPPEARED since the last scan                  → `onRemove`
 *
 * "Changed" is detected by a cheap fingerprint (size + mtime of the required
 * files), so editing a folder's source re-registers it but a rebuild that only
 * touches `dist/`/`node_modules/` does not (its source fingerprint is stable) —
 * this is what keeps the fs.watch loop from feeding on its own build output.
 *
 * The scanner is deliberately kind-agnostic: it knows nothing about tools or
 * hooks. CustomToolScanner wires it for `~/.snaglet/tools/`; HookRegistryService builds a
 * second instance for `~/.snaglet/hooks/` with different `requiredFiles` + callbacks.
 *
 * Robustness contract: a single malformed folder or a throwing callback is
 * logged and skipped — it never rejects `scan()` or crashes the watcher.
 */

import { watch, type FSWatcher } from 'fs';
import { mkdir, readdir, stat } from 'fs/promises';
import path from 'path';
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';

export interface ScannedFolder {
  /** Directory name (the folder's own basename). */
  name: string;
  /** Absolute path to the folder. */
  path: string;
  /** Source fingerprint (size+mtime of the required files). */
  fingerprint: string;
}

export interface FolderScannerOptions {
  /** Root directory whose direct child folders are the scannable items. */
  dir: string;
  /** Short label used in log lines, e.g. `custom-tools`. */
  kind: string;
  /**
   * Files that must all exist in a folder for it to be considered well-formed.
   * A folder missing any of them is skipped (treated as not-yet-ready), and if
   * it was registered before it is removed.
   */
  requiredFiles: string[];
  /** Register (insert/update) a new or changed folder. Must not throw fatally. */
  onUpsert: (folder: ScannedFolder) => Promise<void>;
  /** Deregister (disable) a folder that no longer exists on disk. */
  onRemove: (folderName: string) => Promise<void>;
  /** Debounce window for coalescing filesystem events (default 400ms). */
  debounceMs?: number;
}

/** Commit the source state captured by an owned mutation after its side effects succeed. */
export type CommitFolderFingerprint = () => void;

export class FolderScanner {
  private readonly opts: Required<Pick<FolderScannerOptions, 'debounceMs'>> & FolderScannerOptions;
  private readonly logPrefix: string;
  /** Last-seen source fingerprint per folder name. */
  private readonly fingerprints = new Map<string, string>();
  private watcher: FSWatcher | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  /** Serialize scans so a burst of events can't launch overlapping builds. */
  private scanning = false;
  private rescanQueued = false;
  private stopped = false;
  /** Scanner callbacks and request-owned mutations serialize per direct child. */
  private readonly folderLocks = new Map<string, Promise<void>>();
  /** Removals whose callback has not yet completed successfully. */
  private readonly pendingRemovals = new Set<string>();

  constructor(options: FolderScannerOptions) {
    this.opts = { debounceMs: 400, ...options };
    this.logPrefix = `\x1b[36m[folder-scan:${options.kind}]\x1b[0m`;
  }

  /**
   * Compute a source fingerprint for a folder, or `null` if it is not
   * well-formed (a required file is missing/unreadable).
   */
  private async fingerprintOf(folderPath: string): Promise<string | null> {
    const parts: string[] = [];
    for (const file of this.opts.requiredFiles) {
      try {
        const s = await stat(path.join(folderPath, file));
        if (!s.isFile()) return null;
        parts.push(`${file}:${s.size}:${s.mtimeMs}`);
      } catch {
        return null; // required file missing → not ready
      }
    }
    return parts.join('|');
  }

  private assertDirectChildName(folderName: string): void {
    if (
      folderName.length === 0 ||
      folderName.startsWith('.') ||
      folderName === '..' ||
      path.basename(folderName) !== folderName ||
      folderName.includes('/') ||
      folderName.includes('\\')
    ) {
      throw new Error(`Invalid direct-child folder name: "${folderName}"`);
    }
  }

  private async withFolderLock<T>(folderName: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.folderLocks.get(folderName) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.folderLocks.set(folderName, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.folderLocks.get(folderName) === tail) this.folderLocks.delete(folderName);
    }
  }

  /**
   * Serialize a request-owned source mutation with this folder's scanner work.
   *
   * Call `checkpointSource()` immediately after the request has written the
   * authored files. It returns a commit callback; invoke that callback only
   * after the request's DB/build side effects succeed. A later external edit
   * changes the fingerprint and is deliberately reconciled after the lock is
   * released instead of being swallowed as part of the request.
   */
  async withOwnedUpsert<T>(
    folderName: string,
    mutation: (checkpointSource: () => Promise<CommitFolderFingerprint>) => Promise<T>
  ): Promise<T> {
    this.assertDirectChildName(folderName);
    let shouldRescan = false;

    try {
      return await this.withFolderLock(folderName, async () => {
        let committedFingerprint: string | undefined;
        const value = await mutation(async () => {
          const fingerprint = await this.fingerprintOf(path.join(this.opts.dir, folderName));
          if (fingerprint === null) {
            // A request may legitimately update metadata while another
            // required file is absent. Let its direct side effects finish,
            // but do not acknowledge an unscannable source state.
            return () => {
              shouldRescan = true;
            };
          }
          return () => {
            committedFingerprint = fingerprint;
          };
        });

        if (committedFingerprint === undefined) {
          shouldRescan = true;
          return value;
        }

        const currentFingerprint = await this.fingerprintOf(path.join(this.opts.dir, folderName));
        if (currentFingerprint === committedFingerprint) {
          this.fingerprints.set(folderName, committedFingerprint);
        } else {
          shouldRescan = true;
        }
        return value;
      });
    } catch (err) {
      shouldRescan = true;
      throw err;
    } finally {
      if (shouldRescan && !this.stopped) void this.scan();
    }
  }

  /** Serialize a request-owned removal through the scanner's removal callback. */
  async withOwnedRemove<T>(folderName: string, mutation: () => Promise<T>): Promise<T> {
    this.assertDirectChildName(folderName);
    try {
      return await this.withFolderLock(folderName, async () => {
        const value = await mutation();
        this.pendingRemovals.add(folderName);
        if (await this.safeRemove(folderName)) {
          this.pendingRemovals.delete(folderName);
          this.fingerprints.delete(folderName);
        }
        return value;
      });
    } finally {
      if (!this.stopped) void this.scan();
    }
  }

  /**
   * Full reconcile: register new/changed folders, remove vanished ones. Never
   * rejects — per-folder failures are logged and skipped.
   */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.rescanQueued = true;
      return;
    }
    this.scanning = true;
    try {
      await this.reconcile();
    } finally {
      this.scanning = false;
      if (this.rescanQueued && !this.stopped) {
        this.rescanQueued = false;
        void this.scan();
      }
    }
  }

  private async reconcile(): Promise<void> {
    let entries: string[];
    try {
      await mkdir(this.opts.dir, { recursive: true });
      const dirents = await readdir(this.opts.dir, { withFileTypes: true });
      entries = dirents
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch (err) {
      logger.warn(`${this.logPrefix} could not read ${this.opts.dir}: ${getErrorMessage(err)}`);
      return;
    }

    const seen = new Set<string>();
    for (const name of entries) {
      seen.add(name);
      const folderPath = path.join(this.opts.dir, name);
      await this.withFolderLock(name, async () => {
        // Re-read after acquiring the folder lock: a request may have changed
        // the source since the directory snapshot above.
        const fingerprint = await this.fingerprintOf(folderPath);
        if (fingerprint === null) {
          // Not well-formed (missing a required file). If it is currently
          // registered, tear it down; otherwise just skip quietly.
          if (
            (this.fingerprints.has(name) || this.pendingRemovals.has(name)) &&
            (await this.safeRemove(name))
          ) {
            this.fingerprints.delete(name);
            this.pendingRemovals.delete(name);
          }
          return;
        }
        this.pendingRemovals.delete(name);
        if (this.fingerprints.get(name) === fingerprint) return; // unchanged
        const ok = await this.safeUpsert({ name, path: folderPath, fingerprint });
        // Only remember the fingerprint once a registration attempt completed
        // without throwing, so a transient failure is retried on the next scan.
        if (ok) this.fingerprints.set(name, fingerprint);
      });
    }

    // Folders that were present before but are gone now → remove.
    const removalCandidates = new Set([...this.fingerprints.keys(), ...this.pendingRemovals]);
    for (const name of removalCandidates) {
      if (!seen.has(name)) {
        await this.withFolderLock(name, async () => {
          // The folder may have been created by an owned mutation after the
          // directory snapshot. Do not remove a newly acknowledged source.
          const current = await this.fingerprintOf(path.join(this.opts.dir, name));
          if (current !== null) {
            this.pendingRemovals.delete(name);
            if (this.fingerprints.get(name) !== current) {
              const ok = await this.safeUpsert({
                name,
                path: path.join(this.opts.dir, name),
                fingerprint: current,
              });
              if (ok) this.fingerprints.set(name, current);
            }
            return;
          }
          if (await this.safeRemove(name)) {
            this.fingerprints.delete(name);
            this.pendingRemovals.delete(name);
          }
        });
      }
    }
  }

  private async safeUpsert(folder: ScannedFolder): Promise<boolean> {
    try {
      await this.opts.onUpsert(folder);
      return true;
    } catch (err) {
      logger.error(
        `${this.logPrefix} register failed for "${folder.name}": ${getErrorMessage(err)}`
      );
      return false;
    }
  }

  private async safeRemove(name: string): Promise<boolean> {
    try {
      await this.opts.onRemove(name);
      return true;
    } catch (err) {
      logger.error(`${this.logPrefix} remove failed for "${name}": ${getErrorMessage(err)}`);
      return false;
    }
  }

  /** Boot-time scan followed by a debounced fs.watch. Idempotent. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.scan();
    if (this.watcher) return;
    try {
      // Recursive so edits to files *inside* a folder are noticed; falls back to
      // a shallow watch (folder add/remove only) on platforms without recursive
      // support. Either way the debounced handler runs a full reconcile.
      this.watcher = watch(this.opts.dir, { recursive: true, persistent: false }, () =>
        this.onFsEvent()
      );
    } catch {
      try {
        this.watcher = watch(this.opts.dir, { persistent: false }, () => this.onFsEvent());
      } catch (err) {
        logger.warn(`${this.logPrefix} could not watch ${this.opts.dir}: ${getErrorMessage(err)}`);
        return;
      }
    }
    this.watcher.on('error', (err) =>
      logger.warn(`${this.logPrefix} watcher error: ${getErrorMessage(err)}`)
    );
    logger.info(`${this.logPrefix} watching ${this.opts.dir}`);
  }

  private onFsEvent(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.scan();
    }, this.opts.debounceMs);
  }

  /** Stop watching and cancel any pending debounced scan. */
  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }
}
