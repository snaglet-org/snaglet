import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import type { DocTreeNode } from '@desktop/utils/api';
import type { DocAnchor } from '@snaglet/shared/utils';
import {
  consumeDocLineFocus,
  useDocLineFocusRequest,
} from '@desktop/features/rich-markdown/lineLinks/lineFocusStore';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor';
import { SnapshotFind } from '@desktop/features/pane-find/SnapshotFind';
import {
  WorkspaceEditor,
  type WorkspaceEditorAutosaveState,
  type WorkspaceEditorHandle,
} from '@desktop/features/rich-markdown/workspace-editor';
import { MarkdownTextToggle } from '@desktop/components/MarkdownTextToggle/MarkdownTextToggle';
import { Button } from '@desktop/components';
import { ConfirmModal } from '@desktop/components/Modal';
import { docsApi } from '@desktop/utils/api';
import type { DocSnapshotMeta, DocSnapshotRecord } from '@desktop/utils/api/docs';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { useSaveLoopNotice } from '@desktop/features/rich-markdown/renderer/transclusions';
import {
  createDocOutlineStore,
  type OutlineEntry,
} from '@desktop/features/rich-markdown/outline/docOutline';
import { ExportButton } from '@desktop/components/ExportButton';
import { DocOutline } from './DocOutline';
import { DocProperties } from './DocProperties';
import { DocVersions } from './DocVersions';
import { snapshotLabel } from './snapshotLabel';
import { PropertiesPanel } from '../shared/PropertiesPanel';
import styles from '../DetailRouter.module.scss';
import docStyles from './DocView.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';

const SOURCE_MODE_KEY = 'snaglet:workspace-editor:source-mode';

function readSourceMode(): boolean {
  try {
    return sessionStorage.getItem(SOURCE_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistSourceMode(sourceMode: boolean): void {
  try {
    sessionStorage.setItem(SOURCE_MODE_KEY, sourceMode ? '1' : '0');
  } catch {
    // Session persistence is best-effort; React state remains authoritative.
  }
}

/**
 * The editor body for a doc: a `WorkspaceEditor` (rich markdown with inline
 * chips, or raw source per the topbar's md/txt toggle) that autosaves after a
 * pause and on Cmd/Ctrl+S. The Properties panel shows the save state, the
 * Outline (DocOutline: the doc's headings, which jump there) and the version
 * controls (DocVersions): Snapshot saves the body as a version, and Versions
 * lists them for a read-only preview with Restore and Delete.
 */
export const DocView: FC<{
  node: DocTreeNode;
  /** Scroll to and highlight this part once loaded (partial-doc link). */
  focusAnchor?: DocAnchor;
}> = ({ node, focusAnchor }) => {
  // WorkspaceEditor owns the draft + autosave state. Ref lets the
  // snapshot-preview entrypoint flush any unsaved edits before swapping
  // the live editor out for the read-only preview, so the user's draft
  // survives the round-trip through Versions → Back to current.
  const editorRef = useRef<WorkspaceEditorHandle | null>(null);

  const loopNotice = useSaveLoopNotice();
  const handleSaveContent = useCallback(
    async (content: string): Promise<string | void> => {
      // A body that would transclude this doc into itself (pasted, or typed
      // in source mode) is refused by the server; say why, then let the
      // editor show the save as failed.
      const updated = await docsApi.update(node.id, { content }).catch((err: unknown) => {
        loopNotice.refused(err);
        throw err;
      });
      loopNotice.saved();
      // Broadcast so the LibraryTree's cached `node.content` stays in
      // sync. Without this, navigating away and back would remount
      // the editor with stale `initialContent` from the tree snapshot.
      emitLibraryEvent({
        type: 'doc-saved',
        id: node.id,
        content: updated.content ?? content,
        updatedAt: updated.updatedAt,
        ...(updated.lastEditedBy ? { lastEditedBy: updated.lastEditedBy } : {}),
      });
      return updated.content ?? content;
    },
    [loopNotice, node.id]
  );

  // DocView owns source mode because its control lives in the pane topbar.
  // WorkspaceEditor consumes this value directly; there is no mirrored
  // imperative state that can drift from the visible toggle.
  const [sourceMode, setSourceMode] = useState(readSourceMode);
  const handleSourceToggle = useCallback(() => {
    setSourceMode((current) => {
      const next = !current;
      persistSourceMode(next);
      return next;
    });
  }, []);

  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<DocSnapshotMeta[] | null>(null);
  // True total from the server (may exceed the 200-row list). `null` =
  // not resolved yet for this doc, in which case the Versions button
  // shows no number at all rather than a misleading 0.
  const [snapshotCount, setSnapshotCount] = useState<number | null>(null);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  // Which doc the UI currently shows. Every async completion (list, create,
  // restore, delete, clear) re-checks this before touching state, so a
  // response for a doc the user has navigated away from never lands on the
  // new one.
  const activeDocIdRef = useRef(node.id);
  // Monotonic sequence for list requests: only the latest issued request
  // may write the list/count. Bumped on every load, on doc change and on
  // clear-all, so a stale (even same-doc, reordered) response is ignored.
  const listRequestSeqRef = useRef(0);
  // Manual-snapshot state lives here (not next to onCreateSnapshot) because
  // clear-all must reset `snapshottedContent`: once the history is gone the
  // unchanged current body is snapshottable again.
  const [snapshotCreating, setSnapshotCreating] = useState(false);
  const [snapshottedContent, setSnapshottedContent] = useState<string | null>(null);
  const [snapshotCreateError, setSnapshotCreateError] = useState<string | null>(null);

  const [editorSaveStatus, setEditorSaveStatus] = useState<{
    state: WorkspaceEditorAutosaveState;
    error: string | null;
  }>({ state: 'pristine', error: null });
  const handleEditorSaveStateChange = useCallback(
    (state: WorkspaceEditorAutosaveState, error: string | null) => {
      setEditorSaveStatus({ state, error });
      // A real edit re-arms Snapshot at once, before its save brings a new
      // `node.content` back. Keys that change nothing (arrows, Tab, Cmd+S)
      // never reach 'dirty'.
      if (state === 'dirty') setSnapshottedContent(null);
    },
    []
  );

  // Snapshot preview mode: when non-null, the editor renders the snapshot's
  // content read-only with a banner + Restore/Cancel buttons. Selecting a
  // row in the Versions dropdown enters this mode; "Back to current" exits it.
  const [previewSnapshot, setPreviewSnapshot] = useState<DocSnapshotRecord | null>(null);
  const snapshotPreviewRef = useRef<HTMLDivElement | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadSnapshots = useCallback(async () => {
    const docId = node.id;
    const seq = (listRequestSeqRef.current += 1);
    setSnapshotsLoading(true);
    setSnapshotsError(null);
    try {
      const result = await docsApi.listSnapshots(docId);
      if (seq !== listRequestSeqRef.current) return;
      setSnapshots(result.snapshots);
      setSnapshotCount(result.count);
    } catch (err) {
      if (seq !== listRequestSeqRef.current) return;
      setSnapshotsError(getErrorMessage(err));
    } finally {
      if (seq === listRequestSeqRef.current) setSnapshotsLoading(false);
    }
  }, [node.id]);

  // Reset cached list + count when switching docs so we don't show stale
  // data, then fetch the new doc's history right away — the list route is
  // metadata-only, and it's what puts the version count on the Versions
  // button before the dropdown is ever opened. Also exit preview mode and
  // forget the snapshotted state — the previous doc's snapshot context has
  // no bearing on this one.
  useEffect(() => {
    activeDocIdRef.current = node.id;
    listRequestSeqRef.current += 1;
    setSnapshottedContent(null);
    setSnapshots(null);
    setSnapshotCount(null);
    setSnapshotsLoading(false);
    setSnapshotsOpen(false);
    setSnapshotsError(null);
    setPreviewSnapshot(null);
    setPreviewError(null);
    setConfirmingClearSnapshots(false);
    setClearingSnapshots(false);
    void loadSnapshots();
  }, [node.id, loadSnapshots]);

  // DocVersions lives in the Properties panel, which unmounts it when closed;
  // an open list goes with it and must not come back open with the panel.
  const versionsMountedRef = useRef(false);
  const onVersionsMountChange = useCallback((mounted: boolean) => {
    versionsMountedRef.current = mounted;
    if (!mounted) setSnapshotsOpen(false);
  }, []);

  /**
   * Enter snapshot preview mode: fetch the snapshot's full content and
   * display it read-only in the editor. Closes the dropdown so the user
   * sees the preview banner + content immediately.
   */
  const onSelectSnapshot = useCallback(
    async (snapshotId: string) => {
      const docId = node.id;
      setPreviewLoading(true);
      setPreviewError(null);
      setSnapshotsOpen(false);
      try {
        // Flush any pending autosave before swapping the live editor
        // out for the read-only preview — the WorkspaceEditor unmounts
        // when previewSnapshot becomes non-null, so an unflushed draft
        // would be lost on remount. The flush propagates the user's
        // current draft through `doc-saved`, updating `node.content`
        // so the post-preview remount comes back with their content.
        await editorRef.current?.flush();
        const snap = await docsApi.getSnapshot(docId, snapshotId);
        if (activeDocIdRef.current !== docId) return;
        setPreviewSnapshot(snap);
      } catch (err) {
        if (activeDocIdRef.current !== docId) return;
        setPreviewError(getErrorMessage(err));
        // Re-open the list so the user can pick a different version, unless
        // the Properties panel holding it closed while this was loading.
        if (versionsMountedRef.current) setSnapshotsOpen(true);
      } finally {
        setPreviewLoading(false);
      }
    },
    [node.id]
  );

  /** Exit preview mode and return to the live doc. */
  const onExitPreview = useCallback(() => {
    setPreviewSnapshot(null);
    setPreviewError(null);
  }, []);

  /**
   * Restore the previewed snapshot as the new doc body. Server takes a
   * safety "pre-restore" snapshot first, then overwrites. On success:
   * sync local draft + library tree, refresh the snapshot list (a new
   * "pre-restore" row should appear), and exit preview mode.
   */
  const onRestorePreview = useCallback(async () => {
    if (!previewSnapshot) return;
    const docId = node.id;
    setRestoring(true);
    try {
      const updated = await docsApi.restoreSnapshot(docId, previewSnapshot.id);
      const nextContent = updated.content ?? previewSnapshot.content;
      // Broadcast — the workspace tree's cached node.content updates,
      // and our parent re-feeds `node` with the fresh content. When
      // previewSnapshot resets below, WorkspaceEditor remounts with
      // savedValue = the restored content. The broadcast is keyed by
      // docId, so it is correct even if the user has since navigated.
      emitLibraryEvent({
        type: 'doc-saved',
        id: docId,
        content: nextContent,
        updatedAt: updated.updatedAt,
        ...(updated.lastEditedBy ? { lastEditedBy: updated.lastEditedBy } : {}),
      });
      if (activeDocIdRef.current !== docId) return;
      // Reload the snapshot list so the new pre-restore row is visible.
      void loadSnapshots();
      setPreviewSnapshot(null);
      setPreviewError(null);
    } catch (err) {
      if (activeDocIdRef.current !== docId) return;
      setPreviewError(getErrorMessage(err));
    } finally {
      setRestoring(false);
    }
  }, [previewSnapshot, node.id, loadSnapshots]);

  /**
   * Permanently delete the previewed snapshot, after an in-app ConfirmModal
   * (the Tauri webview suppresses window.confirm) that names the exact
   * version. On success, refresh the list and leave preview for the live
   * doc; on failure, stay in preview and show the error. Only that one
   * snapshot row is deleted.
   */
  const [confirmingSnapshotDelete, setConfirmingSnapshotDelete] = useState(false);
  const onDeletePreview = useCallback(() => {
    if (!previewSnapshot) return;
    setConfirmingSnapshotDelete(true);
  }, [previewSnapshot]);

  /** Runs only from the delete confirmation's confirm button. */
  const performDeletePreview = useCallback(async () => {
    if (!previewSnapshot) return;
    const docId = node.id;
    setDeleting(true);
    try {
      await docsApi.deleteSnapshot(docId, previewSnapshot.id);
      if (activeDocIdRef.current !== docId) return;
      // Drop the count immediately, then reload so the list and count
      // both come from the server rather than our arithmetic.
      setSnapshotCount((count) => (count === null ? null : Math.max(0, count - 1)));
      void loadSnapshots();
      setPreviewSnapshot(null);
      setPreviewError(null);
    } catch (err) {
      if (activeDocIdRef.current !== docId) return;
      setPreviewError(getErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  }, [previewSnapshot, node.id, loadSnapshots]);

  /**
   * Clear every version of this doc (only `doc_snapshots` rows; the live body
   * and the draft are untouched). The ConfirmModal's async confirm stays open
   * with "Clearing…" and shows a failure inline with retry. On success the
   * count goes to 0, the dropdown closes and any preview exits. The result is
   * keyed to the doc it was issued for, so navigating mid-request changes
   * nothing on the new doc.
   */
  const [confirmingClearSnapshots, setConfirmingClearSnapshots] = useState(false);
  const [clearingSnapshots, setClearingSnapshots] = useState(false);
  const performClearSnapshots = useCallback(async () => {
    const docId = node.id;
    setClearingSnapshots(true);
    try {
      await docsApi.clearSnapshots(docId);
      if (activeDocIdRef.current !== docId) return;
      // Invalidate any list request still in flight — a response issued
      // before the clear would otherwise land afterward and bring back the
      // cleared count and list.
      listRequestSeqRef.current += 1;
      setSnapshotsLoading(false);
      setSnapshots([]);
      setSnapshotCount(0);
      setSnapshotsError(null);
      setSnapshotsOpen(false);
      setPreviewSnapshot(null);
      setPreviewError(null);
      setConfirmingClearSnapshots(false);
      // The history is gone, so the unchanged current body can be
      // snapshotted again — re-arm the Snapshot button.
      setSnapshottedContent(null);
    } catch (err) {
      if (activeDocIdRef.current !== docId) return;
      // Reload so the count/list reflect whatever the server really has
      // (a partial failure is impossible — single statement — but a
      // network error tells us nothing either way), then rethrow so the
      // ConfirmModal shows the message with retry/cancel.
      void loadSnapshots();
      throw new Error(`Could not clear versions: ${getErrorMessage(err)}`);
    } finally {
      if (activeDocIdRef.current === docId) setClearingSnapshots(false);
    }
  }, [node.id, loadSnapshots]);

  const onToggleSnapshots = useCallback(() => {
    const nextOpen = !snapshotsOpen;
    setSnapshotsOpen(nextOpen);
    // Always refetch on open: agents can add snapshots via tools with no
    // realtime event, so the cached list/count may be stale. The current
    // rows stay visible while the refresh is in flight.
    if (nextOpen && !snapshotsLoading) void loadSnapshots();
  }, [snapshotsOpen, snapshotsLoading, loadSnapshots]);
  const onCloseSnapshots = useCallback(() => setSnapshotsOpen(false), []);

  /**
   * Manual snapshot of the current body. Flushes pending autosave first so
   * the snapshot has the latest keystrokes, then refreshes the list. The
   * snapshotted content is kept in `snapshottedContent`, so the button reads
   * a steady "Snapshotted" until the editor turns dirty or a divergent
   * `node.content` arrives.
   */
  const onCreateSnapshot = useCallback(async () => {
    if (snapshotCreating) return;
    const docId = node.id;
    setSnapshotCreating(true);
    setSnapshotCreateError(null);
    try {
      const flushedContent = (await editorRef.current?.flush()) ?? node.content ?? '';
      await docsApi.createSnapshot(docId);
      if (activeDocIdRef.current !== docId) return;
      // Track the canonical content returned by the fully-drained flush,
      // which is exactly what the server snapshots next. The parent tree may
      // refresh after this callback, but it will converge on this same value
      // and keep the button in its steady Snapshotted state.
      setSnapshottedContent(flushedContent);
      // Bump the count immediately, then refetch so the list (and the
      // count, if it was unresolved) come from the server.
      setSnapshotCount((count) => (count === null ? null : count + 1));
      void loadSnapshots();
    } catch (err) {
      if (activeDocIdRef.current !== docId) return;
      setSnapshotCreateError(getErrorMessage(err));
    } finally {
      setSnapshotCreating(false);
    }
  }, [node.id, node.content, snapshotCreating, loadSnapshots]);

  // Clear the transient error indicator after a beat. The Snapshotted
  // state itself has no timeout — it sticks until the user edits.
  useEffect(() => {
    if (!snapshotCreateError) return;
    const id = window.setTimeout(() => setSnapshotCreateError(null), 4000);
    return () => window.clearTimeout(id);
  }, [snapshotCreateError]);

  // True when the doc's current content matches what we snapshotted —
  // the button reads as "Snapshotted" (dark, non-interactive). Diverges
  // the moment the user edits (cleared when the editor turns dirty) or
  // the autosave round-trip delivers a new node.content.
  const isSnapshotted = snapshottedContent !== null && snapshottedContent === (node.content ?? '');

  // Doc controls (md/txt) sit in the pane topbar beside Export. Snapshot and
  // Versions live in the Properties panel (DocVersions). PropertiesPanel
  // portals them there live, so they need no memoizing.
  const topbarActions = (
    <>
      <MarkdownTextToggle
        activeSide={sourceMode ? 'right' : 'left'}
        leftLabel="md"
        rightLabel="txt"
        onToggle={handleSourceToggle}
        title={sourceMode ? 'Switch to rendered editor' : 'View raw markdown source'}
        size="xs"
        chrome="pill"
        testId="doc-source-toggle"
      />
      <ExportButton
        variant="topbar"
        kind="doc"
        id={node.id}
        suggestedName={`${node.title || 'Untitled'}.md`}
      />
    </>
  );

  // Doc line links: lines handed in directly (preview modal) are applied
  // first, then dropped so a later request (Open in pane, or a chip in this
  // doc that points into it) can take over; every request is applied once.
  // Outline jumps are direct requests too, each with its own (negative) nonce.
  const pendingFocus = useDocLineFocusRequest(node.id);
  const [directFocus, setDirectFocus] = useState<{
    anchor: DocAnchor;
    nonce: number;
    jump?: boolean;
  } | null>(() => (focusAnchor ? { anchor: focusAnchor, nonce: -1 } : null));
  useEffect(() => {
    setDirectFocus(focusAnchor ? { anchor: focusAnchor, nonce: -1 } : null);
  }, [focusAnchor]);
  const lineLinks = useMemo(
    () => ({
      docId: node.id,
      docTitle: node.title,
      focus: directFocus ?? pendingFocus,
      onFocusApplied: (nonce: number) => {
        if (nonce >= 0) consumeDocLineFocus(node.id, nonce);
        else setDirectFocus((current) => (current?.nonce === nonce ? null : current));
      },
    }),
    [node.id, node.title, directFocus, pendingFocus]
  );

  // The Outline: the editor publishes the doc's headings and the one in view
  // to this store, so typing and scrolling re-render only the outline.
  const [outline] = useState(createDocOutlineStore);
  const jumpNonceRef = useRef(-1);
  const onOutlineJump = useCallback((entry: OutlineEntry) => {
    jumpNonceRef.current -= 1;
    setDirectFocus({ anchor: { heading: entry.ref }, nonce: jumpNonceRef.current, jump: true });
  }, []);

  return (
    <PropertiesPanel
      ariaLabel="Document properties"
      topbarActions={topbarActions}
      badge={
        editorSaveStatus.state === 'error' ? (
          <span
            className={docStyles.saveFailed}
            role="alert"
            title={editorSaveStatus.error ?? undefined}
          >
            save failed
          </span>
        ) : null
      }
      panel={
        <DocProperties
          docId={node.id}
          editorSaveState={editorSaveStatus.state}
          editorSaveError={editorSaveStatus.error}
          updatedAt={node.updatedAt}
        >
          <DocOutline store={outline} onJump={onOutlineJump} disabled={previewSnapshot !== null} />
          <DocVersions
            onSnapshot={() => void onCreateSnapshot()}
            snapshotting={snapshotCreating}
            snapshotted={isSnapshotted}
            snapshotError={snapshotCreateError}
            open={snapshotsOpen}
            onToggle={onToggleSnapshots}
            onClose={onCloseSnapshots}
            onMountChange={onVersionsMountChange}
            snapshots={snapshots}
            count={snapshotCount}
            loading={snapshotsLoading}
            error={snapshotsError}
            selectedId={previewSnapshot?.id ?? null}
            onSelect={(snapshotId) => void onSelectSnapshot(snapshotId)}
            onClearAll={() => setConfirmingClearSnapshots(true)}
            clearing={clearingSnapshots}
            busy={snapshotCreating || restoring || deleting}
          />
        </DocProperties>
      }
    >
      <div className={styles.detailContainer}>
        {previewLoading ? (
          <div className={styles.snapshotPreviewBanner}>Loading version…</div>
        ) : null}
        {previewError ? (
          <div className={styles.snapshotPreviewBanner} role="alert">
            Error: {previewError}
          </div>
        ) : null}
        {previewSnapshot ? (
          <div className={styles.snapshotPreviewBanner}>
            <span>
              Viewing the version <strong>{snapshotLabel(previewSnapshot)}</strong>
            </span>
            <span className={styles.snapshotPreviewActions}>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onRestorePreview()}
                disabled={restoring || deleting || clearingSnapshots}
                loading={restoring}
                loadingText="Restoring…"
                title="Replace the current doc with this version. The current doc is saved as a version first."
              >
                Restore this version
              </Button>
              <Button
                variant="neutral"
                size="sm"
                onClick={onDeletePreview}
                disabled={restoring || deleting || clearingSnapshots}
                loading={deleting}
                loadingText="Deleting…"
                title="Permanently delete this version. The current doc and its other versions are not affected."
              >
                Delete this version
              </Button>
              <Button
                variant="neutral"
                size="sm"
                onClick={onExitPreview}
                disabled={restoring || deleting || clearingSnapshots}
                title="Exit preview and return to the current doc."
              >
                Back to current
              </Button>
            </span>
          </div>
        ) : null}
        {confirmingSnapshotDelete && previewSnapshot ? (
          <ConfirmModal
            title="Delete this version?"
            confirmLabel="Delete this version"
            destructive
            onConfirm={() => {
              // Close first — the banner button's "Deleting…" spinner and the
              // previewError banner carry the in-flight/failure states.
              setConfirmingSnapshotDelete(false);
              void performDeletePreview();
            }}
            onCancel={() => setConfirmingSnapshotDelete(false)}
          >
            {[
              `Delete the version ${snapshotLabel(previewSnapshot)}?`,
              'This permanently removes this version from the doc’s history. ' +
                'The current doc and its other versions are not affected.',
            ]}
          </ConfirmModal>
        ) : null}
        {confirmingClearSnapshots && snapshotCount !== null && snapshotCount > 0 ? (
          <ConfirmModal
            title="Clear all versions?"
            confirmLabel="Clear all versions"
            confirmingLabel="Clearing…"
            destructive
            // Async on purpose: the dialog stays up with "Clearing…" while
            // the request runs, and a failure renders inline with retry /
            // cancel. Success clears the state that renders the dialog.
            onConfirm={performClearSnapshots}
            onCancel={() => {
              if (!clearingSnapshots) setConfirmingClearSnapshots(false);
            }}
          >
            {[
              `Permanently delete all ${snapshotCount} saved ${
                snapshotCount === 1 ? 'version' : 'versions'
              } of “${node.title || 'Untitled'}”?`,
              'The current doc content will not change — only its saved version history is removed. ' +
                'This cannot be undone.',
            ]}
          </ConfirmModal>
        ) : null}
        {previewSnapshot ? (
          <div className={docStyles.snapshotPreview}>
            <SnapshotFind
              rootRef={snapshotPreviewRef}
              value={previewSnapshot.content}
              identity={previewSnapshot.id}
            />
            <div ref={snapshotPreviewRef} className={docStyles.snapshotPreviewBody}>
              <ChipEditableInput
                // Remount per snapshot so TipTap doesn't carry stale state
                // across snapshot switches.
                key={`snap-${previewSnapshot.id}`}
                value={previewSnapshot.content}
                onChange={() => {
                  // Read-only — ignore any defensive onChange a chip
                  // toggle / accidental keystroke might emit.
                }}
                disabled
                placeholder=""
                multiline
                allowInlineParse
                allowMarkdownPreview
                enableNodeMentions
                defaultMode="preview"
                ariaLabel="Doc body (snapshot preview, read-only)"
                className={styles.docBody}
              />
            </div>
          </div>
        ) : (
          <WorkspaceEditor
            // Remounting on node.id is what discards a draft when the
            // user navigates to a different doc; previewSnapshot's
            // absence keeps WorkspaceEditor mounted across the preview
            // round-trip so its internal draft survives the visit.
            key={node.id}
            ref={editorRef}
            kind="doc-body"
            savedValue={node.content ?? ''}
            onSave={handleSaveContent}
            bodyClassName={styles.docBody}
            enableNodeMentions
            sourceMode={sourceMode}
            onSaveStateChange={handleEditorSaveStateChange}
            lineLinks={lineLinks}
            outline={outline}
          />
        )}
      </div>
    </PropertiesPanel>
  );
};
