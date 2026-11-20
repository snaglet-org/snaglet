import { useCallback, useRef, useState } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { isTauriEnv } from '@desktop/utils/tauriEnv';
import { socketClient } from '@desktop/socket';
import {
  exportApi,
  type ContainerExportReport,
  type DownloadableExportKind,
  type ExportRequest,
} from '@desktop/utils/api';

export type ExportState =
  | { status: 'idle' }
  | { status: 'working' }
  /** Written to disk (Tauri). `path` is where it actually landed. */
  | { status: 'written'; path: string; fileName: string; renamed: boolean }
  /** Recursive container export written into a newly-created directory. */
  | {
      status: 'container-written';
      path: string;
      directoryName: string;
      manifestPath?: string;
      report: ContainerExportReport;
    }
  /** Handed to the browser's downloader. */
  | { status: 'downloaded'; fileName: string }
  /** The user closed the save dialog. Not an error, and not a result. */
  | { status: 'canceled' }
  | { status: 'error'; message: string };

/**
 * What `pick_save_file` returns. `overwriteGrant` is absent whenever the
 * shell has no key to sign with — a dev run without the packaged sidecar —
 * and its absence correctly means "no overwrite authority", not "assume yes".
 */
interface SaveFileSelection {
  path: string;
  overwriteGrant?: string;
}

export type ExportInput =
  | {
      kind: DownloadableExportKind;
      id: string;
      /** Pre-fills the save dialog. Extension is set by the server regardless. */
      suggestedName: string;
      messageLimit?: number;
    }
  | { kind: 'container'; id: string; suggestedName?: string; messageLimit?: never };

/**
 * Export a node. In Tauri the native save dialog's path is split: the
 * directory goes to the server (which realpath-guards it and requires it to
 * exist) and the filename separately (sanitized there), because a file that
 * doesn't exist yet has no realpath to check. The dialog's own "replace?"
 * prompt is the only source of an overwrite, which the server honors only for
 * a human actor. In the browser the server writes nothing and returns bytes.
 */
export function useNodeExport(): {
  state: ExportState;
  exportNode: (input: ExportInput) => Promise<void>;
  reset: () => void;
} {
  const [state, setState] = useState<ExportState>({ status: 'idle' });
  // Guards against a double-click starting a second dialog while the first is
  // open, which on macOS produces two stacked native sheets.
  const inFlight = useRef(false);

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  const exportNode = useCallback(async (input: ExportInput) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ status: 'working' });

    try {
      if (input.kind === 'container') {
        const destination = await socketClient.pickFolder('Choose the export folder');
        if (!destination) {
          setState({ status: 'canceled' });
          return;
        }
        const result = await exportApi.write({
          kind: 'container',
          id: input.id,
          destDir: destination,
        });
        if (!result.report) {
          throw new Error('Container export succeeded but returned no completion report.');
        }
        setState({
          status: 'container-written',
          path: result.path,
          directoryName: result.fileName,
          manifestPath: result.manifestPath,
          report: result.report,
        });
        return;
      }

      const suggestedName = input.suggestedName;
      const options: ExportRequest['options'] = input.messageLimit
        ? { messageLimit: input.messageLimit }
        : undefined;

      if (!isTauriEnv()) {
        const { blob, fileName } = await exportApi.download({
          kind: input.kind,
          id: input.id,
          fileName: suggestedName,
          options,
        });
        triggerBrowserDownload(blob, fileName);
        setState({ status: 'downloaded', fileName });
        return;
      }

      // Imported lazily, matching socket/index.ts: a static import would pull
      // the Tauri module into the plain browser bundle, where it throws.
      const { invoke } = await import('@tauri-apps/api/core');
      const picked = await invoke<SaveFileSelection | null>('pick_save_file', {
        defaultName: suggestedName,
        title: 'Export',
      });
      if (!picked?.path) {
        // Dismissing the dialog is a decision, not a failure. Reporting it as
        // an error would put a red message on screen for a normal action.
        setState({ status: 'canceled' });
        return;
      }

      const { dir, name } = splitPath(picked.path);
      const result = await exportApi.write({
        kind: input.kind,
        id: input.id,
        destDir: dir,
        fileName: name,
        // Forwarded verbatim, never synthesized. The grant is minted by the
        // Rust shell after the dialog ran and is bound to this exact path; the
        // UI cannot manufacture one, which is the point. Absent (dev builds
        // with no packaged sidecar) simply means no-clobber.
        options: { ...options, overwriteGrant: picked.overwriteGrant },
      });

      setState({
        status: 'written',
        path: result.path,
        fileName: result.fileName,
        // Surfaced so the UI can say the name changed rather than pointing at
        // a file that is not there.
        renamed: result.fileName !== name,
      });
    } catch (err) {
      setState({ status: 'error', message: getErrorMessage(err, 'Export failed') });
    } finally {
      inFlight.current = false;
    }
  }, []);

  return { state, exportNode, reset };
}

/**
 * Split a picked file path into its directory and final segment.
 *
 * Handles both separators: the dialog returns native paths, and this code also
 * runs in tests on either platform.
 */
export function splitPath(fullPath: string): { dir: string; name: string } {
  const index = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
  if (index < 0) return { dir: '', name: fullPath };
  return { dir: fullPath.slice(0, index) || '/', name: fullPath.slice(index + 1) };
}

function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers; one tick
  // is enough for the click to have been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
