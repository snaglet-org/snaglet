import { useEffect, useId, useRef, useState, type FC, type KeyboardEvent } from 'react';
import { USER_NAME_MAX_LENGTH } from '@snaglet/shared/constants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { EditIcon } from '@desktop/components/Icons';
import { checkUserName } from '@desktop/features/user-profile/userProfile';
import { greeting, shortDate } from './hubModel';
import type { LoadStatus } from './hubTypes';
import styles from './HubView.module.scss';

export interface HubHeaderProps {
  now: Date;
  status: LoadStatus;
  name: string | null;
  error: string | null;
  /** Rename the user. Rejects with the reason the name was refused. */
  onSaveName: (name: string) => Promise<void>;
}

/**
 * Home's greeting, "Good afternoon, Robin", with the name editable in place
 * (click it, type, Enter or leaving the field saves, Escape cancels) and the
 * date beside it. No picture: just the line of text.
 */
export const HubHeader: FC<HubHeaderProps> = ({ now, status, name, error, onSaveName }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nameButtonRef = useRef<HTMLButtonElement | null>(null);
  const errorId = useId();
  // Escape ends editing before the input blurs, so its blur must not save.
  const skipBlurRef = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startEditing = () => {
    if (!name) return;
    setDraft(name);
    setSaveError(null);
    setEditing(true);
  };

  const stopEditing = () => {
    setEditing(false);
    // Hand focus back to the name once it is a button again.
    window.setTimeout(() => nameButtonRef.current?.focus(), 0);
  };

  const commit = async () => {
    if (saving) return;
    const checked = checkUserName(draft);
    if (checked.error !== null || checked.name === name) {
      setSaveError(checked.error);
      if (checked.error === null) stopEditing();
      return;
    }
    setSaving(true);
    try {
      await onSaveName(checked.name);
      setSaveError(null);
      stopEditing();
    } catch (err) {
      setSaveError(getErrorMessage(err, 'Could not save your name'));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      skipBlurRef.current = true;
      setSaveError(null);
      stopEditing();
    }
  };

  return (
    <header className={styles.header}>
      <h1 className={styles.greeting}>
        <span className={styles.greetingLead}>{greeting(now)},</span>{' '}
        {status === 'ready' && name !== null ? (
          editing ? (
            <input
              ref={inputRef}
              className={styles.nameInput}
              value={draft}
              maxLength={USER_NAME_MAX_LENGTH}
              aria-label="Your name"
              aria-invalid={saveError ? true : undefined}
              aria-describedby={saveError ? errorId : undefined}
              disabled={saving}
              size={Math.max(draft.length, 4)}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onBlur={() => {
                if (skipBlurRef.current) {
                  skipBlurRef.current = false;
                  return;
                }
                void commit();
              }}
            />
          ) : (
            <button
              ref={nameButtonRef}
              type="button"
              className={styles.nameButton}
              onClick={startEditing}
              title="Change your name"
              aria-label={`${name}, change your name`}
            >
              <span className={styles.nameText}>{name}</span>
              <span className={styles.nameEditGlyph} aria-hidden>
                <EditIcon />
              </span>
            </button>
          )
        ) : (
          <span className={styles.namePlaceholder}>{status === 'loading' ? '…' : 'there'}</span>
        )}
      </h1>
      <p className={styles.headerDate}>{shortDate(now)}</p>
      {(saveError || (status === 'error' && error)) && (
        <p id={errorId} className={styles.headerError} role="alert">
          {saveError ?? error}
        </p>
      )}
    </header>
  );
};
