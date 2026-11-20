/**
 * NameStep — "Set your name" on the Get started pane. A new workspace's user
 * starts as `DEFAULT_USER_NAME`; the step is open, with an empty field, until
 * they save a name of their own, then done with the name and a way to change
 * it again. It saves through the profile Home's greeting reads, so Home shows
 * the new name at once. It never holds up the other steps.
 */
import { useState, type FC, type FormEvent } from 'react';
import { USER_NAME_MAX_LENGTH } from '@snaglet/shared/constants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button } from '@desktop/components/controls/Button/Button';
import { TextInput } from '@desktop/components';
import { nameDraft, nameStepState } from '@desktop/features/onboarding';
import { checkUserName, useUserProfile } from '@desktop/features/user-profile/userProfile';
import { STEP_NUMBERS } from './steps';
import styles from './GetStartedView.module.scss';

export const NameStep: FC = () => {
  const { status, profile, error: loadError, saveName } = useUserProfile();
  const name = profile?.name ?? null;
  const state = nameStepState(name);
  const [editing, setEditing] = useState(false);
  // What the person typed; null until they type, so the field follows the saved name.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? nameDraft(name);

  const close = () => {
    setEditing(false);
    setDraft(null);
    setError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const checked = checkUserName(value);
    if (checked.error !== null) {
      setError(checked.error);
      return;
    }
    if (checked.name === name) {
      close();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveName(checked.name);
      close();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save your name'));
    } finally {
      setSaving(false);
    }
  };

  const shownError = error ?? (status === 'error' ? loadError : null);

  return (
    <section className={styles.step} aria-labelledby="get-started-name" data-state={state}>
      <div className={styles.stepHead}>
        <span className={styles.stepNumber} aria-hidden>
          {STEP_NUMBERS.name}
        </span>
        <h2 id="get-started-name" className={styles.stepTitle}>
          Set your name
        </h2>
        <span className={styles.stepState} data-state={state}>
          {state === 'done' ? `Done · ${name}` : ''}
        </span>
      </div>
      <p className={styles.muted}>Your agents and the workspace call you by this name.</p>

      {state === 'done' && !editing ? (
        <p className={styles.muted}>
          <button type="button" className={styles.link} onClick={() => setEditing(true)}>
            Change your name
          </button>
        </p>
      ) : (
        <form className={styles.actions} onSubmit={(event) => void save(event)}>
          <TextInput
            aria-label="Your name"
            placeholder="Your name"
            value={value}
            maxLength={USER_NAME_MAX_LENGTH}
            disabled={saving}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" variant="primary" size="sm" loading={saving} loadingText="Saving…">
            Save
          </Button>
          {editing && (
            <Button variant="ghost" size="sm" disabled={saving} onClick={close}>
              Cancel
            </Button>
          )}
        </form>
      )}

      {shownError && (
        <p className={styles.error} role="alert">
          {shownError}
        </p>
      )}
    </section>
  );
};
