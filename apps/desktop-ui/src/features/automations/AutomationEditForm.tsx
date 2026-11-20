/**
 * Edit an automation: name, prompt (the composer's chip editor,
 * {@link AutomationPromptField}), timing and the calendar it shows on
 * ({@link AutomationCalendarField}, kept across a timing change), saved through
 * PATCH /api/automations/:id (AutomationService.update), never the generic
 * table writer. Opens as a modal from the Automations grid and the calendar
 * popover, and inline (`inline`) in the Automations pane. Timing controls:
 * {@link AutomationTimingFields}. The Notify section (reminders before each
 * wake) saves as it changes, apart from Save. "Tool calls that ask" is the
 * unattended policy (sent only when changed; people only, the server refuses
 * it from an agent).
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_PROMPT_MAX_LENGTH,
  isUnattendedPolicy,
  type AutomationRecord,
  type UnattendedPolicy,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, Modal, Select, TextInput } from '@desktop/components';
import { UNATTENDED_POLICY_HINT, UNATTENDED_POLICY_OPTIONS } from '@desktop/utils/unattendedPolicy';
import { automationsApi } from '@desktop/utils/api/automations';
import { ReminderSettingsControl } from '@desktop/features/reminders/ReminderSettingsControl';
import { calendarIdForPick } from './automationActions';
import { AutomationCalendarField, useAutomationCalendars } from './AutomationCalendarPicker';
import { AutomationPromptField, promptLength } from './AutomationPromptField';
import { AutomationTimingFields, useAutomationTiming } from './AutomationTimingFields';
import styles from './AutomationEditForm.module.scss';

export interface AutomationEditFormProps {
  automation: AutomationRecord;
  onSaved: (automation: AutomationRecord) => void;
  onClose: () => void;
  /** Render in place (the Automations pane) instead of in a modal. */
  inline?: boolean;
}

export function AutomationEditForm({
  automation: a,
  onSaved,
  onClose,
  inline = false,
}: AutomationEditFormProps) {
  const timing = useAutomationTiming(a.when, a.when.tz);
  const [name, setName] = useState(a.name);
  const [prompt, setPrompt] = useState(a.prompt);
  const { calendars, loaded } = useAutomationCalendars();
  // undefined until picked; null = No calendar; '' = "Default calendar (new)", made on save.
  const [calendarPick, setCalendarPick] = useState<string | null | undefined>(undefined);
  const [unattendedPolicy, setUnattendedPolicy] = useState<UnattendedPolicy>(a.unattendedPolicy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // It keeps its calendar (or none) whatever the timing; sent only when changed.
  const calendarValue = calendarPick !== undefined ? calendarPick : a.calendarId;

  const valid =
    name.trim().length > 0 &&
    name.trim().length <= AUTOMATION_NAME_MAX_LENGTH &&
    promptLength(prompt) > 0 &&
    promptLength(prompt) <= AUTOMATION_PROMPT_MAX_LENGTH &&
    timing.valid;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    const when = timing.dirty ? timing.input() : null;
    try {
      const calendarId = await calendarIdForPick(calendarValue === '' ? undefined : calendarValue);
      const calendarChange = calendarId === a.calendarId ? {} : { calendarId };
      const { automation } = await automationsApi.update(a.id, {
        ...(name.trim() !== a.name ? { name: name.trim() } : {}),
        ...(prompt.trim() !== a.prompt ? { prompt: prompt.trim() } : {}),
        ...(when ? { when } : {}),
        ...calendarChange,
        ...(unattendedPolicy !== a.unattendedPolicy ? { unattendedPolicy } : {}),
      });
      onSaved(automation);
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't save"));
    } finally {
      setSaving(false);
    }
  };

  const fields = (
    <div className={styles.fields}>
      <TextInput
        label="Name"
        value={name}
        maxLength={AUTOMATION_NAME_MAX_LENGTH}
        onChange={(e) => setName(e.target.value)}
        fullWidth
        disabled={saving}
        data-autofocus
        autoFocus={inline}
      />
      <AutomationPromptField
        value={prompt}
        onChange={setPrompt}
        agentName={a.agentName}
        disabled={saving}
      />
      <AutomationTimingFields timing={timing} whenText={a.whenText} />
      <AutomationCalendarField
        value={calendarValue}
        onChange={(pick) => setCalendarPick(pick === undefined ? '' : pick)}
        calendars={calendars}
        loaded={loaded}
        current={a.calendarId ? { id: a.calendarId, title: a.calendarTitle } : null}
        disabled={saving}
      />
      <div className={styles.timing}>
        <label htmlFor={`unattended-policy-${a.id}`} className={styles.label}>
          Tool calls that ask for a person
        </label>
        <Select
          id={`unattended-policy-${a.id}`}
          size="sm"
          value={unattendedPolicy}
          onChange={(e) => {
            if (isUnattendedPolicy(e.target.value)) setUnattendedPolicy(e.target.value);
          }}
          disabled={saving}
          aria-describedby={`unattended-hint-${a.id}`}
        >
          {UNATTENDED_POLICY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <span id={`unattended-hint-${a.id}`} className={styles.hint}>
          {UNATTENDED_POLICY_HINT}
        </span>
      </div>
      {/* Saved as it changes, apart from Save (its own settings, not the automation's).
          A first-open one has no start time to remind before; saving it clears them. */}
      {!(timing.mode === 'repeat' && timing.firstOpen) && (
        <ReminderSettingsControl item={{ kind: 'automation', automationId: a.id }} />
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );

  const buttons: ReactNode = (
    <>
      <Button
        type="button"
        variant="ghost"
        size={inline ? 'sm' : 'md'}
        onClick={onClose}
        disabled={saving}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        variant="primary"
        size={inline ? 'sm' : 'md'}
        disabled={!valid || saving}
      >
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </>
  );

  if (inline) {
    return (
      <form
        onSubmit={(e) => void submit(e)}
        className={styles.inlineForm}
        aria-label={`Edit ${a.name}`}
      >
        {fields}
        <div className={styles.footer}>{buttons}</div>
      </form>
    );
  }

  return (
    <Modal onClose={saving ? () => undefined : onClose} aria-label={`Edit ${a.name}`}>
      <form onSubmit={(e) => void submit(e)} className={styles.form}>
        <Modal.Header>
          <span className={styles.title}>Edit automation</span>
        </Modal.Header>
        <Modal.Body>{fields}</Modal.Body>
        <Modal.Footer>{buttons}</Modal.Footer>
      </form>
    </Modal>
  );
}
