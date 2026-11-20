import { useEffect, useId, useState, type KeyboardEventHandler } from 'react';
import type { Editor } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { createFormatTextPlugin, type TextFormat } from '@desktop/utils/formatAsYouType';
import { useTableInputEscape } from './useTableInputEscape';
import styles from './TableFieldEditor.module.scss';

interface Props extends ChipEditableInputProps {
  label?: string;
  error?: string | null;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onEscape?: () => void;
  /** Rewrites the text as the user types or pastes, keeping the caret, e.g. `formatTableName`. */
  format?: TextFormat;
}

/** Shared table form shell; chip editing and drop ownership stay in the app primitive. */
export function TableInput({
  label,
  error,
  className,
  onKeyDown,
  onEscape,
  onEditorReady,
  autoFocus,
  format,
  ...props
}: Props) {
  const errorId = useId();
  const [editor, setEditor] = useState<Editor | null>(null);
  useTableInputEscape(editor, onEscape);

  useEffect(() => {
    if (!format || !editor || editor.isDestroyed) return;
    const key = new PluginKey('table-input-format');
    editor.registerPlugin(createFormatTextPlugin(key, format));
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(key);
    };
  }, [editor, format]);

  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  return (
    <div className={styles.control} onKeyDown={onKeyDown}>
      {label && <span className={styles.label}>{label}</span>}
      <ChipEditableInput
        {...props}
        autoFocus={autoFocus}
        onEditorReady={setEditor}
        ariaLabel={props.ariaLabel ?? label}
        ariaInvalid={!!error}
        ariaDescribedBy={error ? errorId : undefined}
        className={`${styles.chipInput} ${className ?? ''}`}
      />
      {error && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
