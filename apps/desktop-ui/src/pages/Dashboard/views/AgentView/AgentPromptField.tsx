import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import {
  WorkspaceEditor,
  EditorSaveHint,
  useEditorSaveStatus,
  type WorkspaceEditorAutosaveState,
  type WorkspaceEditorHandle,
} from '@desktop/features/rich-markdown/workspace-editor';
import type { ConflictChoice, EditingProbe, LiveConflict, SaveGate } from './agentLiveFields';
import { LiveFieldNotice } from './LiveFieldNotice';
import styles from './SystemPromptEditor.module.scss';

/** Editor states that mean the user has text the server does not have yet. */
const DRAFT_STATES: ReadonlySet<WorkspaceEditorAutosaveState> = new Set([
  'dirty',
  'saving',
  'error',
]);

type SaveResult = string | void;
interface HeldSave {
  value: string;
  resolve: (result: SaveResult | Promise<SaveResult>) => void;
}

export interface AgentPromptFieldProps {
  kind: 'agent-identity' | 'agent-system-prompt';
  testId: string;
  placeholder: string;
  /** The saved text to show: the live value, or the held one while a change waits. */
  value: string;
  onSave: (value: string) => Promise<void> | void;
  /** Someone else changed this text while the user was editing it. */
  conflict?: LiveConflict | null;
  /** The user picked Reload or Keep mine; the pane stops holding the old text. */
  onResolveConflict?: (choice?: ConflictChoice) => void;
  /** Filled in with "is the user editing this field right now?" for the pane. */
  editingProbe?: EditingProbe;
  /**
   * True while saves must wait: a change to this text is on its way or open.
   * Without one, saves wait only while `conflict` is set.
   */
  saveGate?: SaveGate;
  /** A change to this text is on its way (its refetch has not landed). */
  waiting?: boolean;
  /** The editor is closing with a conflict open: keep this draft for when it returns. */
  onKeepDraft?: (text: string) => void;
}

/**
 * An agent's identity or system prompt editor that follows remote changes.
 *
 * With nothing waiting it is the plain autosaving editor. While a change to
 * this text is on its way (`saveGate`) or open (`conflict`), the editor keeps
 * the user's text and its saves wait. When the change lands with no conflict
 * (the user was not editing it, or it went back to their starting text), the
 * waiting saves go through. With a conflict, nothing is written over the
 * other change until the user picks:
 *
 * - Keep mine: the waiting saves go through, then whatever the editor shows
 *   is saved if the server still has something else.
 * - Reload: the waiting saves end on the saved text without writing, and a
 *   fresh editor mounts on it. Saves are bound to the editor they came from,
 *   so the dropped editor's last flush cannot write.
 *
 * If the editor closes (a tab switch) with a conflict open, its draft goes
 * back to the pane (`onKeepDraft`), and the editor reopens on it, notice and
 * all. Nothing is written until the user picks.
 */
export const AgentPromptField: FC<AgentPromptFieldProps> = ({
  kind,
  testId,
  placeholder,
  value,
  onSave,
  conflict = null,
  onResolveConflict,
  editingProbe,
  saveGate,
  waiting = false,
  onKeepDraft,
}) => {
  const { status, onSaveStateChange } = useEditorSaveStatus();
  const saveStateRef = useRef<WorkspaceEditorAutosaveState>('pristine');
  const handleSaveState = useCallback(
    (state: WorkspaceEditorAutosaveState, error: string | null) => {
      saveStateRef.current = state;
      onSaveStateChange(state, error);
    },
    [onSaveStateChange]
  );

  const sectionRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<WorkspaceEditorHandle>(null);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onKeepDraftRef = useRef(onKeepDraft);
  onKeepDraftRef.current = onKeepDraft;
  const heldSaves = useRef<HeldSave[]>([]);
  // The newest text a held save carried: the draft to keep if the editor closes.
  const draftRef = useRef<string | null>(null);
  // Keep mine is running: saves pass through, and the last one is noted.
  const keepingRef = useRef(false);
  const writtenRef = useRef<string | null>(null);
  const unmountedRef = useRef(false);
  // Bumped by Reload: a fresh editor, and the old one's saves go nowhere.
  const [editorEpoch, setEditorEpoch] = useState(0);
  const epochRef = useRef(0);

  const blocked = useCallback(
    () => !keepingRef.current && (saveGate ? saveGate.current : conflictRef.current !== null),
    [saveGate]
  );
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  /** Write the held saves (`true`) or end them on `endWith` without writing. */
  const releaseHeld = useCallback((write: boolean, endWith?: string) => {
    draftRef.current = null;
    for (const save of heldSaves.current.splice(0)) {
      if (write) save.resolve(Promise.resolve(onSaveRef.current(save.value)).then(() => undefined));
      else save.resolve(endWith ?? save.value);
    }
  }, []);

  useEffect(() => {
    if (!editingProbe) return;
    editingProbe.current = () =>
      DRAFT_STATES.has(saveStateRef.current) ||
      Boolean(sectionRef.current?.contains(document.activeElement));
    return () => {
      editingProbe.current = null;
    };
  }, [editingProbe]);

  // The change landed with nothing to choose (or the conflict went away on
  // its own): the waiting saves go through.
  useEffect(() => {
    if (conflict || waiting || blockedRef.current()) return;
    releaseHeld(true);
  }, [conflict, waiting, releaseHeld]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (conflictRef.current) {
        // Closing with no choice made: keep the draft for when it reopens,
        // and write nothing over the other change.
        const draft = draftRef.current;
        if (draft !== null) onKeepDraftRef.current?.(draft);
        releaseHeld(false);
      } else {
        // Only a refetch was pending: write as any closing editor does.
        releaseHeld(true);
      }
    };
  }, [releaseHeld]);

  const handleSave = useMemo(() => {
    const epoch = editorEpoch;
    return (next: string): SaveResult | Promise<SaveResult> => {
      // An editor dropped by Reload: its text was discarded on purpose.
      if (epochRef.current !== epoch) return next;
      if (blockedRef.current()) {
        if (unmountedRef.current) {
          if (conflictRef.current) {
            onKeepDraftRef.current?.(next);
            return next;
          }
          return onSaveRef.current(next);
        }
        draftRef.current = next;
        return new Promise<SaveResult>((resolve) =>
          heldSaves.current.push({ value: next, resolve })
        );
      }
      if (!keepingRef.current) return onSaveRef.current(next);
      return Promise.resolve(onSaveRef.current(next)).then(() => {
        writtenRef.current = next;
      });
    };
  }, [editorEpoch]);

  const keepMine = useCallback(async () => {
    const pending = conflictRef.current;
    if (!pending || keepingRef.current) return;
    keepingRef.current = true;
    writtenRef.current = null;
    try {
      for (const save of heldSaves.current.splice(0)) {
        const write = Promise.resolve(onSaveRef.current(save.value)).then(() => {
          writtenRef.current = save.value;
        });
        // The editor's save queue waits on the write, then saves newer edits.
        save.resolve(write);
        await write;
      }
      const shown = (await editorRef.current?.flush()) ?? valueRef.current;
      if (shown !== (writtenRef.current ?? pending.remote)) await onSaveRef.current(shown);
      onResolveConflict?.({ keptOver: pending, kept: shown });
    } catch (err: unknown) {
      // The editor shows the failed save; the choice stays open to try again.
      console.error('AgentPromptField: keeping the draft failed', err);
    } finally {
      keepingRef.current = false;
    }
  }, [onResolveConflict]);

  const reload = useCallback(() => {
    const pending = conflictRef.current;
    if (!pending) return;
    epochRef.current += 1;
    releaseHeld(false, pending.remote);
    saveStateRef.current = 'pristine';
    onResolveConflict?.();
    setEditorEpoch(epochRef.current);
  }, [onResolveConflict, releaseHeld]);

  return (
    <div className={styles.outer} data-testid={testId} ref={sectionRef}>
      <span className={styles.labelRow}>
        {conflict ? (
          <LiveFieldNotice
            conflict={conflict}
            onReload={reload}
            onKeepMine={() => void keepMine()}
          />
        ) : (
          <EditorSaveHint state={status.state} error={status.error} />
        )}
      </span>
      <WorkspaceEditor
        key={editorEpoch}
        ref={editorRef}
        className={styles.editor}
        kind={kind}
        savedValue={value}
        onSave={handleSave}
        defaultMode="edit"
        allowPreview={false}
        hideChrome
        placeholder={placeholder}
        onSaveStateChange={handleSaveState}
      />
    </div>
  );
};
