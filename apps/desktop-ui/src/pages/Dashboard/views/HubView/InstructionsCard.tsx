import { useEffect, useId, useRef, useState, type FC, type KeyboardEvent } from 'react';
import { AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH } from '@snaglet/shared/constants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, Textarea } from '@desktop/components';
import { shortcutHint } from '@desktop/utils/platform';
import { SectionLabel, SectionState } from './HubSection';
import { HubSurface } from './HubSurface';
import type { LoadStatus } from './hubTypes';
import styles from './HubView.module.scss';

/** How long the "Saved" note stays after a save. */
const SAVED_NOTICE_MS = 2500;
const EDITOR_WIDTH = 460;

export interface InstructionsCardProps {
  status: LoadStatus;
  /** The saved text; null until loaded. */
  saved: string | null;
  error: string | null;
  /** Save the text. Rejects with the server's reason. */
  onSave: (value: string) => Promise<void>;
}

interface EditorProps {
  anchor: HTMLElement;
  saved: string;
  onSave: (value: string) => Promise<void>;
  onClose: () => void;
}

/**
 * The editor that opens from the card: the same setting, limit and
 * shortcuts as the Settings pane shown while Home is off. Save (or Cmd/Ctrl+S) saves and stays open;
 * Escape or a press outside closes it without saving.
 */
const InstructionsEditor: FC<EditorProps> = ({ anchor, saved, onSave, onClose }) => {
  const [draft, setDraft] = useState(saved);
  // What is saved as far as this editor knows: the text it opened with,
  // then each text it saved.
  const [baseline, setBaseline] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const labelId = useId();

  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  const dirty = draft !== baseline;

  const save = async () => {
    if (!dirty || saving) return;
    const value = draft;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(value);
      setBaseline(value);
      setJustSaved(true);
    } catch (err) {
      setSaveError(getErrorMessage(err, 'Save failed'));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() === 's' || event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  };

  return (
    <HubSurface
      anchor={anchor}
      label="Edit instructions for all agents"
      onDismiss={onClose}
      width={EDITOR_WIDTH}
      align="end"
    >
      <div className={styles.editor}>
        <p id={labelId} className={styles.label}>
          Instructions for all agents
        </p>
        <p className={styles.editorNote}>Added to every agent’s instructions, in every thread.</p>
        <Textarea
          aria-labelledby={labelId}
          data-autofocus=""
          fullWidth
          rows={10}
          autoGrow
          maxHeight={360}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setJustSaved(false);
          }}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            // Open with the caret after the text, ready to add to it.
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          maxLength={AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH}
          placeholder="For example: Write in plain English. Ask before deleting anything."
        />
        {saveError && (
          <p className={styles.inlineError} role="alert">
            {saveError}
          </p>
        )}
        <div className={styles.editorFooter}>
          <span className={styles.statusText} aria-live="polite">
            {dirty ? 'Unsaved changes' : justSaved ? 'Saved' : ''}
          </span>
          <span className={styles.charCount}>
            {draft.length} / {AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={!dirty}
            loading={saving}
            loadingText="Saving…"
            title={`Save (${shortcutHint('S')})`}
          >
            Save
          </Button>
        </div>
      </div>
    </HubSurface>
  );
};

/**
 * A small card for the instructions for all agents: a few lines of the
 * current text (or a prompt when there is none), its length, and Edit, which
 * opens the editor anchored to the card.
 */
export const InstructionsCard: FC<InstructionsCardProps> = ({ status, saved, error, onSave }) => {
  const labelId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const text = saved ?? '';

  const toggle = (target: HTMLElement) => setAnchor((open) => (open ? null : target));

  return (
    <section ref={cardRef} className={styles.card} aria-labelledby={labelId} tabIndex={-1}>
      <SectionLabel
        id={labelId}
        actions={
          status === 'ready' ? (
            <button
              type="button"
              className={styles.textButton}
              aria-haspopup="dialog"
              aria-expanded={anchor !== null}
              onClick={(event) => toggle(event.currentTarget)}
            >
              Edit
            </button>
          ) : undefined
        }
      >
        Instructions for all agents
      </SectionLabel>
      <SectionState status={status} error={error} loadingText="Loading…" />
      {status === 'ready' && (
        <>
          <button
            type="button"
            className={styles.cardPreview}
            onClick={(event) => toggle(event.currentTarget)}
            aria-label={
              text ? 'Edit instructions for all agents' : 'Write instructions for all agents'
            }
          >
            {text ? (
              <span className={styles.cardText}>{text}</span>
            ) : (
              <span className={styles.cardPrompt}>
                Nothing yet. Write what every agent should know, like how you like answers or what
                to ask before doing.
              </span>
            )}
          </button>
          <p className={styles.cardFooter}>
            <span>Applies to every agent</span>
            <span>
              {text.length} / {AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH}
            </span>
          </p>
        </>
      )}
      {anchor && saved !== null && (
        <InstructionsEditor
          anchor={cardRef.current ?? anchor}
          saved={saved}
          onSave={onSave}
          onClose={() => setAnchor(null)}
        />
      )}
    </section>
  );
};
