import { useCallback, useEffect, useId, useRef, useState, type FC } from 'react';
import { TextInput } from '@desktop/components';
// Import the hook directly (not via the editor barrel, which also re-exports
// the heavy ChipEditableInput and its WebSocket-context chain) — this field
// only needs the debounced-save state machine.
import { useAutosave } from '@desktop/features/rich-markdown/editor';
import type { ConflictChoice, EditingProbe, LiveConflict, SaveGate } from './agentLiveFields';
import { LiveFieldNotice } from './LiveFieldNotice';
import styles from './AgentView.module.scss';

interface AgentRoleFieldProps {
  /** The saved role ('' when none). */
  role: string;
  /** Persist a role; null clears it. */
  onSave: (role: string | null) => Promise<void>;
  /** Someone else changed the role while the user was editing it. */
  conflict?: LiveConflict | null;
  /** The user picked Reload or Keep mine. */
  onResolveConflict?: (choice?: ConflictChoice) => void;
  /** Filled in with "is the user editing the role right now?" for the pane. */
  editingProbe?: EditingProbe;
  /**
   * True while saves must wait: a change to the role is on its way or open.
   * Without one, saves wait only while `conflict` is set.
   */
  saveGate?: SaveGate;
  /** A change to the role is on its way (its refetch has not landed). */
  waiting?: boolean;
  /** Highlight briefly: the role just changed somewhere else. */
  live?: boolean;
}

/**
 * The agent's role: free text that auto-saves on a ~800ms debounce (bursts of
 * keystrokes coalesce into one write) and flushes on blur. A save that matches
 * the saved role is a no-op, and so is one the field has moved past (newer
 * text follows it, or Reload replaced it). On failure the typed value stays,
 * with a retry.
 *
 * While a change to the role is on its way (`saveGate`) a save waits, and
 * goes through once the change lands with nothing to choose. While a remote
 * change waits on the user (`conflict`), the typed text stays and nothing is
 * saved until they pick Reload (show the saved role) or Keep mine (save what
 * the field shows).
 */
export const AgentRoleField: FC<AgentRoleFieldProps> = ({
  role,
  onSave,
  conflict = null,
  onResolveConflict,
  editingProbe,
  saveGate,
  waiting = false,
  live = false,
}) => {
  const inputId = useId();
  const [localRole, setLocalRoleState] = useState(role);
  const localRoleRef = useRef(localRole);
  const setLocalRole = useCallback((next: string) => {
    localRoleRef.current = next;
    setLocalRoleState(next);
  }, []);
  const roleRef = useRef(role);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  // After Reload the autosave state describes a save that wrote nothing.
  const [statusHidden, setStatusHidden] = useState(false);
  // Saves waiting at the gate: true lets one write, false ends it unwritten.
  const heldRef = useRef<Array<(write: boolean) => void>>([]);

  const blocked = useCallback(
    () => (saveGate ? saveGate.current : conflictRef.current !== null),
    [saveGate]
  );
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const release = useCallback((write: boolean) => {
    for (const resolve of heldRef.current.splice(0)) resolve(write);
  }, []);

  // Follow the saved role unless the user has text of their own in the field:
  // a draft (it differs from the role it started from) that is not simply the
  // value just saved.
  useEffect(() => {
    const previous = roleRef.current;
    roleRef.current = role;
    if (conflictRef.current) return;
    const shown = localRoleRef.current.trim();
    if (shown === previous || shown === role) setLocalRole(role);
  }, [role, setLocalRole]);

  const saveRole = useCallback(
    async (val: string) => {
      while (blockedRef.current()) {
        const write = await new Promise<boolean>((resolve) => heldRef.current.push(resolve));
        if (!write) return;
      }
      // The field moved past this text: a newer save follows, or Reload.
      if (val !== localRoleRef.current) return;
      const trimmed = val.trim();
      if (trimmed === roleRef.current) return;
      // An empty field clears the role with null; an omitted key (undefined)
      // would leave the stored role in place.
      await onSave(trimmed || null);
    },
    [onSave]
  );
  const autosave = useAutosave({ save: saveRole, delayMs: 800 });
  const autosaveStateRef = useRef(autosave.state);
  autosaveStateRef.current = autosave.state;

  useEffect(() => {
    if (!editingProbe) return;
    editingProbe.current = () =>
      document.activeElement?.id === inputId ||
      localRoleRef.current.trim() !== roleRef.current ||
      autosaveStateRef.current === 'dirty' ||
      autosaveStateRef.current === 'saving';
    return () => {
      editingProbe.current = null;
    };
  }, [editingProbe, inputId]);

  // The change landed with nothing to choose: waiting saves go through.
  useEffect(() => {
    if (conflict || waiting || blockedRef.current()) return;
    release(true);
  }, [conflict, waiting, release]);

  // Closing the pane: a waiting save goes through unless a choice is open.
  useEffect(() => () => release(conflictRef.current === null), [release]);

  const handleChange = useCallback(
    (next: string) => {
      setLocalRole(next);
      setStatusHidden(false);
      if (!conflictRef.current) autosave.markChanged(next);
    },
    [autosave, setLocalRole]
  );

  const keepMine = useCallback(() => {
    const answered = conflictRef.current;
    conflictRef.current = null;
    onResolveConflict?.(answered ? { keptOver: answered } : undefined);
    release(true);
    autosave.markChanged(localRoleRef.current);
    void autosave.flush();
  }, [autosave, onResolveConflict, release]);

  const reload = useCallback(() => {
    const saved = conflictRef.current?.remote ?? roleRef.current;
    conflictRef.current = null;
    onResolveConflict?.();
    // The field shows the saved role again; any save of the draft ends unwritten.
    setLocalRole(saved);
    release(false);
    setStatusHidden(true);
  }, [onResolveConflict, release, setLocalRole]);

  return (
    <div
      className={`${styles.roleLine} ${live ? styles.livePulse : ''}`}
      data-live-updated={live || undefined}
    >
      <TextInput
        id={inputId}
        aria-label="Role"
        size="md"
        fullWidth
        value={localRole}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => void autosave.flush()}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        placeholder="Add a role..."
        spellCheck={false}
      />
      {conflict ? (
        <LiveFieldNotice conflict={conflict} onReload={reload} onKeepMine={keepMine} />
      ) : statusHidden ? null : (
        <>
          {autosave.state === 'saving' && (
            <span className={styles.fieldStatus} role="status" aria-live="polite">
              Saving…
            </span>
          )}
          {autosave.state === 'saved' && (
            <span className={styles.fieldStatus} role="status" aria-live="polite">
              Saved
            </span>
          )}
          {autosave.state === 'error' && (
            <span className={styles.fieldStatusError} role="alert">
              {autosave.error ?? 'Save failed'}
              <button
                type="button"
                className={styles.retryBtn}
                onClick={() => {
                  autosave.markChanged(localRole);
                  void autosave.flush();
                }}
              >
                Retry
              </button>
            </span>
          )}
        </>
      )}
    </div>
  );
};
