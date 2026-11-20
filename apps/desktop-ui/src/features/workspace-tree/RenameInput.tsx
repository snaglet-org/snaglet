import { useEffect, useRef, useState } from 'react';
import { formatFieldValue, type TextFormat } from '@desktop/utils/formatAsYouType';

import styles from './WorkspaceTree.module.scss';

export interface RenameInputProps {
  initialValue: string;
  /**
   * Called once per Enter or blur; the field is then one-shot. Resolving
   * exactly `false` re-arms it — the caller kept the field open (a rejected
   * name, a failed save) — so the next Enter or blur submits again with
   * whatever the user has typed.
   */
  onCommit: (value: string) => void | Promise<boolean | void>;
  onCancel: () => void;
  /** Mirrors every keystroke to the caller, e.g. for live validation. */
  onValueChange?: (value: string) => void;
  /** A save is in flight: the text is read-only until it settles. */
  busy?: boolean;
  /** Id of the caller-rendered error message; set only while one shows. */
  errorId?: string;
  /** Replaces the tree-row field styling, e.g. to match a pane title. */
  className?: string;
  /** Rewrites the text as the user types or pastes, keeping the caret, e.g. `formatTableName`. */
  format?: TextFormat;
}

/**
 * Inline rename field used in place of `.label` while a tree row is being
 * renamed, and in place of the pane top bar's title (`PathHeader`). Enter
 * commits, Escape cancels, blur commits. `committedRef` guards against the
 * Enter → blur double-fire that would otherwise call `onCommit` twice in a
 * row. Mouse-down events are stopPropagation'd so
 * clicks inside the field don't bubble to the row's `onClick` (which
 * would swap the pane) or trigger a drag.
 */
export function RenameInput({
  initialValue,
  onCommit,
  onCancel,
  onValueChange,
  busy = false,
  errorId,
  className = styles.draftInput,
  format,
}: RenameInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const result = onCommit(value);
    if (result instanceof Promise) {
      void result.then((done) => {
        if (done === false) committedRef.current = false;
      });
    }
  };

  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      className={className}
      value={value}
      readOnly={busy}
      aria-busy={busy || undefined}
      aria-invalid={errorId ? true : undefined}
      aria-describedby={errorId}
      onChange={(e) => {
        const next = format ? formatFieldValue(e.target, format) : e.target.value;
        setValue(next);
        onValueChange?.(next);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onDragStart={(e) => e.preventDefault()}
      spellCheck={false}
      aria-label="Rename"
    />
  );
}
