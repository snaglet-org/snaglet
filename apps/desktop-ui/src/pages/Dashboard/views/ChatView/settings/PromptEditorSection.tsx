import type { FC, ReactNode } from 'react';
import {
  WorkspaceEditor,
  EditorSaveHint,
  useEditorSaveStatus,
  type WorkspaceEditorKind,
} from '@desktop/features/rich-markdown/workspace-editor';
import { draftStorageKey } from '@desktop/features/composer';
import { DisclosureSection } from '@desktop/components';
import styles from './ChatSettings.module.scss';

interface PromptEditorSectionProps {
  label: string;
  /** Shown in the collapsed row. */
  summary?: string;
  defaultOpen?: boolean;
  /** Header content after the save status, such as an InfoHint. */
  hint?: ReactNode;
  kind: WorkspaceEditorKind;
  /**
   * One scope per edited prompt, such as `thread-system-prompt:<threadId>`.
   * Names the stored draft and remounts the editor when it changes.
   */
  draftScope: string;
  /** The saved prompt; null while it loads. */
  savedValue: string | null;
  /** Shown in place of the editor when the prompt could not load. */
  loadError?: string | null;
  /** Returns the text the server kept, which becomes the saved baseline. */
  onSave: (next: string) => Promise<string | void>;
  /** Shown above the editor. */
  children?: ReactNode;
}

/**
 * A prompt in thread settings: a collapsible editor with explicit Save
 * (autosave would send half-typed text and adopt the trimmed copy mid-word),
 * its save status beside the label, and the unsaved draft kept per prompt in
 * localStorage.
 */
export const PromptEditorSection: FC<PromptEditorSectionProps> = ({
  label,
  summary,
  defaultOpen,
  hint,
  kind,
  draftScope,
  savedValue,
  loadError,
  onSave,
  children,
}) => {
  const { status, onSaveStateChange } = useEditorSaveStatus();
  return (
    <DisclosureSection
      label={label}
      summary={summary}
      defaultOpen={defaultOpen}
      actions={
        <>
          <EditorSaveHint state={status.state} error={status.error} />
          {hint}
        </>
      }
    >
      {children}
      <div className={styles.editorHost}>
        {savedValue !== null ? (
          <WorkspaceEditor
            key={draftScope}
            kind={kind}
            saveMode="manual"
            draftKey={draftStorageKey(draftScope)}
            savedValue={savedValue}
            onSave={onSave}
            bodyClassName={styles.editorBody}
            onSaveStateChange={onSaveStateChange}
          />
        ) : loadError ? (
          <div className={styles.error} role="alert">
            {loadError}
          </div>
        ) : (
          <div className={styles.editorPlaceholder}>Loading…</div>
        )}
      </div>
    </DisclosureSection>
  );
};
