// Composer: a chip-aware chat input (`ChipEditableInput`) with send/stop
// actions and image attachments. Image `<image id="…"/>` markers are
// appended to the outgoing text at submit time.
//
// File drops use plain HTML5 DnD in the browser and in Tauri on macOS and
// Linux (main.rs disables Tauri's native drag-drop handler there). Chip
// drags carry a custom mime type, so the editor handles chips and the wrap
// handles files. A dropped non-image file is inserted as its absolute path,
// which the File API never exposes: its bytes are hashed and the Tauri shell
// finds the matching file on disk (`@desktop/utils/dropPathRecovery`).

import { ChipEditableInput } from '@desktop/features/rich-markdown/editor';
import type { EditorPopoverAnchor } from '@desktop/features/rich-markdown/editor/EditorPopover';
import { Button } from '@desktop/components';
import { ComposerNotice, ComposerShell, composerInputClassName } from '@desktop/features/composer';
import { PaperclipIcon } from '@desktop/components/Icons';
import { imagesApi } from '@desktop/utils/api';
import { expandTransclusions } from '@desktop/utils/nodeChip';
import { resolveDroppedFilePath } from '@desktop/utils/dropPathRecovery';
import { normalizeChatComposerMarkdown } from '../chatMarkdown';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FC,
  type ReactNode,
} from 'react';
import styles from './Composer.module.scss';
import { useDraftPersistence } from './useDraftPersistence';
import { DroppedFilePathPicker } from './DroppedFilePathPicker';
import { subscribeVoiceComposer } from '@desktop/features/voice/voiceDraftBus';
import { publishVoiceAttachmentIds } from '@desktop/features/voice/voiceAttachmentsBus';
import {
  reduceVoiceDraft,
  INITIAL_VOICE_DRAFT,
  type VoiceDraftAction,
} from '@desktop/features/voice/voiceComposerDraft';
import { VOICE_SETTLE_MS } from '@desktop/features/voice/voiceConstants';
import { getErrorMessage, imageSizeProblem } from '@snaglet/shared/utils';
import { appendSelectedAgentMentions } from '@desktop/utils/agentMentionMarkdown';
import { useThreadRecipientContext } from '@desktop/features/voice/ThreadRecipientContext';

export interface ComposerProps {
  placeholder?: string;
  working?: boolean;
  threadId?: string;
  onSubmit?: (text: string) => void;
  onStop?: () => void;
  /**
   * Text to restore after the server rejected a send before any run started.
   * Non-null triggers a one-shot restore, then `onRestored`. Skipped if the
   * user has already typed a new draft.
   */
  restoreText?: string | null;
  onRestored?: () => void;
  /**
   * Put `text` in the composer and focus it (an empty thread's suggestion).
   * Each new `id` is one request; it replaces the draft and never sends.
   */
  fillRequest?: { text: string; id: number } | null;
  /**
   * Dictation controls rendered in the secondary rail below the bordered
   * composer bubble. Kept as a slot so Composer stays decoupled from voice.
   */
  voiceControls?: ReactNode;
  /**
   * Voice-mode/capture and Vision controls rendered in the same secondary
   * rail, separately from `voiceControls` so their feature ownership remains
   * unchanged. Renders nothing when omitted.
   */
  voiceModeControls?: ReactNode;
}

interface Attachment {
  id: string;
  name: string;
  /** Local image preview; persisted IDs are fetched after the message is sent. */
  previewUrl: string | null;
}

/** OS file drags advertise the `Files` type; in-app chip drags never do. */
function dragHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files');
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * The dropped `File`s that are really folders, from each item's
 * `webkitGetAsEntry().isDirectory`. Matched back to `files` by name (the
 * entry and the `File` are different objects). Empty when the drop carries
 * no `items` or the webview lacks `webkitGetAsEntry`.
 */
function droppedDirectories(dataTransfer: DataTransfer, files: File[]): Set<File> {
  const dirs = new Set<File>();
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  for (const item of items) {
    if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') continue;
    const entry = item.webkitGetAsEntry();
    if (!entry?.isDirectory) continue;
    const match = files.find((f) => f.name === entry.name && !dirs.has(f));
    if (match) dirs.add(match);
  }
  return dirs;
}

export const Composer: FC<ComposerProps> = ({
  placeholder = 'Message…',
  working,
  threadId,
  onSubmit,
  onStop,
  voiceControls,
  voiceModeControls,
  restoreText,
  onRestored,
  fillRequest = null,
}) => {
  const { draftText: value, setDraftText: setValue, clearDraft } = useDraftPersistence(threadId);
  const recipients = useThreadRecipientContext();

  // Image attachments (id + preview url). Declared above the restore and
  // voice-bus effects, which both put attachments back or clear them.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  attachmentsRef.current = attachments;

  const revokePreviews = useCallback((items: Attachment[]) => {
    for (const item of items) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((previous) => {
      revokePreviews(previous);
      return [];
    });
  }, [revokePreviews]);

  useEffect(() => () => revokePreviews(attachmentsRef.current), [revokePreviews]);

  // What the composer held at the last send. A failed send hands back the
  // outbound text (includes expanded, markers and mentions appended), so a
  // match restores the draft and attachments as the user had them instead.
  const lastSentRef = useRef<{
    outbound: string;
    draft: string;
    attachments: Attachment[];
  } | null>(null);

  // One-shot restore of a failed send, skipped if the user has already
  // started a new draft.
  const restoredRef = useRef<string | null>(null);
  useEffect(() => {
    if (restoreText == null) {
      restoredRef.current = null;
      return;
    }
    if (restoredRef.current === restoreText) return;
    restoredRef.current = restoreText;
    if (!value.trim()) {
      const sent = lastSentRef.current?.outbound === restoreText ? lastSentRef.current : null;
      setValue(sent ? sent.draft : restoreText);
      if (sent && sent.attachments.length > 0) {
        // The original object URLs were revoked when the send cleared the
        // composer, so a restored attachment shows a placeholder.
        setAttachments((prev) => [
          ...sent.attachments
            .filter((a) => !prev.some((p) => p.id === a.id))
            .map((a) => ({ ...a, previewUrl: null })),
          ...prev,
        ]);
      }
    }
    onRestored?.();
  }, [restoreText, value, setValue, onRestored]);

  // A suggestion fills the composer; the person still sends it.
  const filledIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!fillRequest || filledIdRef.current === fillRequest.id) return;
    filledIdRef.current = fillRequest.id;
    setValue(fillRequest.text);
    wrapRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
  }, [fillRequest, setValue]);

  // Voice capture → composer
  // During voice mode the live transcript renders into this input. The typed
  // draft is stashed on capture start, the transcript shows while capturing,
  // and the draft comes back after dispatch, on Esc, or when nothing was sent.
  // The reducer (voiceComposerDraft) is pure; this owns the stash and timer.
  const valueRef = useRef(value);
  valueRef.current = value;
  const voiceDraftRef = useRef(INITIAL_VOICE_DRAFT);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Apple STT re-decodes the utterance so far and can revise earlier words.
  // When an update revises (rather than extends) the text, the composer shows
  // a subtle "refining" cue. Cleared on start and finalize.
  const [voiceRevising, setVoiceRevising] = useState(false);

  useEffect(() => {
    const clearSettleTimer = () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
    const apply = (action: VoiceDraftAction) => {
      const r = reduceVoiceDraft(voiceDraftRef.current, action, valueRef.current);
      voiceDraftRef.current = r.state;
      if (r.setValue !== undefined) setValue(r.setValue);
    };
    const unsub = subscribeVoiceComposer((evt) => {
      if (!threadId || evt.threadId !== threadId) return;
      // Any new signal cancels a pending settle-restore timer, so it can't fire
      // mid-capture or re-stash the just-sent text. A 'start' mid-settle
      // re-stashes the pre-settle draft, not the sent final.
      clearSettleTimer();
      switch (evt.kind) {
        case 'start':
          setVoiceRevising(false);
          apply({ type: 'start' });
          break;
        case 'update':
          setVoiceRevising(evt.isRevising);
          apply({ type: 'update', text: evt.text });
          break;
        case 'settle':
          // Finalize: the transcript is settled — clear the refining cue.
          setVoiceRevising(false);
          // A dispatched voice message consumed its attachments (sent as
          // <image id/> markers), so clear them as a manual send does.
          // bail/revert send nothing and keep them.
          clearAttachments();
          apply({ type: 'settle', text: evt.text });
          settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            apply({ type: 'settle-done' });
          }, VOICE_SETTLE_MS);
          break;
        case 'bail':
          setVoiceRevising(false);
          apply({ type: 'bail', text: evt.text });
          break;
        case 'revert':
          setVoiceRevising(false);
          apply({ type: 'revert' });
          break;
      }
    });
    return () => {
      clearSettleTimer();
      unsub();
    };
  }, [threadId, setValue, clearAttachments]);

  // Publish the composer's image attachments to the voice session
  // (voiceAttachmentsBus), so a dictated message carries images attached
  // before or during voice input.
  useEffect(() => {
    if (!threadId) return;
    publishVoiceAttachmentIds(
      threadId,
      attachments.map((a) => a.id)
    );
  }, [threadId, attachments]);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // True while a submit expands its `![](doc-x)` includes, so a second click
  // can't send twice. The ref is the same flag, read synchronously for an
  // Enter that lands before the re-render.
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [dragOver, setDragOver] = useState(false);
  // Dropped-file path recovery. `fileNotice` says what happened to a
  // non-image file (path not found, or skipped by the picker).
  // `pendingPathPicker` holds one ambiguous resolution at a time; its
  // `resolve` settles the promise `resolveAndInsertPaths` awaits.
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [pendingPathPicker, setPendingPathPicker] = useState<{
    anchor: EditorPopoverAnchor;
    candidates: string[];
    resolve: (path: string | null) => void;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // dragenter/dragleave fire for every child crossed; a depth counter
  // keeps the highlight steady until the drag truly exits the wrap.
  const dragDepthRef = useRef(0);

  const submit = useCallback(async () => {
    // Enter submits too, and the Send button's disabled state doesn't
    // cover it: hold the send while a previous one is still expanding its
    // includes (it would go twice) or an image is still uploading (the
    // message would go without it).
    if (!onSubmit || sendingRef.current || uploading) return;
    const chatMarkdown = normalizeChatComposerMarkdown(value);
    const trimmed = chatMarkdown.trim();
    if (!trimmed && attachments.length === 0) return;
    sendingRef.current = true;
    setSending(true);
    try {
      // Expand transclusions (`![](doc-x)`) into the doc content,
      // wrapped in `<doc>…</doc>` tags, so the sent message carries the text.
      const expanded = await expandTransclusions(trimmed);
      // Recipient pills are a group-thread control. A solo thread retains
      // the voice default target internally, but typed sends must not gain
      // an invisible @mention for a pill the composer does not render.
      const selectedAgents =
        recipients && recipients.participantAgentIds.length > 1
          ? recipients.selectedAgentIds.map((agentId) => ({
              id: agentId,
              name: recipients.agentName(agentId),
            }))
          : [];
      // Empty selection deliberately leaves a typed send unaddressed. In a
      // group thread using `mentioned` routing, the server keeps the message
      // but dispatches nobody and returns its existing visible dispatch hint.
      const addressed = appendSelectedAgentMentions(expanded, selectedAgents);
      const markers = attachments.map((a) => `<image id="${a.id}"/>`).join(' ');
      const outbound = [addressed, markers].filter(Boolean).join(addressed ? '\n\n' : '');
      if (!outbound) return;
      lastSentRef.current = { outbound, draft: value, attachments };
      onSubmit(outbound);
      clearDraft();
      clearAttachments();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [value, attachments, onSubmit, clearDraft, clearAttachments, recipients, uploading]);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const images = files.filter((file) => file.type.startsWith('image/'));
      // Over-limit images are refused here, before any bytes are read or sent.
      const sizeProblems: string[] = [];
      const accepted = images.filter((file) => {
        const problem = imageSizeProblem(file.size, images.length > 1 ? file.name : undefined);
        if (problem) sizeProblems.push(problem);
        return !problem;
      });
      setUploadError(sizeProblems.length > 0 ? sizeProblems.join(' ') : null);
      if (accepted.length === 0) return;
      setUploading(true);
      const next: Attachment[] = [];
      try {
        for (const file of accepted) {
          const dataUrl = await fileToDataUrl(file);
          // Send the thread, never a container: the server resolves this
          // thread's current placement so the image lands in the same part of
          // the tree the conversation lives in. A root-level thread resolves
          // to null and the image stays at the root.
          const stored = await imagesApi.upload({
            name: file.name || undefined,
            dataUrl,
            ...(threadId ? { threadId } : {}),
          });
          if (!stored?.id) {
            throw new Error('upload returned no id');
          }
          next.push({
            id: stored.id,
            name: file.name || stored.id,
            previewUrl: URL.createObjectURL(file),
          });
        }
        if (next.length > 0) {
          setAttachments((prev) => [...prev, ...next]);
        }
      } catch (err) {
        revokePreviews(next);
        const failure = `Upload failed: ${getErrorMessage(err, 'upload failed')}`;
        setUploadError([...sizeProblems, failure].join(' '));
      } finally {
        setUploading(false);
      }
      // `threadId` is a real dependency: without it a reused Composer would
      // place the image in the previous thread's container, silently.
    },
    [threadId, revokePreviews]
  );

  const removeAttachment = useCallback(
    (id: string) => {
      setAttachments((previous) => {
        const removed = previous.find((attachment) => attachment.id === id);
        if (removed) revokePreviews([removed]);
        return previous.filter((attachment) => attachment.id !== id);
      });
    },
    [revokePreviews]
  );

  // Insert `text` into the composer's plain-text draft. The composer holds a
  // string, not a caret position in the ProseMirror doc, so this appends to
  // the end (as `registerPreviewNativeDropEl` in ChipEditableInput.tsx does).
  const insertTextIntoComposer = useCallback(
    (text: string) => {
      setValue((prev) => {
        const separator = prev.length === 0 || /\s$/.test(prev) ? '' : ' ';
        return `${prev}${separator}${text}`;
      });
    },
    [setValue]
  );

  // Resolve to the chosen path, or `null` if the user dismissed the picker.
  // Settles from `pendingPathPicker`'s `resolve`, so the caller's loop
  // prompts for one ambiguous file at a time.
  const promptForPath = useCallback((candidates: string[]): Promise<string | null> => {
    return new Promise((resolve) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      const anchor: EditorPopoverAnchor = rect
        ? { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }
        : null;
      setPendingPathPicker({ anchor, candidates, resolve });
    });
  }, []);

  // Dropped non-image files: hash each, ask the Tauri shell to recover its
  // absolute path via Spotlight, and insert it. Sequential, so prompts and
  // insertions follow drop order.
  const resolveAndInsertPaths = useCallback(
    async (files: File[], directories: ReadonlySet<File> = new Set()) => {
      for (const file of files) {
        const result = await resolveDroppedFilePath(file, {
          isDirectory: directories.has(file),
        });
        if (result.status === 'unique') {
          insertTextIntoComposer(result.path);
        } else if (result.status === 'ambiguous') {
          const chosen = await promptForPath(result.candidates);
          if (chosen) insertTextIntoComposer(chosen);
        } else {
          setFileNotice(`Couldn't locate the path for "${file.name}".`);
        }
      }
    },
    [insertTextIntoComposer, promptForPath]
  );

  const onPickPath = useCallback(
    (path: string) => {
      pendingPathPicker?.resolve(path);
      setPendingPathPicker(null);
    },
    [pendingPathPicker]
  );

  const onDismissPathPicker = useCallback(() => {
    pendingPathPicker?.resolve(null);
    setPendingPathPicker(null);
  }, [pendingPathPicker]);

  const onFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = '';
      // The picker offers images only, but "All files" can still pick
      // others; say so rather than drop them without a word.
      const skipped = files.filter((f) => !f.type.startsWith('image/'));
      setFileNotice(
        skipped.length > 0
          ? `Only images can be attached; skipped ${skipped.map((f) => `"${f.name}"`).join(', ')}.`
          : null
      );
      void uploadFiles(files);
    },
    [uploadFiles]
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(event.clipboardData.files).filter((file) =>
        file.type.startsWith('image/')
      );
      if (files.length === 0) return;
      event.preventDefault();
      void uploadFiles(files);
    },
    [uploadFiles]
  );

  const onAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  }, []);

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    // Without preventDefault the browser cancels the drag and `drop`
    // never fires (same requirement as the editor's chip dragover).
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      // Folders arrive as `File`s too (empty type, unreadable bytes). Tag
      // them now — `items` is only readable during the drop event itself,
      // before any await — so path recovery looks for a directory.
      const directories = droppedDirectories(e.dataTransfer, files);
      // Images upload and embed as attachments; everything else goes
      // through Spotlight path recovery (see the module doc comment and
      // `@desktop/utils/dropPathRecovery`).
      const images = files.filter((f) => f.type.startsWith('image/'));
      const nonImages = files.filter((f) => !f.type.startsWith('image/'));
      // Clear any notice from a previous drop: unlike uploadError, fileNotice
      // has no other path back to null.
      setFileNotice(null);
      if (images.length > 0) {
        void uploadFiles(images);
      }
      if (nonImages.length > 0) {
        void resolveAndInsertPaths(nonImages, directories);
      }
    },
    [uploadFiles, resolveAndInsertPaths]
  );

  const disabled = !onSubmit;
  const hasContent = value.trim().length > 0 || attachments.length > 0;
  const canSend = hasContent && !disabled && !uploading && !sending;

  return (
    <div className={styles.composerShell} data-testid="composer-shell">
      <ComposerShell
        ref={wrapRef}
        className={styles.bubble}
        dragOver={dragOver}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPaste={onPaste}
        data-testid="message-composer"
        data-composer-region="primary"
        data-voice-revising={voiceRevising ? 'true' : undefined}
        overlay={
          pendingPathPicker && (
            <DroppedFilePathPicker
              anchor={pendingPathPicker.anchor}
              candidates={pendingPathPicker.candidates}
              onPick={onPickPath}
              onDismiss={onDismissPathPicker}
            />
          )
        }
        attachmentsLabel="Attached images"
        attachments={
          attachments.length > 0 &&
          attachments.map((a) => (
            <div key={a.id} className={styles.attachment} title={a.name}>
              {a.previewUrl ? (
                <img src={a.previewUrl} alt={a.name} className={styles.attachmentImage} />
              ) : (
                <div
                  className={styles.attachmentPlaceholder}
                  role="img"
                  aria-label={`${a.name} preview unavailable`}
                >
                  Image
                </div>
              )}
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                className={styles.attachmentRemove}
                onClick={() => removeAttachment(a.id)}
                aria-label={`Remove ${a.name}`}
                title="Remove"
              >
                ×
              </Button>
            </div>
          ))
        }
        notices={
          <>
            {uploadError && (
              <ComposerNotice tone="error" role="alert">
                {uploadError}
              </ComposerNotice>
            )}
            {fileNotice && (
              <ComposerNotice tone="info" role="status">
                {fileNotice}
              </ComposerNotice>
            )}
          </>
        }
        actionsTestId="composer-primary-actions"
        leadingActions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={onFileChange}
              style={{ display: 'none' }}
            />
            <Button
              variant="ghost"
              size="md"
              iconOnly
              onClick={onAttachClick}
              disabled={disabled || uploading}
              loading={uploading}
              loadingText="…"
              aria-label="Attach image"
              title={uploading ? 'Uploading…' : 'Attach image'}
            >
              <PaperclipIcon />
            </Button>
          </>
        }
        trailingActions={
          <>
            {working && onStop && (
              <Button variant="danger" size="md" onClick={onStop}>
                Stop
              </Button>
            )}
            <Button
              variant="primary"
              size="md"
              onClick={() => void submit()}
              disabled={!canSend}
              loading={sending}
              loadingText="…"
              aria-label="Send message"
            >
              Send
            </Button>
          </>
        }
      >
        <ChipEditableInput
          value={value}
          onChange={setValue}
          placeholder={placeholder}
          disabled={disabled}
          multiline
          submitOnEnter
          allowInlineParse
          enableNodeMentions
          threadId={threadId}
          richBlocks
          className={`${composerInputClassName} ${styles.input}`}
          ariaLabel="Message composer"
          onSubmit={() => void submit()}
        />
      </ComposerShell>
      <div
        className={styles.secondaryRail}
        role="group"
        aria-label="Composer secondary controls"
        data-testid="composer-secondary-rail"
      >
        {voiceControls && <div className={styles.voiceControlsSlot}>{voiceControls}</div>}
        {voiceModeControls && (
          <div className={styles.voiceModeControlsSlot} data-testid="composer-voice-mode-row">
            {voiceModeControls}
          </div>
        )}
      </div>
    </div>
  );
};
