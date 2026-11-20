import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { docsApi, imagesApi, type LibraryTreeChild } from '../../../utils/api';
import { showToast } from '@desktop/utils/toast';
import {
  DOC_IMPORT_EXTENSIONS,
  MAX_DOC_IMPORT_BYTES,
  imageSizeProblem,
  readFileAsDataUrl,
} from '@snaglet/shared/utils';
import { fileExtension, resolveDropTarget } from '../treeHelpers';
import type { DropZone } from '../types';

/**
 * Upload dropped files into `containerId` (null = workspace root).
 * Images land in the images table; doc-like files (md/txt/json/pdf/…,
 * see the shared DOC_IMPORT_EXTENSIONS list) are converted into regular
 * docs server-side; anything else is skipped with a toast.
 *
 * With a `baseSortOrder` (drop-between-rows), placed file i lands at
 * slot base + i — sequential awaits, not Promise.all, because each
 * positional insert runs a sibling-bump on the server and concurrent
 * bumps against the same parent race each other (same rationale as
 * performBulkMove).
 */
async function uploadDroppedFiles(
  files: FileList | File[],
  containerId: string | null,
  baseSortOrder?: number
): Promise<void> {
  let placed = 0;
  for (const file of Array.from(files)) {
    const isImage = file.type.startsWith('image/');
    const isDoc = !isImage && DOC_IMPORT_EXTENSIONS.has(fileExtension(file.name));
    if (!isImage && !isDoc) {
      showToast(`Skipped unsupported file: ${file.name || '(unnamed)'}`);
      continue;
    }
    const sizeProblem = isImage
      ? imageSizeProblem(file.size, file.name)
      : file.size > MAX_DOC_IMPORT_BYTES
        ? `Skipped ${file.name}: over the ${Math.round(MAX_DOC_IMPORT_BYTES / (1024 * 1024))} MB limit`
        : null;
    if (sizeProblem) {
      showToast(sizeProblem);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const sortOrder = baseSortOrder !== undefined ? baseSortOrder + placed : undefined;
      if (isImage) {
        await imagesApi.upload({ name: file.name || undefined, dataUrl, containerId, sortOrder });
      } else {
        await docsApi.importFile({ name: file.name, dataUrl, containerId, sortOrder });
      }
      placed += 1;
    } catch (err) {
      showToast(`${isImage ? 'Image upload' : 'Doc import'} failed: ${file.name}`);
      // Keep iterating — partial-batch uploads are better than aborting the
      // entire drop on one bad file.
      console.error('file drop failed', err);
    }
  }
}

export interface UseTreeFileImportArgs {
  /** Clears the node-drag hover affordance when a file drop lands. */
  setHoverTargetId: Dispatch<SetStateAction<string | null>>;
  setHoverZone: Dispatch<SetStateAction<DropZone | null>>;
}

/**
 * OS file-drop import for the workspace tree. Owns the root-whitespace
 * glow state (`rootFileDragOver`, lit while a file drag hovers non-row
 * space so "this lands at root" has an explicit affordance), swallows the
 * browser's default open-file navigation page-wide while the tree is
 * mounted, and translates a drop (target row + zone + FileList) into
 * image uploads / doc imports sharing the node-drag placement grammar —
 * `inside` a container appends, `above`/`below` inserts at that sibling
 * slot, null target appends at workspace root.
 */
export function useTreeFileImport({ setHoverTargetId, setHoverZone }: UseTreeFileImportArgs) {
  // OS file drag hovering the tree's whitespace (= root drop). Rows
  // stopPropagation their own file dragovers, so the wrapper only sees
  // this while the cursor is over non-row space; the highlight is also
  // gated on `hoverTargetId === null` at render so a row affordance and
  // the whole-box glow never show together.
  const [rootFileDragOver, setRootFileDragOver] = useState(false);

  // Browser-only: when the user drags a file from the OS into the page,
  // the default action is "open the file" (which navigates the tab to a
  // file:// URL and loses the app). We swallow that default page-wide
  // while the tree is mounted so file drops only do something if a
  // container row actually accepts them. Tauri doesn't need this — its
  // webview already routes file drops through the OS-level handler the
  // app installs — but installing twice is harmless and the same code
  // runs in both shells, so we keep the implementation unconditional.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
      }
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  /**
   * OS file drop → image upload / doc import, sharing the node-drag
   * placement grammar: `inside` a container appends to it, `above`/
   * `below` any positioned row inserts at that slot among its siblings,
   * and a null target appends at workspace root. No tree refetch here —
   * the server emits a tree-node-created event per upload and the
   * workspace event bridge refreshes on its own.
   */
  const handleFileDrop = (target: LibraryTreeChild | null, zone: DropZone, files: FileList) => {
    setHoverTargetId(null);
    setHoverZone(null);
    setRootFileDragOver(false);
    const resolved = resolveDropTarget(target, zone);
    if (!resolved) return;
    void uploadDroppedFiles(files, resolved.parentId, resolved.sortOrder);
  };

  return { rootFileDragOver, setRootFileDragOver, handleFileDrop };
}
