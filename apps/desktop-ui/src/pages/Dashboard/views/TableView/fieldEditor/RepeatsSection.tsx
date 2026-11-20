import { Fragment, useId, useState, type FC } from 'react';
import type { TableField, TableFieldRecurrence, TableSelectOption } from '@snaglet/shared/types';
import { Button, Select } from '@desktop/components';
import { statusDefaults, withDoneOption } from './fieldEditorDraft';
import editorStyles from '../TableFieldEditor.module.scss';
import styles from './fieldEditor.module.scss';

interface Props {
  /** The repeat setting shown (draft, else saved); null = the default one. */
  recurrence: TableFieldRecurrence | null;
  /** The table's single selects (status choices); null while loading. */
  statusFields: TableField[] | null;
  disabled?: boolean;
  onChange: (recurrence: TableFieldRecurrence) => void;
}

/** A done or reset id missing from the status field (the server refuses it; pick another). */
const DELETED_OPTION = 'Deleted option';

function orList(labels: string[]): string {
  return labels.length < 2
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/** The plain line under the choices: what marking a row done does. */
function doneExplanation(
  recurrence: TableFieldRecurrence,
  status: TableField | undefined,
  options: readonly TableSelectOption[]
): string | null {
  if (recurrence.statusFieldId === null)
    return 'Tap Done on the row’s date, or Mark done in the calendar, to move it to its next date.';
  if (!status) return null;
  if (options.length === 0) return `${status.name} has no options yet.`;
  const label = (id: string) => options.find((option) => option.id === id)?.label;
  const done = recurrence.doneOptionIds.flatMap((id) => label(id) ?? []);
  if (done.length === 0) return `Choose the ${status.name} value that means done.`;
  const reset = recurrence.resetOptionId ? label(recurrence.resetOptionId) : undefined;
  return `Setting ${status.name} to ${orList(done)} moves the row to its next date and ${
    reset ? `puts ${status.name} back to ${reset}` : `clears ${status.name}`
  }.`;
}

/**
 * How a date field's rows finish a repeat. Every date field can repeat (each
 * row picks how often from its date), so there is no switch: just "Repeat
 * options", closed by default, holding the "When it's done" sentence — Done
 * is [the Done button | a status field set to…], that field's done value(s)
 * and the value it resets to. Picking a status field starts on its last
 * option as done and its first as the reset; options are named by id, so a
 * renamed one still shows.
 */
export const RepeatsSection: FC<Props> = ({
  recurrence: saved,
  statusFields,
  disabled,
  onChange,
}) => {
  const ids = useId();
  const [open, setOpen] = useState(false);
  // A field with no setting yet shows the default one; changing it saves it.
  const recurrence = saved ?? { statusFieldId: null, doneOptionIds: [], resetOptionId: null };
  const status =
    recurrence.statusFieldId !== null
      ? statusFields?.find((f) => f.id === recurrence.statusFieldId)
      : undefined;
  const options = status?.options ?? [];
  const explanation = doneExplanation(recurrence, status, options);

  return (
    <div className={styles.section} role="group" aria-label="Repeats">
      <Button
        size="sm"
        variant="ghost"
        className={styles.moreToggle}
        aria-expanded={open}
        aria-controls={`${ids}-options`}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden>↻ </span>
        Repeat options
      </Button>
      {open && (
        <div id={`${ids}-options`} className={styles.repeatPanel} data-on>
          <>
            <div className={styles.doneCard} role="group" aria-labelledby={`${ids}-done-title`}>
              <span id={`${ids}-done-title`} className={styles.cardLabel}>
                When it’s done
              </span>
              <div className={styles.sentence}>
                <label htmlFor={`${ids}-status`}>Done is</label>
                <Select
                  id={`${ids}-status`}
                  size="sm"
                  className={editorStyles.typeSelect}
                  value={recurrence.statusFieldId ?? ''}
                  disabled={disabled || statusFields === null}
                  aria-describedby={explanation ? `${ids}-explain` : undefined}
                  onChange={(event) => {
                    const picked = statusFields?.find((f) => f.id === event.target.value);
                    onChange(
                      picked
                        ? { ...recurrence, statusFieldId: picked.id, ...statusDefaults(picked) }
                        : {
                            ...recurrence,
                            statusFieldId: null,
                            doneOptionIds: [],
                            resetOptionId: null,
                          }
                    );
                  }}
                >
                  <option value="">the Done button</option>
                  {(statusFields ?? []).map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name} set to…
                    </option>
                  ))}
                  {recurrence.statusFieldId !== null && !status && (
                    <option value={recurrence.statusFieldId}>
                      {statusFields === null ? 'Loading fields…' : 'Unavailable field'}
                    </option>
                  )}
                </Select>
                {status && options.length > 0 && (
                  <DoneChoices
                    ids={ids}
                    recurrence={recurrence}
                    status={status}
                    options={options}
                    disabled={disabled}
                    onChange={onChange}
                  />
                )}
              </div>
              {explanation && (
                <p id={`${ids}-explain`} className={editorStyles.note}>
                  {explanation}
                </p>
              )}
            </div>
          </>
        </div>
      )}
    </div>
  );
};

interface DoneChoicesProps {
  ids: string;
  recurrence: TableFieldRecurrence;
  status: TableField;
  options: readonly TableSelectOption[];
  disabled?: boolean;
  onChange: (recurrence: TableFieldRecurrence) => void;
}

/**
 * "<Status> is [Done]", any further done values ("or [Won't do] ×", added
 * with "+ another" once the field has more than two options), then "Then
 * reset to [To do | None]". A done value is never offered as the reset.
 */
const DoneChoices: FC<DoneChoicesProps> = ({
  ids,
  recurrence,
  status,
  options,
  disabled,
  onChange,
}) => {
  const known = (id: string) => options.some((option) => option.id === id);
  const done = recurrence.doneOptionIds;
  const [first, ...more] = done;
  const reset = recurrence.resetOptionId;
  const addable = options.find((option) => !done.includes(option.id) && option.id !== reset);
  const doneSelect = (index: number, current: string | undefined, label?: string) => (
    <Select
      id={`${ids}-done-${index}`}
      size="sm"
      className={editorStyles.typeSelect}
      aria-label={label}
      value={current ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(withDoneOption(recurrence, options, index, event.target.value))}
    >
      {current === undefined && (
        <option value="" disabled>
          Choose…
        </option>
      )}
      {options
        .filter((option) => option.id === current || !done.includes(option.id))
        .map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      {current !== undefined && !known(current) && (
        <option value={current}>{DELETED_OPTION}</option>
      )}
    </Select>
  );

  return (
    <>
      <label htmlFor={`${ids}-done-0`}>{status.name} is</label>
      {doneSelect(0, first)}
      {more.map((id, at) => {
        const index = at + 1;
        const label = options.find((option) => option.id === id)?.label ?? DELETED_OPTION;
        return (
          <Fragment key={index}>
            <label htmlFor={`${ids}-done-${index}`}>or</label>
            <span className={styles.choice}>
              {doneSelect(index, id, `Or ${status.name} is`)}
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                aria-label={`Remove ${label} from done`}
                disabled={disabled}
                onClick={() =>
                  onChange({ ...recurrence, doneOptionIds: done.filter((_, i) => i !== index) })
                }
              >
                ×
              </Button>
            </span>
          </Fragment>
        );
      })}
      {options.length > 2 && first !== undefined && addable && (
        <Button
          size="sm"
          variant="ghost"
          className={styles.addDone}
          aria-label={`Add another ${status.name} value that means done`}
          disabled={disabled}
          onClick={() => onChange(withDoneOption(recurrence, options, done.length, addable.id))}
        >
          + another
        </Button>
      )}
      <label htmlFor={`${ids}-reset`}>Then reset to</label>
      <Select
        id={`${ids}-reset`}
        size="sm"
        className={editorStyles.typeSelect}
        value={reset ?? ''}
        disabled={disabled}
        onChange={(event) => onChange({ ...recurrence, resetOptionId: event.target.value || null })}
      >
        <option value="">None</option>
        {options
          .filter((option) => !done.includes(option.id))
          .map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        {reset !== null && !known(reset) && <option value={reset}>{DELETED_OPTION}</option>}
      </Select>
    </>
  );
};
